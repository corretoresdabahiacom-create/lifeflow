import { generateKeyPair, exportPKCS8 } from "jose";
import { describe, expect, it } from "vitest";
import { MercadoPagoProvider } from "../src/billing/mercadopago";
import { PaymentProviderError, WebhookSignatureError } from "../src/billing/provider";
import { clearServiceAccountTokenCache, serviceAccountToken } from "../src/system";

/** Adaptador do Mercado Pago com `fetch` SIMULADO e HMAC real. Nada aqui toca o Mercado Pago de verdade. */

const SECRET = "segredo-de-teste";
const FAKE_TOKEN = "credencial-falsa-de-teste";
const hmac = async (message: string, secret = SECRET) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
function mock(responses: Array<Response | Error>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta simulada");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const provider = (fetchImpl: typeof fetch, secret: string | null = SECRET) => new MercadoPagoProvider(FAKE_TOKEN, secret, fetchImpl, "https://mp.test/");

const input = {
  planId: "pro",
  planName: "Pro",
  amountCents: 1490,
  currency: "BRL" as const,
  payerEmail: "ana@example.com",
  externalReference: "uid-1",
  backUrl: "https://app.test/assinatura",
  notificationUrl: "https://api.test/webhooks/mercadopago",
  trialDays: 0,
  idempotencyKey: "idem-12345678",
};

describe("MercadoPagoProvider (fetch simulado)", () => {
  it("cria assinatura: corpo, valor em reais, referência, idempotência e credencial", async () => {
    const { fetchImpl, seen } = mock([json({ id: "pre_1", status: "pending", external_reference: "uid-1", init_point: "https://mp/checkout", auto_recurring: { transaction_amount: 14.9 } })]);
    const sub = await provider(fetchImpl).createSubscription(input);
    expect(sub).toEqual({ id: "pre_1", status: "pending", externalReference: "uid-1", amountCents: 1490, nextPaymentDate: null, checkoutUrl: "https://mp/checkout" });
    expect(seen[0]).toMatchObject({ url: "https://mp.test/preapproval", method: "POST" });
    expect(seen[0]!.headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(seen[0]!.headers["X-Idempotency-Key"]).toBe("idem-12345678");
    expect(seen[0]!.body).toMatchObject({
      external_reference: "uid-1",
      payer_email: "ana@example.com",
      back_url: "https://app.test/assinatura",
      notification_url: "https://api.test/webhooks/mercadopago",
      status: "pending",
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 14.9, currency_id: "BRL" },
    });
    expect((seen[0]!.body as { auto_recurring: Record<string, unknown> }).auto_recurring["free_trial"]).toBeUndefined();
  });

  it("teste gratuito só vai no corpo quando configurado", async () => {
    const { fetchImpl, seen } = mock([json({ id: "pre_2", status: "pending" })]);
    await provider(fetchImpl).createSubscription({ ...input, trialDays: 7 });
    expect((seen[0]!.body as { auto_recurring: Record<string, unknown> }).auto_recurring["free_trial"]).toEqual({ frequency: 7, frequency_type: "days" });
  });

  it("mapeia status da assinatura", async () => {
    const statuses: Array<[string, string]> = [["authorized", "active"], ["paused", "paused"], ["cancelled", "canceled"], ["pending", "pending"], ["qualquer", "pending"]];
    for (const [mp, ours] of statuses) {
      const { fetchImpl } = mock([json({ id: "p", status: mp, next_payment_date: "2026-12-09T12:00:00.000-03:00" })]);
      const sub = await provider(fetchImpl).getSubscription("p");
      expect(sub.status).toBe(ours);
      expect(sub.nextPaymentDate).toBe("2026-12-09T12:00:00.000-03:00");
    }
  });

  it("cancelar e mudar valor usam PUT /preapproval/{id}", async () => {
    const { fetchImpl, seen } = mock([json({ id: "p" }), json({ id: "p" })]);
    const p = provider(fetchImpl);
    await p.cancelSubscription("p/../x");
    await p.changeAmount("p", 2990);
    expect(seen[0]).toMatchObject({ url: "https://mp.test/preapproval/p%2F..%2Fx", method: "PUT", body: { status: "cancelled" } });
    expect(seen[1]!.body).toEqual({ auto_recurring: { transaction_amount: 29.9, currency_id: "BRL" } });
  });

  it("mapeia pagamento recorrente", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "processed", payment: { status: "approved" } }, "approved"],
      [{ status: "recycling", payment: { status: "rejected" } }, "rejected"],
      [{ status: "scheduled" }, "pending"],
      [{ status: "x", payment: { status: "charged_back" } }, "refunded"],
    ];
    for (const [extra, expected] of cases) {
      const { fetchImpl } = mock([json({ id: 99, preapproval_id: "pre_1", transaction_amount: 14.9, date_created: "2026-11-09T12:00:00Z", ...extra })]);
      const pay = await provider(fetchImpl).getPayment("99");
      expect(pay).toMatchObject({ id: "99", subscriptionId: "pre_1", amountCents: 1490, status: expected });
    }
    const { fetchImpl } = mock([json({ id: 1 })]);
    await expect(provider(fetchImpl).getPayment("1")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("traduz erros HTTP e de rede", async () => {
    const run = (r: Response | Error) => provider(mock([r]).fetchImpl).getSubscription("x");
    await expect(run(json({}, 401))).rejects.toMatchObject({ kind: "not_configured" });
    await expect(run(json({}, 403))).rejects.toMatchObject({ kind: "not_configured" });
    await expect(run(json({}, 404))).rejects.toMatchObject({ kind: "not_found" });
    await expect(run(json({}, 429))).rejects.toMatchObject({ kind: "unavailable" });
    await expect(run(json({}, 503))).rejects.toMatchObject({ kind: "unavailable" });
    await expect(run(json({}, 400))).rejects.toMatchObject({ kind: "rejected" });
    await expect(run(new TypeError("rede"))).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(run(new Response("não é json", { status: 200 }))).rejects.toMatchObject({ kind: "unavailable" });
    await expect(run(json({ status: "authorized" }))).rejects.toMatchObject({ kind: "unavailable" }); // sem id
  });

  describe("verifyWebhook (HMAC real)", () => {
    const sign = async (id: string, requestId: string, ts: string, secret = SECRET) => `ts=${ts},v1=${await hmac(`id:${id};request-id:${requestId};ts:${ts};`, secret)}`;
    const req = (headers: Record<string, string>, body: unknown, query = "") => ({
      headers: new Headers(headers),
      url: new URL(`https://api.test/webhooks/mercadopago${query}`),
      rawBody: JSON.stringify(body),
    });
    const p = provider(mock([]).fetchImpl);

    it("assinatura válida (id no corpo e na query) devolve o recurso", async () => {
      const body = { type: "subscription_preapproval", data: { id: "2c93808495" } };
      const r1 = await p.verifyWebhook(req({ "x-signature": await sign("2c93808495", "rid-1", "1700000000"), "x-request-id": "rid-1" }, body));
      expect(r1).toEqual({ kind: "subscription", resourceId: "2c93808495", eventKey: "subscription_preapproval:2c93808495:rid-1" });
      const r2 = await p.verifyWebhook(req({ "x-signature": await sign("2c93808495", "rid-2", "1700000001"), "x-request-id": "rid-2" }, {}, "?data.id=2c93808495&type=subscription_authorized_payment"));
      expect(r2).toMatchObject({ kind: "payment", resourceId: "2c93808495" });
    });

    it("id alfanumérico em MAIÚSCULAS é assinado em minúsculas", async () => {
      const r = await p.verifyWebhook(req({ "x-signature": await sign("abc123", "r", "1"), "x-request-id": "r" }, { type: "subscription_preapproval", data: { id: "ABC123" } }));
      expect(r).toMatchObject({ kind: "subscription", resourceId: "ABC123" });
    });

    it("tópicos que não tratamos são ignorados (mas só depois de validar a assinatura)", async () => {
      const r = await p.verifyWebhook(req({ "x-signature": await sign("77", "r", "1"), "x-request-id": "r" }, { type: "payment", data: { id: "77" } }));
      expect(r).toEqual({ kind: "ignored", topic: "payment" });
    });

    it("rejeita: segredo errado, id/request-id/ts adulterados, cabeçalhos ausentes, id ausente ou estranho", async () => {
      const body = { type: "subscription_preapproval", data: { id: "111" } };
      const ok = await sign("111", "rid", "5");
      const bad = async (headers: Record<string, string>, b: unknown = body) => {
        await expect(p.verifyWebhook(req(headers, b))).rejects.toBeInstanceOf(WebhookSignatureError);
      };
      await bad({ "x-signature": await sign("111", "rid", "5", "outro-segredo"), "x-request-id": "rid" });
      await bad({ "x-signature": ok, "x-request-id": "rid" }, { type: "subscription_preapproval", data: { id: "112" } });
      await bad({ "x-signature": ok, "x-request-id": "outro" });
      await bad({ "x-signature": ok.replace("ts=5", "ts=6"), "x-request-id": "rid" });
      await bad({ "x-request-id": "rid" });
      await bad({ "x-signature": ok });
      await bad({ "x-signature": "lixo", "x-request-id": "rid" });
      await bad({ "x-signature": ok, "x-request-id": "rid" }, { type: "subscription_preapproval" });
      await bad({ "x-signature": ok, "x-request-id": "rid" }, { data: { id: "../../etc" } });
      await expect(
        p.verifyWebhook({ headers: new Headers({ "x-signature": ok, "x-request-id": "rid" }), url: new URL("https://x.test/"), rawBody: "{{não json" }),
      ).rejects.toBeInstanceOf(WebhookSignatureError);
    });

    it("sem segredo configurado: erro de configuração (nunca aceita sem validar)", async () => {
      const unconfigured = provider(mock([]).fetchImpl, null);
      await expect(unconfigured.verifyWebhook(req({ "x-signature": "ts=1,v1=00", "x-request-id": "r" }, { data: { id: "1" } }))).rejects.toMatchObject({ kind: "not_configured" });
    });
  });
});

