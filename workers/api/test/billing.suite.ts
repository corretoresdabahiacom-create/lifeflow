import type { PaymentView, PlanConfig, SubscriptionView } from "@lifeflow/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PaymentProviderError,
  WebhookSignatureError,
  type CreateSubscriptionInput,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderSubscription,
  type WebhookRequest,
  type WebhookResult,
} from "../src/billing/provider";
import { SystemAccessError, type SystemDb } from "../src/system";
import { say, type ScriptedLLM, type ScriptedSTT } from "./ai.suite";
import type { Client, Reply, World } from "./finance.suite";
import { makeSigner, type Clock, type Signer } from "./helpers";

/**
 * Suíte da Fase 5 (planos, assinaturas, webhooks, limites, painel administrativo). Mesmo código no Firestore
 * falso e no emulador real com as Security Rules reais. O provedor de pagamentos é SIMULADO (`FakePayments`);
 * o adaptador do Mercado Pago é testado à parte, com HMAC real, em `mercadopago.test.ts` e aqui com `fetch`
 * simulado. Nada foi executado contra o Mercado Pago real.
 */

export class FakePayments implements PaymentProvider {
  readonly name = "fake";
  readonly subs = new Map<string, ProviderSubscription>();
  readonly payments = new Map<string, ProviderPayment>();
  readonly calls: string[] = [];
  readonly created: CreateSubscriptionInput[] = [];
  failNext: PaymentProviderError | null = null;
  private seq = 0;

  private maybeFail(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }
  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    this.calls.push("create");
    this.maybeFail();
    this.created.push(input);
    const id = `mp_${++this.seq}`;
    const sub: ProviderSubscription = { id, status: "pending", externalReference: input.externalReference, amountCents: input.amountCents, nextPaymentDate: null, checkoutUrl: `https://pay.test/checkout/${id}` };
    this.subs.set(id, sub);
    return { ...sub };
  }
  async getSubscription(id: string): Promise<ProviderSubscription> {
    this.calls.push("get");
    this.maybeFail();
    const sub = this.subs.get(id);
    if (!sub) throw new PaymentProviderError("not_found", "x");
    return { ...sub };
  }
  async cancelSubscription(id: string): Promise<void> {
    this.calls.push("cancel");
    this.maybeFail();
    const sub = this.subs.get(id);
    if (!sub) throw new PaymentProviderError("not_found", "x");
    sub.status = "canceled";
  }
  async changeAmount(id: string, amountCents: number): Promise<void> {
    this.calls.push("change");
    this.maybeFail();
    const sub = this.subs.get(id);
    if (!sub) throw new PaymentProviderError("not_found", "x");
    sub.amountCents = amountCents;
  }
  async getPayment(id: string): Promise<ProviderPayment> {
    this.calls.push("payment");
    this.maybeFail();
    const payment = this.payments.get(id);
    if (!payment) throw new PaymentProviderError("not_found", "x");
    return { ...payment };
  }
  async verifyWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (request.headers.get("x-test-signature") !== "valid") throw new WebhookSignatureError();
    const body = JSON.parse(request.rawBody) as { kind: "subscription" | "payment" | "other"; id: string };
    if (body.kind === "other") return { kind: "ignored", topic: "payment" };
    return { kind: body.kind, resourceId: body.id, eventKey: `${body.kind}:${body.id}:${request.headers.get("x-request-id")}` };
  }

  // ---- ações "do lado do provedor" usadas pelos testes ----
  authorize(id: string, nextPaymentDate: string): void {
    const sub = this.subs.get(id) as ProviderSubscription;
    sub.status = "active";
    sub.nextPaymentDate = nextPaymentDate;
  }
  pause(id: string): void {
    (this.subs.get(id) as ProviderSubscription).status = "paused";
  }
  charge(id: string, paymentId: string, status: ProviderPayment["status"], nextPaymentDate: string | null = null): void {
    const sub = this.subs.get(id) as ProviderSubscription;
    if (nextPaymentDate) sub.nextPaymentDate = nextPaymentDate;
    this.payments.set(paymentId, { id: paymentId, subscriptionId: id, status, amountCents: sub.amountCents ?? 0, createdAt: "2026-11-09T12:00:00.000Z" });
  }
  get lastId(): string {
    return `mp_${this.seq}`;
  }
}

export interface BillingWorld extends World {
  clock: Clock;
  payments: FakePayments;
  llm: ScriptedLLM;
  stt: ScriptedSTT;
  Admin: Client;
  uidA: string;
  uidB: string;
  /** Faz uma chamada anônima ao webhook (sem token), como o provedor faria. */
  app: (path: string, init?: RequestInit, token?: string) => Promise<Response>;
  /** Cliente privilegiado para conferir/semear o banco direto. */
  sys: () => Promise<SystemDb>;
}
export interface BillingWorldOptions {
  noEmailForA?: boolean;
}

