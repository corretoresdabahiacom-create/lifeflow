import {
  PaymentProviderError,
  WebhookSignatureError,
  type CreateSubscriptionInput,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentStatus,
  type ProviderSubscription,
  type ProviderSubscriptionStatus,
  type WebhookRequest,
  type WebhookResult,
} from "./provider";

const DEFAULT_BASE = "https://api.mercadopago.com";
const TIMEOUT_MS = 20_000;

/** Comparação de tempo constante de duas strings hexadecimais. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mapSubscriptionStatus(status: unknown): ProviderSubscriptionStatus {
  switch (status) {
    case "authorized":
      return "active";
    case "paused":
      return "paused";
    case "cancelled":
    case "canceled":
      return "canceled";
    default:
      return "pending";
  }
}

function mapPaymentStatus(outer: unknown, inner: unknown): ProviderPaymentStatus {
  if (inner === "approved" || outer === "processed") return "approved";
  if (inner === "refunded" || inner === "charged_back") return "refunded";
  if (inner === "rejected" || inner === "cancelled" || outer === "recycling" || outer === "cancelled") return "rejected";
  return "pending";
}

const toCents = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null);

/**
 * Adaptador do Mercado Pago (assinaturas recorrentes "preapproval").
 * IMPORTANTE: escrito a partir da documentação oficial e testado só com respostas simuladas — nunca foi
 * executado contra o Mercado Pago real (não há credenciais nesta fase).
 */
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = "mercadopago";

  constructor(
    private readonly accessToken: string,
    private readonly webhookSecret: string | null,
    private readonly fetchImpl: typeof fetch,
    private readonly baseUrl: string = DEFAULT_BASE,
  ) {}

  private async call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" };
      if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PaymentProviderError("unavailable", "Provedor de pagamentos indisponível");
    }
    if (response.status === 401 || response.status === 403) throw new PaymentProviderError("not_configured", "Credencial do provedor recusada");
    if (response.status === 404) throw new PaymentProviderError("not_found", "Recurso não encontrado no provedor");
    if (response.status >= 500 || response.status === 429) throw new PaymentProviderError("unavailable", "Provedor de pagamentos indisponível");
    if (!response.ok) throw new PaymentProviderError("rejected", "O provedor recusou a operação");
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") throw new PaymentProviderError("unavailable", "Resposta inválida do provedor");
    return parsed;
  }

  private toSubscription(raw: Record<string, unknown>): ProviderSubscription {
    if (typeof raw["id"] !== "string") throw new PaymentProviderError("unavailable", "Resposta inválida do provedor");
    const recurring = (raw["auto_recurring"] ?? {}) as Record<string, unknown>;
    return {
      id: raw["id"],
      status: mapSubscriptionStatus(raw["status"]),
      externalReference: typeof raw["external_reference"] === "string" && raw["external_reference"] ? raw["external_reference"] : null,
      amountCents: toCents(recurring["transaction_amount"]),
      nextPaymentDate: typeof raw["next_payment_date"] === "string" ? raw["next_payment_date"] : null,
      checkoutUrl: typeof raw["init_point"] === "string" ? raw["init_point"] : null,
    };
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription> {
    const autoRecurring: Record<string, unknown> = {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: input.amountCents / 100,
      currency_id: input.currency,
    };
    // A documentação consultada lista `free_trial` só na resposta; se o provedor ignorar, não há teste gratuito.
    if (input.trialDays > 0) autoRecurring["free_trial"] = { frequency: input.trialDays, frequency_type: "days" };
    const raw = await this.call(
      "POST",
      "/preapproval",
      {
        reason: `LIFEFlow ${input.planName}`,
        external_reference: input.externalReference,
        payer_email: input.payerEmail,
        back_url: input.backUrl,
        ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
        status: "pending",
        auto_recurring: autoRecurring,
      },
      input.idempotencyKey,
    );
    return this.toSubscription(raw);
  }

  async getSubscription(id: string): Promise<ProviderSubscription> {
    return this.toSubscription(await this.call("GET", `/preapproval/${encodeURIComponent(id)}`));
  }

  async cancelSubscription(id: string): Promise<void> {
    await this.call("PUT", `/preapproval/${encodeURIComponent(id)}`, { status: "cancelled" });
  }

  async changeAmount(id: string, amountCents: number): Promise<void> {
    await this.call("PUT", `/preapproval/${encodeURIComponent(id)}`, {
      auto_recurring: { transaction_amount: amountCents / 100, currency_id: "BRL" },
    });
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const raw = await this.call("GET", `/authorized_payments/${encodeURIComponent(id)}`);
    const inner = (raw["payment"] ?? {}) as Record<string, unknown>;
    const amount = toCents(raw["transaction_amount"]);
    if (typeof raw["id"] !== "string" && typeof raw["id"] !== "number") throw new PaymentProviderError("unavailable", "Resposta inválida do provedor");
    if (amount === null) throw new PaymentProviderError("unavailable", "Resposta inválida do provedor");
    const preapproval = raw["preapproval_id"];
    return {
      id: String(raw["id"]),
      subscriptionId: typeof preapproval === "string" ? preapproval : null,
      status: mapPaymentStatus(raw["status"], inner["status"]),
      amountCents: amount,
      createdAt: typeof raw["date_created"] === "string" ? raw["date_created"] : new Date().toISOString(),
    };
  }

  /**
   * Manifesto assinado: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` com HMAC-SHA256 do segredo do webhook.
   * O `data.id` vem da query (`data.id`), ou do corpo, em minúsculas quando alfanumérico.
   */
  async verifyWebhook(request: WebhookRequest): Promise<WebhookResult> {
    if (!this.webhookSecret) throw new PaymentProviderError("not_configured", "Segredo do webhook não configurado");
    const signature = request.headers.get("x-signature") ?? "";
    const requestId = request.headers.get("x-request-id") ?? "";
    const parts = new Map<string, string>();
    for (const piece of signature.split(",")) {
      const [k, ...rest] = piece.split("=");
      if (k && rest.length > 0) parts.set(k.trim(), rest.join("=").trim());
    }
    const ts = parts.get("ts");
    const v1 = parts.get("v1");
    if (!ts || !v1 || !requestId) throw new WebhookSignatureError();

    let body: { type?: unknown; data?: { id?: unknown } } = {};
    try {
      body = request.rawBody ? (JSON.parse(request.rawBody) as typeof body) : {};
    } catch {
      body = {};
    }
    const rawId = request.url.searchParams.get("data.id") ?? (body.data?.id !== undefined ? String(body.data.id) : "");
    if (!rawId || rawId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(rawId)) throw new WebhookSignatureError();
    const id = /^[A-Za-z0-9]+$/.test(rawId) ? rawId.toLowerCase() : rawId;

    const expected = await hmacHex(this.webhookSecret, `id:${id};request-id:${requestId};ts:${ts};`);
    if (!safeEqualHex(expected, v1.toLowerCase())) throw new WebhookSignatureError();

    const topic = String(request.url.searchParams.get("type") ?? request.url.searchParams.get("topic") ?? body.type ?? "");
    const eventKey = `${topic}:${rawId}:${requestId}`;
    if (topic === "subscription_preapproval") return { kind: "subscription", resourceId: rawId, eventKey };
    if (topic === "subscription_authorized_payment") return { kind: "payment", resourceId: rawId, eventKey };
    return { kind: "ignored", topic };
  }
}
