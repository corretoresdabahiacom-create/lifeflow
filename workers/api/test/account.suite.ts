import { beforeAll, describe, expect, it } from "vitest";
import { PaymentProviderError } from "../src/billing/provider";
import type { FirestoreClient } from "../src/firestore";
import { SystemAccessError, UserErasure } from "../src/system";
import { say } from "./ai.suite";
import type { BillingWorld } from "./billing.suite";
import type { Client, Reply } from "./finance.suite";
import { env, makeSigner, signToken, validPrefs, type Signer } from "./helpers";

/**
 * Fase 6 — exportação completa dos dados e exclusão de conta (LGPD). Mesma suíte no Firestore falso e no
 * emulador real (com as Security Rules reais). O provedor de pagamentos é simulado.
 */

const PERIOD_END = "2026-12-09T12:00:00.000Z";
const CONFIRM = { confirm: "EXCLUIR MINHA CONTA" };
const code = (r: Reply) => (r.body["error"] as { code: string } | undefined)?.code;

export function defineAccountSuite(
  title: string,
  makeWorld: (signer: Signer, options: { noEmailForA?: boolean }) => BillingWorld | Promise<BillingWorld>,
  options: { rawClient: (w: BillingWorld) => FirestoreClient },
): void {
  describe(title, () => {
    let signer: Signer;
    beforeAll(async () => {
      signer = await makeSigner("k1");
    });
    const world = async () => {
      const w = await makeWorld(signer, {});
      w.clock.now = new Date("2026-11-09T12:00:00.000Z");
      return w;
    };
    let seq = 0;
    const hook = (w: BillingWorld, kind: "subscription" | "payment", id: string) =>
      w.app("/webhooks/mercadopago", {
        method: "POST",
        headers: { "x-test-signature": "valid", "x-request-id": `acct-req-${++seq}-${crypto.randomUUID()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });

    /** Cria dados em TODOS os módulos e uma assinatura ativa com um pagamento. */
    const populate = async (w: BillingWorld, c: Client, label: string) => {
      await c.put("/v1/profile", { displayName: label, locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" });
      expect((await c.put("/v1/preferences", validPrefs)).status).toBe(200);
      const acc = (await c.post("/v1/accounts", { name: `Conta ${label}`, type: "checking", initialBalanceCents: 100_000 })).body as { id: string };
      await c.post("/v1/transactions", { accountId: acc.id, type: "expense", amountCents: 2500, date: "2026-11-09", description: `Mercado ${label}` });
      await c.post("/v1/payables", { kind: "payable", description: `Energia ${label}`, amountCents: 15_000, dueDate: "2026-11-20" });
      await c.post("/v1/events", { title: `Reunião ${label}`, startDate: "2026-11-10", startTime: "10:00", durationMin: 60 });
      await c.post("/v1/tasks", { title: `Tarefa ${label}` });
      await c.put("/v1/ai/consent", { audio: true });
      w.llm.script.push(say(`resposta ${label}`));
      await c.post("/v1/ai/chat", { message: `pergunta ${label}` });

      const created = await c.post("/v1/billing/checkout", { planId: "pro" });
      expect(created.status, created.text).toBe(201);
      const subId = w.payments.lastId;
      w.payments.authorize(subId, PERIOD_END);
      await hook(w, "subscription", subId);
      w.payments.charge(subId, `pay_${label}_${crypto.randomUUID().slice(0, 8)}`, "approved", PERIOD_END);
      const paymentId = [...w.payments.payments.keys()].at(-1) as string;
      await hook(w, "payment", paymentId);
      return { accountId: acc.id, subId };
    };

    const exportOf = async (c: Client) => {
      const r = await c.get("/v1/account/export");
      expect(r.status, r.text).toBe(200);
      return r;
    };
    type Exported = { format: string; version: number; uid: string; truncated: string[]; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

    // ---------------------------------------------------------------- exportação
    it("exportação: devolve um JSON baixável com os dados de TODOS os módulos do usuário", async () => {
      const w = await world();
      const { accountId } = await populate(w, w.A, "Ana");
      const r = await exportOf(w.A);
      expect(r.headers.get("Content-Type")).toContain("application/json");
      expect(r.headers.get("Content-Disposition")).toBe('attachment; filename="lifeflow-dados-2026-11-09.json"');
      const out = JSON.parse(r.text) as Exported;
      expect(out).toMatchObject({ format: "lifeflow-export", version: 1, uid: w.uidA, truncated: [] });
      expect(out.data["profile"]).toMatchObject({ displayName: "Ana" });
      expect(out.data["accounts"].map((a: { id: string }) => a.id)).toEqual([accountId]);
      expect(out.data["transactions"]).toHaveLength(1);
      expect(out.data["transactions"][0]).toMatchObject({ description: "Mercado Ana", amountCents: 2500 });
      expect(out.data["payables"]).toHaveLength(1);
      expect(out.data["events"]).toHaveLength(1);
      expect(out.data["tasks"]).toHaveLength(1);
      expect(out.data["consents"]).toHaveLength(1);
      expect(out.data["preferences"].length).toBeGreaterThanOrEqual(1);
      expect(out.data["billingPayments"]).toHaveLength(1);
      expect(out.data["aiUsage"].length).toBeGreaterThanOrEqual(1);
      expect(out.data["aiConversations"]).toHaveLength(1);
      expect(out.data["aiConversations"][0].messages.map((m: { content: string }) => m.content)).toEqual(["pergunta Ana", "resposta Ana"]);
      expect(out.data["subscription"]).toMatchObject({ planId: "pro", status: "active" });
    });

    it("exportação: não traz dados de outro usuário nem identificadores internos do provedor", async () => {
      const w = await world();
      await populate(w, w.A, "Ana");
      await populate(w, w.B, "Bia");
      const text = (await exportOf(w.A)).text;
      expect(text).not.toContain("Bia");
      expect(text).not.toContain(w.uidB);
      expect(text).not.toContain("providerSubscriptionId");
      expect(text).not.toContain("checkoutKeyHash");
      expect(text).not.toContain("https://pay.test/checkout");
    });

    it("exportação: usuário sem nada exporta um arquivo válido e vazio; só GET; exige token", async () => {
      const w = await world();
      const out = JSON.parse((await exportOf(w.A)).text) as Exported;
      expect(out.data["profile"]).toBeNull();
      expect(out.data["transactions"]).toEqual([]);
      expect(out.data["subscription"]).toBeNull();
      expect((await w.A.post("/v1/account/export", {})).status).toBe(405);
      expect((await w.app("/v1/account/export")).status).toBe(401);
      expect((await w.A.get("/v1/account/nada")).status).toBe(404);
    });

    // ---------------------------------------------------------------- exclusão
    it("exclusão: exige a frase de confirmação exata e nada mais no corpo", async () => {
      const w = await world();
      await populate(w, w.A, "Ana");
      for (const body of [{}, { confirm: "excluir minha conta" }, { confirm: "sim" }, { ...CONFIRM, uid: w.uidB }]) {
        expect((await w.A.post("/v1/account/delete", body)).status, JSON.stringify(body)).toBe(400);
      }
      expect((await w.A.get("/v1/accounts")).body["items"] ?? (await w.A.get("/v1/accounts")).body["accounts"]).toBeTruthy();
      expect((await w.A.get("/v1/account/delete")).status).toBe(405);
    });

    it("exclusão: exige login recente (senha confirmada há ≤ 5 min)", async () => {
      const w = await world();
      await populate(w, w.A, "Ana");
      // Token com login há 1 hora (relativo ao relógio simulado do Worker).
      const old = Math.floor(w.clock.now.getTime() / 1000) - 3600;
      const stale = new (w.A.constructor as new (app: BillingWorld["app"], token: string) => Client)(
        w.app,
        await signToken(signer, { uid: w.uidA, email: "user@example.com", authTime: old }),
      );
      const r = await stale.post("/v1/account/delete", CONFIRM);
      expect(r.status).toBe(401);
      expect(code(r)).toBe("recent_login_required");
      expect(JSON.parse((await exportOf(w.A)).text).data.accounts).toHaveLength(1);
    });

    it("exclusão: apaga TODOS os dados do usuário (inclusive o que as regras impedem o cliente de apagar) e cancela a cobrança", async () => {
      const w = await world();
      const { subId } = await populate(w, w.A, "Ana");
      const raw = options.rawClient(w);
      expect((await raw.listCollectionIds(`users/${w.uidA}`)).length).toBeGreaterThan(8);

      const r = await w.A.post("/v1/account/delete", CONFIRM);
      expect(r.status, r.text).toBe(200);
      expect(r.body["deleted"]).toBe(true);
      expect(Number(r.body["documents"])).toBeGreaterThan(10);

      // Nada sobrou no banco: nem subcoleções, nem mensagens da IA, nem perfil, nem assinatura.
      expect(await raw.listCollectionIds(`users/${w.uidA}`)).toEqual([]);
      expect(await raw.get(`users/${w.uidA}`)).toBeNull();
      expect(await raw.get(`subscriptions/${w.uidA}`)).toBeNull();
      // A cobrança foi encerrada no provedor.
      expect(w.payments.subs.get(subId)?.status).toBe("canceled");
      // Pela API também: tudo vazio.
      const out = JSON.parse((await exportOf(w.A)).text) as Exported;
      expect(out.data["profile"]).toBeNull();
      for (const key of ["accounts", "transactions", "payables", "events", "tasks", "aiConversations", "aiLogs", "billingPayments", "consents"]) {
        expect(out.data[key], key).toEqual([]);
      }
      expect((await w.A.get("/v1/profile")).status).toBe(404);
    });

    it("exclusão: NÃO toca nos dados de outro usuário", async () => {
      const w = await world();
      await populate(w, w.A, "Ana");
      await populate(w, w.B, "Bia");
      const before = JSON.parse((await exportOf(w.B)).text) as Exported;
      expect((await w.A.post("/v1/account/delete", CONFIRM)).status).toBe(200);
      const after = JSON.parse((await exportOf(w.B)).text) as Exported;
      expect(after.data).toEqual(before.data);
      expect(after.data["subscription"]).toMatchObject({ status: "active" });
      expect((await w.B.get("/v1/profile")).status).toBe(200);
    });

    it("exclusão: se o provedor de pagamentos falhar, NADA é apagado e dá para tentar de novo", async () => {
      const w = await world();
      const { subId } = await populate(w, w.A, "Ana");
      w.payments.failNext = new PaymentProviderError("unavailable", "x");
      const failed = await w.A.post("/v1/account/delete", CONFIRM);
      expect(failed.status).toBe(502);
      expect(JSON.parse((await exportOf(w.A)).text).data.accounts).toHaveLength(1);
      expect((await w.A.get("/v1/profile")).status).toBe(200);

      expect((await w.A.post("/v1/account/delete", CONFIRM)).status).toBe(200);
      expect(w.payments.subs.get(subId)?.status).toBe("canceled");
      expect((await w.A.get("/v1/profile")).status).toBe(404);
    });

    it("exclusão: usuário sem assinatura apaga sem acionar o provedor; repetir é inofensivo", async () => {
      const w = await world();
      await w.A.put("/v1/profile", { displayName: "Ana", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" });
      await w.A.post("/v1/tasks", { title: "x" });
      const calls = w.payments.calls.length;
      expect((await w.A.post("/v1/account/delete", CONFIRM)).status).toBe(200);
      expect((await w.A.post("/v1/account/delete", CONFIRM)).status).toBe(200);
      expect(w.payments.calls.length).toBe(calls);
      expect(await options.rawClient(w).listCollectionIds(`users/${w.uidA}`)).toEqual([]);
    });

    it("exclusão: webhook tardio da assinatura apagada não ressuscita nada; o mesmo uid pode recomeçar do zero", async () => {
      const w = await world();
      const { subId } = await populate(w, w.A, "Ana");
      await w.A.post("/v1/account/delete", CONFIRM);
      w.payments.authorize(subId, PERIOD_END); // o provedor ainda manda eventos
      const late = await hook(w, "subscription", subId);
      expect(late.status).toBe(200);
      expect(((await late.json()) as { status: string }).status).toBe("ignored");
      expect(await options.rawClient(w).get(`subscriptions/${w.uidA}`)).toBeNull();
      expect((await w.A.get("/v1/billing/subscription")).body["subscription"]).toMatchObject({ status: "none", plan: "free" });
      // Recomeçar: perfil novo, sem rastro do anterior.
      expect((await w.A.put("/v1/profile", { displayName: "Ana nova", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL" })).status).toBe(200);
      expect(JSON.parse((await exportOf(w.A)).text).data.transactions).toEqual([]);
    });

    it("a exclusão fica presa ao uid do solicitante (o caminho privilegiado recusa qualquer outro caminho)", async () => {
      const w = await world();
      const client = options.rawClient(w);
      expect(() => new UserErasure(client, "a/b")).toThrow(SystemAccessError);
      expect(() => new UserErasure(client, "")).toThrow(SystemAccessError);
      const erasure = new UserErasure(client, w.uidA);
      const guard = (path: string) => (erasure as unknown as { guard(p: string): void }).guard(path);
      expect(() => guard(`users/${w.uidB}`)).toThrow(SystemAccessError);
      expect(() => guard(`users/${w.uidA}x`)).toThrow(SystemAccessError);
      expect(() => guard(`subscriptions/${w.uidB}`)).toThrow(SystemAccessError);
      expect(() => guard("plans/pro")).toThrow(SystemAccessError);
      expect(() => guard(`users/${w.uidA}/transactions/t1`)).not.toThrow();
      expect(() => guard(`subscriptions/${w.uidA}`)).not.toThrow();
    });
  });
}

export { env };