describe("token da conta de serviço", () => {
  it("assina JWT RS256 com o escopo do Firestore, troca por token e usa cache", async () => {
    clearServiceAccountTokenCache();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const raw = JSON.stringify({ client_email: "svc@proj.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth.test/token" });
    let calls = 0;
    let assertion = "";
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
      return json({ access_token: "ya29.token", expires_in: 3600 });
    }) as typeof fetch;
    expect(await serviceAccountToken(raw, fetchImpl, 1_000_000)).toBe("ya29.token");
    expect(await serviceAccountToken(raw, fetchImpl, 1_000_000 + 60_000)).toBe("ya29.token");
    expect(calls).toBe(1);
    const claims = JSON.parse(atob(assertion.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: "svc@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/datastore" });
    await serviceAccountToken(raw, fetchImpl, 1_000_000 + 4_000_000_0);
    expect(calls).toBe(2);
  });

  it("JSON inválido ou falha na troca dá erro sem vazar a chave", async () => {
    clearServiceAccountTokenCache();
    await expect(serviceAccountToken("{não json", fetch)).rejects.toThrow();
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const raw = JSON.stringify({ client_email: "svc@p.iam", private_key: await exportPKCS8(privateKey) });
    const failing = (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch;
    const error = await serviceAccountToken(raw, failing, 5).catch((e: unknown) => e);
    expect(String((error as Error).message ?? error)).not.toContain("PRIVATE KEY");
  });
});