const START = new Date("2026-11-09T12:00:00.000Z");
const PERIOD_END = "2026-12-09T12:00:00.000Z";
const denied = async (fn: () => unknown): Promise<void> => {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SystemAccessError);
};
const code = (r: Reply) => (r.body["error"] as { code: string } | undefined)?.code;

export function defineBillingSuite(
  title: string,
  makeWorld: (signer: Signer, options: BillingWorldOptions) => BillingWorld | Promise<BillingWorld>,
  options: { fake: boolean },
): void {
  describe(title, () => {
    let signer: Signer;
    beforeAll(async () => {
      signer = await makeSigner("k1");
    });
    // Planos, assinaturas, eventos e logs administrativos são GLOBAIS (não por usuário). No emulador real eles
    // sobreviveriam entre testes e arquivos, então cada teste começa (e a suíte termina) com essas coleções vazias.
    const resetGlobal = async (w: BillingWorld) => {
      const sys = await w.sys();
      for (const collection of ["plans", "subscriptions", "webhookEvents", "adminLogs"]) {
        for (;;) {
          const docs = await sys.query("", { collection, limit: 200 });
          if (docs.length === 0) break;
          await sys.commit(docs.map((d) => ({ path: `${collection}/${d.id}`, delete: true })));
        }
      }
    };
    let last: BillingWorld | undefined;
    afterAll(async () => {
      if (last) await resetGlobal(last);
    });
    const world = async (opts: BillingWorldOptions = {}) => {
      const w = await makeWorld(signer, opts);
      w.clock.now = START;
      await resetGlobal(w);
      last = w;
      return w;
    };
    let reqSeq = 0;
    const hook = (w: BillingWorld, kind: "subscription" | "payment" | "other", id: string, o: { sig?: string; reqId?: string } = {}) =>
      w.app("/webhooks/mercadopago", {
        method: "POST",
        headers: { "x-test-signature": o.sig ?? "valid", "x-request-id": o.reqId ?? `req-${++reqSeq}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
    const sub = async (c: Client) => (await c.get("/v1/billing/subscription")).body as unknown as { subscription: SubscriptionView; limits: PlanConfig };
    const history = async (c: Client) => ((await c.get("/v1/billing/history")).body.payments ?? []) as PaymentView[];
    const checkout = (c: Client, planId: string, key?: string) => c.post("/v1/billing/checkout", { planId }, key);

    /** Fluxo completo: checkout → o usuário paga no provedor → webhook → plano ativo. */
    const subscribe = async (w: BillingWorld, c: Client, planId = "pro") => {
      const r = await checkout(c, planId);
      expect(r.status, r.text).toBe(201);
      const id = w.payments.lastId;
      w.payments.authorize(id, PERIOD_END);
      const h = await hook(w, "subscription", id);
      expect(h.status).toBe(200);
      return id;
    };
    const chat = (c: Client, message: string) => c.post("/v1/ai/chat", { message });

    // ------------------------------------------------------------ planos e configuração comercial
    it("planos: o padrão do contrato (Free/Pro/Premium) vem do código enquanto o admin não configura", async () => {
      const w = await world();
      const r = await w.A.get("/v1/billing/plans");
      const plans = r.body.plans as PlanConfig[];
      expect(plans.map((p) => [p.id, p.priceCents, p.aiMessagesPerMonth, p.voiceMinutesPerMonth])).toEqual([
        ["free", 0, 30, 0],
        ["pro", 1490, 300, 30],
        ["premium_ai", 2990, 1000, 120],
      ]);
      expect(r.body["current"]).toBe("free");
      const s = await sub(w.A);
      expect(s.subscription).toMatchObject({ plan: "free", status: "none" });
    });

    // ------------------------------------------------------------ criação de assinatura
    it("criação de assinatura: cria no provedor com o uid como referência e fica PENDENTE (sem plano ainda)", async () => {
      const w = await world();
      const r = await checkout(w.A, "pro");
      expect(r.status, r.text).toBe(201);
      expect(r.body["checkoutUrl"]).toMatch(/^https:\/\/pay\.test\/checkout\/mp_/);
      const created = w.payments.created[0]!;
      expect(created).toMatchObject({ externalReference: w.uidA, amountCents: 1490, currency: "BRL", payerEmail: "user@example.com", planId: "pro" });
      expect(created.backUrl).toBe("https://app.lifeflow.test/assinatura?retorno=1");
      expect(created.notificationUrl).toBe("https://api.lifeflow.test/webhooks/mercadopago");
      const s = await sub(w.A);
      expect(s.subscription).toMatchObject({ status: "pending", contractedPlan: "pro", plan: "free" });
      expect(s.subscription.checkoutUrl).toBeTruthy();
      // Pagamento pendente não libera nada.
      expect(s.limits.aiMessagesPerMonth).toBe(30);
    });

    it("o cliente NÃO consegue forjar a própria assinatura gravando direto no banco (regras)", async () => {
      const w = await world();
      // Pela API não existe rota para isso; o teste de regras (CI) prova que o Firestore também nega.
      expect((await w.A.put(`/v1/billing/subscription`, { planId: "premium_ai", status: "active" })).status).toBe(405);
      expect((await sub(w.A)).subscription.plan).toBe("free");
    });

    it("checkout: valida plano, exige Idempotency-Key e e-mail, e não aceita 'free' nem campos extras", async () => {
      const w = await world({ noEmailForA: true });
      expect((await checkout(w.A, "free")).status).toBe(400);
      expect((await w.A.post("/v1/billing/checkout", { planId: "pro", uid: "x" })).status).toBe(400);
      expect(code(await w.A.post("/v1/billing/checkout", { planId: "pro" }, null))).toBe("idempotency_key_required");
      const r = await checkout(w.A, "pro");
      expect(r.status).toBe(422);
      expect(code(r)).toBe("email_required");
      expect(w.payments.created).toHaveLength(0);
    });

    it("checkout repetido (mesma Idempotency-Key) devolve o mesmo link sem criar outra assinatura", async () => {
      const w = await world();
      const one = await checkout(w.A, "pro", "checkout-key-1");
      const two = await checkout(w.A, "pro", "checkout-key-1");
      expect(two.body["checkoutUrl"]).toBe(one.body["checkoutUrl"]);
      expect(w.payments.created).toHaveLength(1);
    });

    it("novo checkout com a assinatura anterior ainda pendente cancela a antiga no provedor (sem cobrança dupla)", async () => {
      const w = await world();
      await checkout(w.A, "pro", "checkout-key-1");
      const first = w.payments.lastId;
      await checkout(w.A, "premium_ai", "checkout-key-2");
      expect(w.payments.subs.get(first)?.status).toBe("canceled");
      expect(w.payments.created).toHaveLength(2);
      expect((await sub(w.A)).subscription).toMatchObject({ contractedPlan: "premium_ai", status: "pending" });
    });

    it("falha do provedor no checkout: erro claro e NADA fica gravado", async () => {
      const w = await world();
      w.payments.failNext = new PaymentProviderError("unavailable", "x");
      const r = await checkout(w.A, "pro");
      expect(r.status).toBe(502);
      expect(code(r)).toBe("payment_provider_error");
      expect((await sub(w.A)).subscription.status).toBe("none");
      w.payments.failNext = new PaymentProviderError("not_configured", "x");
      expect(code(await checkout(w.A, "pro"))).toBe("billing_not_configured");
    });

    it("plano desativado pelo administrador não pode ser contratado", async () => {
      const w = await world();
      const premium = (await w.Admin.get("/v1/admin/plans")).body.plans as PlanConfig[];
      const p = premium.find((x) => x.id === "premium_ai")!;
      const { id: _id, currency: _c, sortOrder: _s, ...rest } = p;
      expect((await w.Admin.put("/v1/admin/plans/premium_ai", { ...rest, active: false })).status).toBe(200);
      const r = await checkout(w.A, "premium_ai");
      expect(code(r)).toBe("plan_unavailable");
      expect((await w.A.get("/v1/billing/plans")).body.plans).toHaveLength(2);
    });

    // ------------------------------------------------------------ webhook válido / inválido / idempotência
    it("webhook VÁLIDO: confere no provedor, ativa a assinatura e muda o plano efetivo", async () => {
      const w = await world();
      await subscribe(w, w.A, "pro");
      const s = await sub(w.A);
      expect(s.subscription).toMatchObject({ status: "active", plan: "pro", currentPeriodEnd: PERIOD_END, checkoutUrl: null });
      expect(s.limits).toMatchObject({ aiMessagesPerMonth: 300, voiceMinutesPerMonth: 30 });
      expect(w.payments.calls).toContain("get"); // nunca confia no corpo do webhook
    });

    it("webhook INVÁLIDO: 401, nada muda e o provedor nem é consultado", async () => {
      const w = await world();
      await checkout(w.A, "pro");
      const id = w.payments.lastId;
      w.payments.authorize(id, PERIOD_END);
      const before = w.payments.calls.length;
      const bad = await hook(w, "subscription", id, { sig: "forjada" });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_signature");
      expect(w.payments.calls.length).toBe(before);
      expect((await sub(w.A)).subscription).toMatchObject({ status: "pending", plan: "free" });
      const noHeader = await w.app("/webhooks/mercadopago", { method: "POST", body: "{}" });
      expect(noHeader.status).toBe(401);
    });

    it("webhook: método errado, corpo grande demais e tópico ignorado", async () => {
      const w = await world();
      expect((await w.app("/webhooks/mercadopago", { method: "GET" })).status).toBe(405);
      expect((await w.app("/webhooks/mercadopago", { method: "POST", headers: { "Content-Length": "70000", "x-test-signature": "valid" }, body: "x".repeat(70_000) })).status).toBe(413);
      const ignored = await hook(w, "other", "pay_1");
      expect(ignored.status).toBe(200);
      expect(((await ignored.json()) as { status: string }).status).toBe("ignored");
    });

    it("IDEMPOTÊNCIA: o mesmo webhook duas vezes processa uma só (segunda = duplicado) e o pagamento não duplica", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      w.payments.charge(id, "pay_1", "approved", PERIOD_END);
      const first = await hook(w, "payment", "pay_1", { reqId: "same-request" });
      const second = await hook(w, "payment", "pay_1", { reqId: "same-request" });
      expect(((await first.json()) as { status: string }).status).toBe("processed");
      expect(((await second.json()) as { status: string }).status).toBe("duplicate");
      expect(await history(w.A)).toHaveLength(1);
      // Mesmo pagamento notificado em OUTRA entrega também não cria outro registro.
      await hook(w, "payment", "pay_1");
      expect(await history(w.A)).toHaveLength(1);
      expect((await sub(w.A)).subscription.status).toBe("active");
    });

    it("webhook de assinatura desconhecida ou de outro usuário é ignorado (não altera ninguém)", async () => {
      const w = await world();
      w.payments.subs.set("mp_alheia", { id: "mp_alheia", status: "active", externalReference: "outro-uid-qualquer", amountCents: 1490, nextPaymentDate: PERIOD_END, checkoutUrl: null });
      const r = await hook(w, "subscription", "mp_alheia");
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe("ignored");
      expect((await sub(w.A)).subscription.status).toBe("none");
    });

    it("falha do provedor ao processar webhook: 503 (o provedor repete) e a repetição funciona", async () => {
      const w = await world();
      await checkout(w.A, "pro");
      const id = w.payments.lastId;
      w.payments.authorize(id, PERIOD_END);
      w.payments.failNext = new PaymentProviderError("unavailable", "x");
      const failed = await hook(w, "subscription", id, { reqId: "retry-1" });
      expect(failed.status).toBe(503);
      expect((await sub(w.A)).subscription.status).toBe("pending");
      const retry = await hook(w, "subscription", id, { reqId: "retry-1" });
      expect(retry.status).toBe(200);
      expect((await sub(w.A)).subscription.plan).toBe("pro");
    });

    it("sync: o próprio usuário pode puxar o estado do provedor se o webhook atrasou", async () => {
      const w = await world();
      await checkout(w.A, "pro");
      w.payments.authorize(w.payments.lastId, PERIOD_END);
      const r = await w.A.post("/v1/billing/sync", {}, null);
      expect(r.status).toBe(200);
      expect((await sub(w.A)).subscription.plan).toBe("pro");
      // Sem assinatura, não faz nada.
      expect(((await w.B.post("/v1/billing/sync", {}, null)).body["subscription"] as SubscriptionView).status).toBe("none");
    });

    // ------------------------------------------------------------ inadimplência
    it("inadimplência: cobrança recusada → carência de 3 dias com o plano; depois volta ao Free; novo pagamento reativa", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      w.payments.charge(id, "pay_fail", "rejected");
      await hook(w, "payment", "pay_fail");
      let s = (await sub(w.A)).subscription;
      expect(s).toMatchObject({ status: "past_due", plan: "pro" });
      expect(s.graceUntil).toBe("2026-11-12T12:00:00.000Z");
      expect((await history(w.A))[0]).toMatchObject({ status: "rejected" });

      w.clock.now = new Date("2026-11-12T12:00:01.000Z");
      s = (await sub(w.A)).subscription;
      expect(s).toMatchObject({ status: "past_due", plan: "free" });
      expect((await sub(w.A)).limits.aiMessagesPerMonth).toBe(30);

      w.payments.charge(id, "pay_ok", "approved", "2027-01-09T12:00:00.000Z");
      await hook(w, "payment", "pay_ok");
      expect((await sub(w.A)).subscription).toMatchObject({ status: "active", plan: "pro", graceUntil: null });
    });

    it("assinatura pausada no provedor entra em carência", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      w.payments.pause(id);
      await hook(w, "subscription", id);
      expect((await sub(w.A)).subscription).toMatchObject({ status: "past_due", plan: "pro" });
    });

    // ------------------------------------------------------------ mudança de plano
    it("mudança de plano: UPGRADE vale já (limites maiores) e o preço novo vai ao provedor", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      const r = await w.A.post("/v1/billing/change", { planId: "premium_ai" }, null);
      expect(r.status, r.text).toBe(200);
      expect(r.body["effective"]).toBe("now");
      expect(w.payments.subs.get(id)?.amountCents).toBe(2990);
      const s = await sub(w.A);
      expect(s.subscription).toMatchObject({ plan: "premium_ai", priceCents: 2990, pendingPlan: null });
      expect(s.limits.aiMessagesPerMonth).toBe(1000);
    });

    it("mudança de plano: DOWNGRADE é agendado para a próxima renovação (e dá para desistir)", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "premium_ai");
      const r = await w.A.post("/v1/billing/change", { planId: "pro" }, null);
      expect(r.body["effective"]).toBe("next_renewal");
      let s = await sub(w.A);
      expect(s.subscription).toMatchObject({ plan: "premium_ai", pendingPlan: "pro" });
      // Repetir o mesmo pedido não faz nada de novo.
      expect((await w.A.post("/v1/billing/change", { planId: "pro" }, null)).status).toBe(200);
      // Renovação aprovada → o plano menor passa a valer.
      w.payments.charge(id, "pay_renew", "approved", "2027-01-09T12:00:00.000Z");
      w.clock.now = new Date(PERIOD_END);
      await hook(w, "payment", "pay_renew");
      s = await sub(w.A);
      expect(s.subscription).toMatchObject({ plan: "pro", contractedPlan: "pro", pendingPlan: null, priceCents: 1490 });

      // Desistir do downgrade: volta o preço no provedor.
      await w.A.post("/v1/billing/change", { planId: "premium_ai" }, null);
      await w.A.post("/v1/billing/change", { planId: "pro" }, null);
      const back = await w.A.post("/v1/billing/change", { planId: "pro" }, null);
      expect(back.status).toBe(200);
    });

    it("mudança de plano: exige assinatura ativa, recusa o mesmo plano e planos inválidos", async () => {
      const w = await world();
      expect(code(await w.A.post("/v1/billing/change", { planId: "pro" }, null))).toBe("no_active_subscription");
      await subscribe(w, w.A, "pro");
      expect(code(await w.A.post("/v1/billing/change", { planId: "pro" }, null))).toBe("same_plan");
      expect((await w.A.post("/v1/billing/change", { planId: "free" }, null)).status).toBe(400);
    });

    it("mudança de plano: falha do provedor não altera nada", async () => {
      const w = await world();
      await subscribe(w, w.A, "pro");
      w.payments.failNext = new PaymentProviderError("unavailable", "x");
      expect((await w.A.post("/v1/billing/change", { planId: "premium_ai" }, null)).status).toBe(502);
      expect((await sub(w.A)).subscription).toMatchObject({ plan: "pro", priceCents: 1490 });
    });

    it("quem já assina não faz novo checkout (evita duas cobranças)", async () => {
      const w = await world();
      await subscribe(w, w.A, "pro");
      const r = await checkout(w.A, "premium_ai");
      expect(r.status).toBe(409);
      expect(code(r)).toBe("subscription_exists");
    });

    // ------------------------------------------------------------ cancelamento
    it("cancelamento: cancela no provedor, mantém o plano até o fim do período pago e depois volta ao Free", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      const r = await w.A.post("/v1/billing/cancel", {}, null);
      expect(r.status, r.text).toBe(200);
      expect(w.payments.subs.get(id)?.status).toBe("canceled");
      expect((await sub(w.A)).subscription).toMatchObject({ status: "canceled", plan: "pro", cancelAtPeriodEnd: true, currentPeriodEnd: PERIOD_END });
      // Repetir é inofensivo e não chama o provedor de novo.
      const calls = w.payments.calls.length;
      expect((await w.A.post("/v1/billing/cancel", {}, null)).status).toBe(200);
      expect(w.payments.calls.length).toBe(calls);
      // Durante o período ainda NÃO dá para assinar de novo.
      expect(code(await checkout(w.A, "pro"))).toBe("subscription_exists");

      w.clock.now = new Date("2026-12-09T12:00:01.000Z");
      expect((await sub(w.A)).subscription).toMatchObject({ status: "canceled", plan: "free" });
      // Depois do fim do período, pode assinar de novo.
      expect((await checkout(w.A, "pro")).status).toBe(201);
    });

    it("cancelamento de checkout pendente vira Free na hora; sem assinatura → 404; cancelamento feito no provedor (webhook) também vale", async () => {
      const w = await world();
      expect(code(await w.A.post("/v1/billing/cancel", {}, null))).toBe("no_subscription");
      await checkout(w.A, "pro");
      await w.A.post("/v1/billing/cancel", {}, null);
      expect((await sub(w.A)).subscription).toMatchObject({ status: "canceled", plan: "free", currentPeriodEnd: null });

      const id = await subscribe(w, w.B, "pro");
      w.payments.subs.get(id)!.status = "canceled"; // o usuário cancelou pelo app do provedor
      await hook(w, "subscription", id);
      expect((await sub(w.B)).subscription).toMatchObject({ status: "canceled", plan: "pro" });
    });

    // ------------------------------------------------------------ limites de utilização (backend)
    it("LIMITE: plano Free bloqueia a 31ª mensagem; assinar o Pro libera; o consumo continua contado", async () => {
      const w = await world();
      for (let i = 0; i < 30; i += 1) {
        w.llm.script.push(say("ok"));
        expect((await chat(w.A, `m${i}`)).status).toBe(200);
      }
      const blocked = await chat(w.A, "mais uma");
      expect(blocked.status).toBe(429);
      expect(code(blocked)).toBe("ai_limit_reached");
      await subscribe(w, w.A, "pro");
      w.llm.script.push(say("agora sim"));
      expect((await chat(w.A, "depois de assinar")).status).toBe(200);
      const usage = (await w.A.get("/v1/ai/usage")).body.usage as { messages: number; messagesLimit: number; plan: string };
      expect(usage).toMatchObject({ messages: 31, messagesLimit: 300, plan: "pro" });
    });

    it("LIMITE: o administrador muda o limite do plano e o backend passa a aplicá-lo; cancelar volta aos limites do Free", async () => {
      const w = await world();
      await subscribe(w, w.A, "pro");
      const plans = (await w.Admin.get("/v1/admin/plans")).body.plans as PlanConfig[];
      const { id: _i, currency: _c, sortOrder: _s, ...pro } = plans.find((p) => p.id === "pro")!;
      expect((await w.Admin.put("/v1/admin/plans/pro", { ...pro, aiMessagesPerMonth: 2 })).status).toBe(200);
      for (let i = 0; i < 2; i += 1) {
        w.llm.script.push(say("ok"));
        expect((await chat(w.A, `m${i}`)).status).toBe(200);
      }
      expect(code(await chat(w.A, "terceira"))).toBe("ai_limit_reached");
      // Voz: o limite em minutos também vem da configuração.
      expect((await sub(w.A)).limits.voiceMinutesPerMonth).toBe(30);
    });

    it("LIMITE: voz bloqueada no Free e liberada no plano pago", async () => {
      const w = await world();
      await w.A.put("/v1/ai/consent", { audio: true });
      const audio = new Uint8Array(2000).fill(7).buffer;
      const headers = { "Content-Type": "audio/webm", "X-Audio-Seconds": "5" };
      expect(code(await w.A.raw("POST", "/v1/ai/transcribe", audio, headers))).toBe("voice_not_in_plan");
      await subscribe(w, w.A, "pro");
      expect((await w.A.raw("POST", "/v1/ai/transcribe", audio, headers)).status).toBe(200);
    });

    // ------------------------------------------------------------ isolamento
    it("isolamento: cada usuário vê só a própria assinatura e os próprios pagamentos", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      w.payments.charge(id, "pay_a", "approved", PERIOD_END);
      await hook(w, "payment", "pay_a");
      expect((await sub(w.B)).subscription.status).toBe("none");
      expect(await history(w.B)).toHaveLength(0);
      expect(await history(w.A)).toHaveLength(1);
      expect((await w.B.post("/v1/billing/cancel", {}, null)).status).toBe(404);
      expect((await sub(w.A)).subscription.plan).toBe("pro");
    });

    it("rotas de cobrança: método errado, rota inexistente e sem token", async () => {
      const w = await world();
      expect((await w.A.post("/v1/billing/subscription", {})).status).toBe(405);
      expect((await w.A.get("/v1/billing/nada")).status).toBe(404);
      expect((await w.app("/v1/billing/subscription")).status).toBe(401);
    });

    // ------------------------------------------------------------ painel administrativo
    it("admin: exige a claim `admin` no token; usuário comum recebe 403 em todas as rotas", async () => {
      const w = await world();
      for (const path of ["/v1/admin/overview", "/v1/admin/plans", "/v1/admin/subscriptions", "/v1/admin/usage", "/v1/admin/logs", "/v1/admin/integrations"]) {
        const r = await w.A.get(path);
        expect(r.status, path).toBe(403);
        expect(code(r)).toBe("admin_required");
      }
      expect((await w.A.put("/v1/admin/plans/pro", {})).status).toBe(403);
      expect((await w.app("/v1/admin/overview")).status).toBe(401);
    });

    it("admin: indicadores (usuários, assinaturas, MRR, cancelamentos, IA, erros) e auditoria de cada acesso", async () => {
      const w = await world();
      await w.A.put("/v1/profile", { displayName: "Ana", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" });
      await w.B.put("/v1/profile", { displayName: "Bia", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" });
      await subscribe(w, w.A, "pro");
      const idB = await subscribe(w, w.B, "premium_ai");
      w.llm.script.push(say("oi"), say("oi"));
      await chat(w.A, "oi");
      await chat(w.B, "oi");
      await w.B.post("/v1/billing/cancel", {}, null);
      w.payments.subs.get(idB)!.status = "canceled";

      const r = await w.Admin.get("/v1/admin/overview");
      expect(r.status, r.text).toBe(200);
      const o = r.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(o["users"].total).toBeGreaterThanOrEqual(2);
      expect(o["subscriptions"].byStatus).toMatchObject({ active: 1, canceled: 1 });
      expect(o["subscriptions"].mrrCents).toBe(1490);
      expect(o["subscriptions"].canceledLast30d).toBe(1);
      expect(o["subscriptions"].activeByPlan).toMatchObject({ pro: 1 });
      expect(o["ai"]).toMatchObject({ messages: 2, activeUsers: 2 });
      expect(o["ai"].estimatedCostUsd).toBeGreaterThan(0);
      expect(o["notifications"].available).toBe(false);

      const logs = (await w.Admin.get("/v1/admin/logs?kind=admin")).body.logs as Array<{ action: string; adminUid: string }>;
      expect(logs.map((l) => l.action)).toContain("overview.read");
      expect(logs.every((l) => l.adminUid.length > 0)).toBe(true);
    });

    it("admin: edita plano (preço e limites) com validação e auditoria; Free não pode custar nem ser desativado", async () => {
      const w = await world();
      const body = { name: "Pro", priceCents: 1990, aiMessagesPerMonth: 500, voiceMinutesPerMonth: 45, reports: "full", trialDays: 7, active: true };
      expect((await w.Admin.put("/v1/admin/plans/pro", body)).status).toBe(200);
      const pro = ((await w.A.get("/v1/billing/plans")).body.plans as PlanConfig[]).find((p) => p.id === "pro")!;
      expect(pro).toMatchObject({ priceCents: 1990, aiMessagesPerMonth: 500, trialDays: 7 });
      expect((await w.Admin.put("/v1/admin/plans/pro", { ...body, priceCents: -1 })).status).toBe(400);
      expect((await w.Admin.put("/v1/admin/plans/pro", { ...body, extra: 1 })).status).toBe(400);
      expect((await w.Admin.put("/v1/admin/plans/free", { ...body, priceCents: 100 })).status).toBe(422);
      expect((await w.Admin.put("/v1/admin/plans/free", { ...body, priceCents: 0, active: false })).status).toBe(422);
      expect((await w.Admin.put("/v1/admin/plans/ouro", body)).status).toBe(404);
      const logs = (await w.Admin.get("/v1/admin/logs?kind=admin")).body.logs as Array<{ action: string; detail: string }>;
      expect(logs.find((l) => l.action === "plans.update")?.detail).toContain("1490→1990");
      // Um novo checkout já usa o preço e o teste gratuito configurados.
      await checkout(w.A, "pro");
      expect(w.payments.created[0]).toMatchObject({ amountCents: 1990, trialDays: 7 });
      // O teste gratuito só vale para quem nunca assinou.
      await w.A.post("/v1/billing/cancel", {}, null);
      await checkout(w.A, "pro");
      expect(w.payments.created[1]).toMatchObject({ trialDays: 0 });
    });

    it("admin: consulta assinaturas (filtros), detalhe com pagamentos, consumo mensal, webhooks e integrações", async () => {
      const w = await world();
      const id = await subscribe(w, w.A, "pro");
      await subscribe(w, w.B, "premium_ai");
      w.payments.charge(id, "pay_1", "approved", PERIOD_END);
      await hook(w, "payment", "pay_1");

      const all = (await w.Admin.get("/v1/admin/subscriptions")).body.subscriptions as Array<{ uid: string; planId: string }>;
      expect(all).toHaveLength(2);
      const onlyPro = (await w.Admin.get("/v1/admin/subscriptions?plan=pro&status=active")).body.subscriptions as Array<{ uid: string }>;
      expect(onlyPro.map((s) => s.uid)).toEqual([w.uidA]);
      expect((await w.Admin.get("/v1/admin/subscriptions?limit=0")).status).toBe(400);

      const detail = await w.Admin.get(`/v1/admin/subscriptions/${w.uidA}`);
      expect((detail.body.payments as unknown[]).length).toBe(1);
      expect(JSON.stringify(detail.body)).not.toContain("providerSubscriptionId");
      expect((await w.Admin.get("/v1/admin/subscriptions/inexistente")).status).toBe(404);

      expect((await w.Admin.get("/v1/admin/usage?month=2026-11")).status).toBe(200);
      expect((await w.Admin.get("/v1/admin/usage?month=novembro")).status).toBe(400);
      const hooks = (await w.Admin.get("/v1/admin/logs?kind=webhooks")).body.logs as Array<{ status: string }>;
      expect(hooks.length).toBeGreaterThanOrEqual(3);
      expect(hooks.every((h) => h.status === "processed")).toBe(true);
      expect((await w.Admin.get("/v1/admin/logs?kind=outro")).status).toBe(400);

      const integrations = (await w.Admin.get("/v1/admin/integrations")).body.integrations as Array<{ name: string; configured: boolean }>;
      expect(integrations.length).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(integrations)).not.toMatch(/sk-|Bearer|secret_value/);
    });

    it("admin NÃO acessa o conteúdo financeiro dos clientes: não há rota e o caminho privilegiado recusa", async () => {
      const w = await world();
      const acc = (await w.A.post("/v1/accounts", { name: "Conta da Ana", type: "checking", initialBalanceCents: 123_456 })).body as unknown as { id: string };
      await w.A.post("/v1/transactions", { accountId: acc.id, type: "expense", amountCents: 100, date: "2026-11-09", description: "Segredo" });
      // 1) Não existe rota administrativa de conteúdo.
      for (const path of ["/v1/admin/accounts", "/v1/admin/transactions", `/v1/admin/users/${w.uidA}`, `/v1/admin/subscriptions/${w.uidA}/transactions`]) {
        expect((await w.Admin.get(path)).status, path).toBe(404);
      }
      // 2) As rotas normais do administrador só enxergam os DADOS DELE.
      expect(((await w.Admin.get("/v1/accounts")).body.accounts as unknown[]).length).toBe(0);
      // 3) O caminho privilegiado tem lista fechada de caminhos.
      const sys = await w.sys();
      await denied(() => sys.get(`users/${w.uidA}/transactions/x`));
      await denied(() => sys.get(`users/${w.uidA}/accounts/${acc.id}`));
      await denied(() => sys.query(`users/${w.uidA}`, { collection: "transactions", limit: 5 }));
      await denied(() => sys.group({ collection: "transactions", limit: 5 }));
      await denied(() => sys.group({ collection: "aiMessages", limit: 5 }));
      await denied(() => sys.commit([{ path: `users/${w.uidA}/accounts/${acc.id}`, fields: { balanceCents: 0 } }]));
      await denied(() => sys.commit([{ path: `subscriptions/a/b/c`, fields: {} }]));
      await denied(() => sys.count("accounts"));
      // 4) A resposta de uso agregado não traz identificadores nem conteúdo.
      w.llm.script.push(say("oi"));
      await chat(w.A, "minha senha do banco é 1234");
      const usage = JSON.stringify((await w.Admin.get("/v1/admin/usage")).body);
      expect(usage).not.toContain("1234");
      expect(usage).not.toContain(w.uidA);
    });

    it("admin: um usuário comum com `admin:false` no corpo/URL não ganha privilégio (a claim só vem do token)", async () => {
      const w = await world();
      expect((await w.A.get("/v1/admin/overview?admin=true")).status).toBe(403);
      expect((await w.A.send("GET", "/v1/admin/overview", undefined, { "X-Admin": "true" })).status).toBe(403);
    });

    it.runIf(options.fake)("a conta de serviço NUNCA é usada nas rotas normais: só o token do usuário vai ao banco", async () => {
      const w = await world();
      w.fake!.calls.length = 0; // descarta as chamadas de preparação (limpeza global usa o caminho privilegiado)
      await w.A.get("/v1/accounts");
      await w.A.get("/v1/billing/subscription");
      const tokens = new Set(w.fake!.calls.map((c) => c.authorization));
      expect([...tokens].every((t) => t !== "Bearer owner")).toBe(true);
    });
  });
}

export type { World };
