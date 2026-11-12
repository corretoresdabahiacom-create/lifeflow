import { HttpError } from "../errors";
import { json } from "../http";
import { log } from "../logger";
import { createSystemDb } from "../system";
import type { BillingDeps } from "./routes";
import { resolveProvider } from "./routes";
import { PaymentProviderError, WebhookSignatureError } from "./provider";
import { processWebhook } from "./service";
import { loadPlans } from "./store";

const MAX_WEBHOOK_BYTES = 64 * 1024;

/**
 * `POST /webhooks/mercadopago` — SEM token de usuário; a autenticação é a assinatura HMAC.
 * 200 = recebido (inclusive duplicado/ignorado); 401 = assinatura inválida; 503 = falha transitória
 * (o provedor tenta de novo).
 */
export async function handleWebhook(request: Request, url: URL, deps: BillingDeps, now: () => Date): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Método não permitido", { Allow: "POST" });
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) throw new HttpError(413, "payload_too_large", "Corpo grande demais");
  const rawBody = await request.text();
  if (rawBody.length > MAX_WEBHOOK_BYTES) throw new HttpError(413, "payload_too_large", "Corpo grande demais");

  const provider = resolveProvider(deps);
  let event;
  try {
    event = await provider.verifyWebhook({ headers: request.headers, url, rawBody });
  } catch (error) {
    if (error instanceof WebhookSignatureError) throw new HttpError(401, "invalid_signature", "Assinatura inválida");
    if (error instanceof PaymentProviderError) throw new HttpError(503, "billing_not_configured", "Cobrança ainda não está configurada");
    throw error;
  }
  if (event.kind === "ignored") return json({ received: true, status: "ignored", topic: event.topic });

  const sys = await createSystemDb(deps.env, deps.fetchImpl);
  try {
    const plans = await loadPlans(sys);
    const outcome = await processWebhook(sys, provider, plans, event, now());
    return json({ received: true, status: outcome.status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    log("error", "webhook_failed", { requestId: "webhook", kind: event.kind, errorCode: error instanceof PaymentProviderError ? error.kind : "internal" });
    // Falha transitória (provedor/banco): resposta de erro faz o provedor repetir.
    throw new HttpError(503, "webhook_retry", "Falha temporária ao processar; tente novamente");
  }
}
