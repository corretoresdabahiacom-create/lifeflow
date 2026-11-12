/**
 * Interface do provedor de pagamentos (contrato A3: nenhum nome/endpoint de provedor fora dos adaptadores).
 * O backend NUNCA confia no corpo do webhook: ele só descobre QUE algo mudou e consulta o provedor.
 */

export type ProviderSubscriptionStatus = "pending" | "active" | "paused" | "canceled";
export type ProviderPaymentStatus = "approved" | "rejected" | "pending" | "refunded";

export interface CreateSubscriptionInput {
  planId: string;
  planName: string;
  amountCents: number;
  currency: "BRL";
  payerEmail: string;
  /** Identifica o dono no provedor: é o uid. Volta nas consultas e é conferido antes de qualquer alteração. */
  externalReference: string;
  backUrl: string;
  notificationUrl: string | null;
  trialDays: number;
  idempotencyKey: string;
}

export interface ProviderSubscription {
  id: string;
  status: ProviderSubscriptionStatus;
  externalReference: string | null;
  amountCents: number | null;
  /** Próxima cobrança (ISO) = fim do período já pago. */
  nextPaymentDate: string | null;
  checkoutUrl: string | null;
}

export interface ProviderPayment {
  id: string;
  subscriptionId: string | null;
  status: ProviderPaymentStatus;
  amountCents: number;
  createdAt: string;
}

export type WebhookResult =
  | { kind: "subscription"; resourceId: string; eventKey: string }
  | { kind: "payment"; resourceId: string; eventKey: string }
  /** Assinatura válida, mas de um tópico que não tratamos (ex.: `payment` avulso). */
  | { kind: "ignored"; topic: string };

export interface WebhookRequest {
  headers: Headers;
  url: URL;
  rawBody: string;
}

/** Assinatura ausente, malformada ou que não confere. */
export class WebhookSignatureError extends Error {
  constructor(message = "Assinatura do webhook inválida") {
    super(message);
  }
}

export type PaymentProviderErrorKind = "not_configured" | "unavailable" | "rejected" | "not_found";
export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentProviderErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  readonly name: string;
  createSubscription(input: CreateSubscriptionInput): Promise<ProviderSubscription>;
  getSubscription(id: string): Promise<ProviderSubscription>;
  cancelSubscription(id: string): Promise<void>;
  changeAmount(id: string, amountCents: number): Promise<void>;
  getPayment(id: string): Promise<ProviderPayment>;
  /** Valida a assinatura (HMAC) e identifica o recurso. Lança `WebhookSignatureError` se inválido. */
  verifyWebhook(request: WebhookRequest): Promise<WebhookResult>;
}
