import { describe, expect, it, vi } from "vitest";
import { MercadoPagoProvider } from "../src/billing/mercadopago";
import { PaymentProviderError, WebhookSignatureError, type CreateSubscriptionInput } from "../src/billing/provider";
import { createPaymentProvider } from "../src/billing";
import { env } from "./helpers";

/**
 * Adaptador do Mercado Pago contra respostas SIMULADAS. A assinatura do webhook usa HMAC-SHA256 real, mas o
 * formato do manifesto vem da documentação consultada — nunca foi confirmado contra o Mercado Pago de verdade.
 */
const SECRET = "segredo-de-teste";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sign(id: string, requestId: string, ts: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`id:${id};request-id:${requestId};ts:${ts};`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const input: CreateSubscriptionInput = {
  planId: "pro",
  planName: "Pro",
  amountCents: 1490,
  currency: "BRL",
  payerEmail: "fake@example.com",
  externalReference: "uid1",
  backUrl: "https://app.test/assinatura",
  notificationUrl: "https://api.test/webhooks/mercadopago",
  trialDays: 0,
  idempotencyKey: "idem-1",
};

describe("MercadoPagoProvider — requisições", () => {
  it("cria a assinatura com preço em reais, referência = uid, e-mail e chave de idempotência", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "pre_1", status: "pending", external_reference: "uid1", init_point: "https://mp.test/pay", auto_recurring: { transaction_amount: 14.9 } }, 201));
    const provider = new MercadoPagoProvider("tok", SECRET, fetchImpl as unknown as typeof fetch, "https://mp.test/");
    const sub = await provider.createSubscription(input);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://mp.test/preapproval");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["X-Idempotency-Key"]).toBe("idem-1");
    const body = JSON.parse(String(init.body)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body).toMatchObject({ external_reference: "uid1", payer_email: "fake@example.com", status: "pending", notification_url: "https://api.test/webhooks/mercadopago" });
    expect(body["auto_recurring"]).toEqual({ frequency: 1, frequency_type: "months", transaction_amount: 14.9, currency_id: "BRL" });
    expect(sub).toEqual({ id: "pre_1", status: "pending", externalReference: "uid1", amountCents: 1490, nextPaymentDate: null, checkoutUrl: "https://mp.test/pay" });
  });

  it("teste gratuito só é enviado quando configurado", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "pre_2", status: "pending" }));
    const provider = new MercadoPagoProvider("tok", SECRET, fetchImpl as unknown as typeof fetch);
    await provider.createSubscription({ ...input, trialDays: 7, notificationUrl: null });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body["auto_recurring"].free_trial).toEqual({ frequency: 7, frequency_type: "days" });
    expect(body["notification_url"]).toBeUndefined();
  });

  it("consulta, cancela e muda o valor", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return json({ id: "pre/1", status: "authorized", next_payment_date: "2026-12-09T12:00:00.000-03:00", auto_recurring: { transaction_amount: 29.9 } });
    }) as unknown as typeof fetch;
    const provider = new MercadoPagoProvider("tok", SECRET, fetchImpl);
    const sub = await provider.getSubscription("pre/1");
    expect(calls[0]![0]).toBe("https://api.mercadopago.com/preapproval/pre%2F1");
    expect(sub).toMatchObject({ status: "active", amountCents: 2990, nextPaymentDate: "2026-12-09T12:00:00.000-03:00" });
    await provider.cancelSubscription("pre_1");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ status: "cancelled" });
    expect(calls[1]![1].method).toBe("PUT");
    await provider.changeAmount("pre_1", 2990);
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ auto_recurring: { transaction_amount: 29.9, currency_id: "BRL" } });
  });

  it("mapeia os status de assinatura", async () => {
    const make = (status: string) => new MercadoPagoProvider("t", SECRET, (async () => json({ id: "x", status })) as unknown as typeof fetch);
    expect((await make("authorized").getSubscription("x")).status).toBe("active");
    expect((await make("paused").getSubscription("x")).status).toBe("paused");
    expect((await make("cancelled").getSubscription("x")).status).toBe("canceled");
    expect((await make("pending").getSubscription("x")).status).toBe("pending");
    expect((await make("qualquer").getSubscription("x")).status).toBe("pending");
  });

  it("mapeia pagamentos recorrentes", async () => {
    const make = (body: unknown) => new MercadoPagoProvider("t", SECRET, (async () => json(body)) as unknown as typeof fetch);
    const ok = await make({ id: 77, preapproval_id: "pre_1", status: "processed", transaction_amount: 14.9, date_created: "2026-11-09T12:00:00Z", payment: { status: "approved" } }).getPayment("77");
    expect(ok).toEqual({ id: "77", subscriptionId: "pre_1", status: "approved", amountCents: 1490, createdAt: "2026-11-09T12:00:00Z" });
    expect((await make({ id: 1, status: "recycling", transaction_amount: 1, payment: { status: "rejected" } }).getPayment("1")).status).toBe("rejected");
    expect((await make({ id: 1, status: "scheduled", transaction_amount: 1 }).getPayment("1")).status).toBe("pending");
    expect((await make({ id: 1, transaction_amount: 1, payment: { status: "refunded" } }).getPayment("1")).status).toBe("refunded");
    await expect(make({ id: 1 }).getPayment("1")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("traduz erros HTTP e de rede em tipos claros (sem vazar o corpo)", async () => {
    const status = (code: number) => new MercadoPagoProvider("t", SECRET, (async () => json({ message: "segredo interno" }, code)) as unknown as typeof fetch).getSubscription("x").catch((e) => e as PaymentProviderError) as Promise<PaymentProviderError>;
    expect((await status(401)).kind).toBe("not_configured");
    expect((await status(403)).kind).toBe("not_configured");
    expect((await status(404)).kind).toBe("not_found");
    expect((await status(429)).kind).toBe("unavailable");
    expect((await status(503)).kind).toBe("unavailable");
    const rejected = await status(400);
    expect(rejected.kind).toBe("rejected");
    expect(rejected.message).not.toContain("segredo interno");
    const down = new MercadoPagoProvider("t", SECRET, (async () => { throw new Error("rede"); }) as unknown as typeof fetch);
    expect(((await down.getSubscription("x").catch((e) => e)) as PaymentProviderError).kind).toBe("unavailable");
    const html = new MercadoPagoProvider("t", SECRET, (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch);
    expect(((await html.getSubscription("x").catch((e) => e)) as PaymentProviderError).kind).toBe("unavailable");
    const noId = new MercadoPagoProvider("t", SECRET, (async () => json({ status: "authorized" })) as unknown as typeof fetch);
    expect(((await noId.getSubscription("x").catch((e) => e)) as PaymentProviderError).kind).toBe("unavailable");
  });

  it("createPaymentProvider: sem credenciais → não configurado; com credenciais → Mercado Pago", () => {
    expect(() => createPaymentProvider({ ...env }, fetch)).toThrowError(/MERCADOPAGO_ACCESS_TOKEN|configurad/i);
    const provider = createPaymentProvider({ ...env, MERCADOPAGO_ACCESS_TOKEN: "t", MERCADOPAGO_WEBHOOK_SECRET: "s" }, fetch);
    expect(provider.name).toBe("mercadopago");
  });
});

describe("MercadoPagoProvider — assinatura do webhook (HMAC-SHA256 real)", () => {
  const provider = new MercadoPagoProvider("t", SECRET, (async () => json({})) as unknown as typeof fetch);
  const url = (query = "") => new URL(`https://api.test/webhooks/mercadopago${query}`);
  const headers = (signature: string, requestId = "req-1") => new Headers({ "x-signature": signature, "x-request-id": requestId });

  it("aceita assinatura válida (id da query) e identifica assinatura/pagamento", async () => {
    const v1 = await sign("pre123", "req-1", "1700000000");
    const sub = await provider.verifyWebhook({ headers: headers(`ts=1700000000,v1=${v1}`), url: url("?data.id=pre123&type=subscription_preapproval"), rawBody: "" });
    expect(sub).toEqual({ kind: "subscription", resourceId: "pre123", eventKey: "subscription_preapproval:pre123:req-1" });
    const pay = await provider.verifyWebhook({ headers: headers(`ts=1700000000,v1=${v1}`), url: url("?data.id=pre123"), rawBody: JSON.stringify({ type: "subscription_authorized_payment" }) });
    expect(pay.kind).toBe("payment");
  });

  it("usa o id do corpo e normaliza maiúsculas para o manifesto", async () => {
    const v1 = await sign("abc123", "req-1", "1");
    const result = await provider.verifyWebhook({ headers: headers(`ts=1,v1=${v1}`), url: url(), rawBody: JSON.stringify({ type: "subscription_preapproval", data: { id: "ABC123" } }) });
    expect(result).toMatchObject({ kind: "subscription", resourceId: "ABC123" });
  });

  it("tópico não tratado é ignorado (mas só depois de validar a assinatura)", async () => {
    const v1 = await sign("9", "req-1", "1");
    expect(await provider.verifyWebhook({ headers: headers(`ts=1,v1=${v1}`), url: url("?data.id=9&type=payment"), rawBody: "" })).toEqual({ kind: "ignored", topic: "payment" });
  });

  it("rejeita assinatura errada, adulterada, de outro segredo e cabeçalhos ausentes/malformados", async () => {
    const good = await sign("pre1", "req-1", "5");
    const ask = (h: Headers, query = "?data.id=pre1&type=subscription_preapproval", rawBody = "") => provider.verifyWebhook({ headers: h, url: url(query), rawBody }).catch((e) => e);
    expect(await ask(headers(`ts=5,v1=${"0".repeat(64)}`))).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(headers(`ts=5,v1=${await sign("pre1", "req-1", "5", "outro")}`))).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(headers(`ts=6,v1=${good}`))).toBeInstanceOf(WebhookSignatureError); // ts adulterado
    expect(await ask(headers(`ts=5,v1=${good}`, "req-2"))).toBeInstanceOf(WebhookSignatureError); // request-id adulterado
    expect(await ask(headers(`ts=5,v1=${good}`), "?data.id=pre2&type=subscription_preapproval")).toBeInstanceOf(WebhookSignatureError); // id adulterado
    expect(await ask(headers(`v1=${good}`))).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(headers(`ts=5`))).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(new Headers({ "x-signature": `ts=5,v1=${good}` }))).toBeInstanceOf(WebhookSignatureError); // sem request-id
    expect(await ask(new Headers())).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(headers(`ts=5,v1=${good}`), "", "não-é-json")).toBeInstanceOf(WebhookSignatureError); // sem id
    expect(await ask(headers(`ts=5,v1=${good}`), `?data.id=${"a".repeat(200)}`)).toBeInstanceOf(WebhookSignatureError);
    expect(await ask(headers(`ts=5,v1=${good}`), "?data.id=a%3Bb")).toBeInstanceOf(WebhookSignatureError);
  });

  it("sem segredo configurado, recusa tudo como 'não configurado'", async () => {
    const bare = new MercadoPagoProvider("t", null, fetch);
    const error = await bare.verifyWebhook({ headers: headers("ts=1,v1=x"), url: url("?data.id=1"), rawBody: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).kind).toBe("not_configured");
  });
});
