import type { Env } from "../env";
import { MercadoPagoProvider } from "./mercadopago";
import { PaymentProviderError, type PaymentProvider } from "./provider";

export * from "./provider";
export { MercadoPagoProvider } from "./mercadopago";

/** Cria o adaptador a partir do ambiente. Sem credencial: `not_configured`. */
export function createPaymentProvider(env: Env, fetchImpl: typeof fetch): PaymentProvider {
  const name = env.PAYMENT_PROVIDER ?? "mercadopago";
  if (name !== "mercadopago") throw new PaymentProviderError("not_configured", `Provedor de pagamentos desconhecido: ${name}`);
  if (!env.MERCADOPAGO_ACCESS_TOKEN) throw new PaymentProviderError("not_configured", "MERCADOPAGO_ACCESS_TOKEN ausente");
  return new MercadoPagoProvider(env.MERCADOPAGO_ACCESS_TOKEN, env.MERCADOPAGO_WEBHOOK_SECRET ?? null, fetchImpl, env.MERCADOPAGO_BASE_URL);
}
