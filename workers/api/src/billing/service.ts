import type { PlanConfig, PlanId } from "@lifeflow/shared";
import { HttpError } from "../errors";
import { PreconditionFailedError, type DocData } from "../firestore";
import type { SystemDb } from "../system";
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderSubscription,
  type WebhookResult,
} from "./provider";
import { graceUntil, paymentPath, subscriptionPath } from "./store";

const PLAN_IDS_PAID = new Set<string>(["pro", "premium_ai"]);

export async function sha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Traduz falhas do provedor de pagamentos em erros HTTP claros, sem vazar detalhes. */
export function providerHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof PaymentProviderError) {
    switch (error.kind) {
      case "not_configured":
        return new HttpError(503, "billing_not_configured", "Cobrança ainda não está configurada");
      case "rejected":
        return new HttpError(422, "payment_provider_rejected", "O provedor de pagamentos recusou a operação");
      case "not_found":
        return new HttpError(502, "payment_provider_error", "Assinatura não encontrada no provedor de pagamentos");
      default:
        return new HttpError(502, "payment_provider_error", "O provedor de pagamentos está indisponível. Tente novamente.");
    }
  }
  return new HttpError(502, "payment_provider_error", "Falha ao falar com o provedor de pagamentos");
}

/**
 * Traduz o estado do provedor para o documento da assinatura. Função pura: a mesma entrada dá a mesma saída,
 * o que torna webhooks repetidos ou fora de ordem inofensivos (sempre se consulta o estado ATUAL).
 */
export function applySubscriptionState(sub: DocData, remote: ProviderSubscription, now: Date): DocData {
  const next: DocData = { ...sub, updatedAt: now.toISOString() };
  switch (remote.status) {
    case "active":
      next["status"] = "active";
      next["currentPeriodEnd"] = remote.nextPaymentDate ?? (sub["currentPeriodEnd"] as string | null) ?? null;
      next["graceUntil"] = null;
      next["cancelAtPeriodEnd"] = false;
      break;
    case "paused":
      next["status"] = "past_due";
      next["graceUntil"] = (sub["graceUntil"] as string | null) ?? graceUntil(now);
      break;
    case "canceled":
      next["status"] = "canceled";
      next["cancelAtPeriodEnd"] = true;
      next["pendingPlanId"] = null;
      next["graceUntil"] = null;
      if (sub["status"] === "pending") next["currentPeriodEnd"] = null;
      break;
    default:
      // pending: nada a alterar numa assinatura já ativa ou cancelada.
      break;
  }
  return next;
}

/** Quando o período renova, uma troca agendada (downgrade) passa a valer de fato. */
function settlePendingPlan(sub: DocData, plans: Record<PlanId, PlanConfig>): DocData {
  const pending = sub["pendingPlanId"];
  if (typeof pending !== "string" || !PLAN_IDS_PAID.has(pending)) return sub;
  return { ...sub, planId: pending, pendingPlanId: null, priceCents: plans[pending as PlanId].priceCents };
}

async function saveSubscription(sys: SystemDb, uid: string, doc: DocData): Promise<void> {
  await sys.commit([{ path: subscriptionPath(uid), fields: doc }]);
}

export interface WebhookOutcome {
  status: "processed" | "ignored" | "duplicate";
  detail: string;
}

/**
 * Processa um webhook JÁ VALIDADO. Sempre consulta o provedor (o corpo do webhook não é fonte de verdade).
 * Idempotente: a mesma notificação reprocessada não duplica pagamento nem efeito.
 */
export async function processWebhook(
  sys: SystemDb,
  provider: PaymentProvider,
  plans: Record<PlanId, PlanConfig>,
  event: Exclude<WebhookResult, { kind: "ignored" }>,
  now: Date,
): Promise<WebhookOutcome> {
  const eventId = (await sha(`webhook:${event.eventKey}`)).slice(0, 40);
  const eventPath = `webhookEvents/${eventId}`;
  const base: DocData = { provider: provider.name, kind: event.kind, resourceId: event.resourceId, receivedAt: now.toISOString() };
  try {
    await sys.commit([{ path: eventPath, fields: { ...base, status: "received", detail: "" }, precondition: { exists: false } }]);
  } catch (error) {
    if (!(error instanceof PreconditionFailedError)) throw error;
    const previous = await sys.get(eventPath);
    if (previous?.["status"] === "processed" || previous?.["status"] === "ignored") {
      return { status: "duplicate", detail: "Notificação já processada" };
    }
    // `received`/`failed`: tentativa anterior não terminou; reprocessa.
  }

  const finish = async (status: "processed" | "ignored" | "failed", detail: string): Promise<void> => {
    await sys.commit([{ path: eventPath, fields: { ...base, status, detail: detail.slice(0, 200), processedAt: now.toISOString() } }]).catch(() => undefined);
  };

  try {
    const outcome = event.kind === "subscription" ? await onSubscription(sys, provider, event.resourceId, now) : await onPayment(sys, provider, plans, event.resourceId, now);
    await finish(outcome.status === "ignored" ? "ignored" : "processed", outcome.detail);
    return outcome;
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : "erro");
    throw error;
  }
}

async function onSubscription(sys: SystemDb, provider: PaymentProvider, id: string, now: Date): Promise<WebhookOutcome> {
  const remote = await provider.getSubscription(id);
  const uid = remote.externalReference;
  if (!uid) return { status: "ignored", detail: "Assinatura sem referência de usuário" };
  const sub = await sys.get(subscriptionPath(uid));
  // Só mexe na assinatura que NÓS criamos para este usuário e que ainda é a vigente.
  if (!sub || sub["providerSubscriptionId"] !== remote.id) return { status: "ignored", detail: "Assinatura desconhecida ou substituída" };
  await saveSubscription(sys, uid, applySubscriptionState(sub, remote, now));
  return { status: "processed", detail: `assinatura ${remote.status}` };
}

async function onPayment(
  sys: SystemDb,
  provider: PaymentProvider,
  plans: Record<PlanId, PlanConfig>,
  id: string,
  now: Date,
): Promise<WebhookOutcome> {
  const payment = await provider.getPayment(id);
  if (!payment.subscriptionId) return { status: "ignored", detail: "Pagamento sem assinatura" };
  const found = await sys.query("", {
    collection: "subscriptions",
    filters: [{ field: "providerSubscriptionId", op: "EQUAL", value: payment.subscriptionId }],
    limit: 1,
  });
  const sub = found[0];
  if (!sub) return { status: "ignored", detail: "Assinatura desconhecida" };
  const uid = String(sub.data["uid"] ?? sub.id);
  await recordPayment(sys, uid, sub.data, payment, now);

  let next: DocData = { ...sub.data, updatedAt: now.toISOString() };
  if (payment.status === "approved") {
    const remote = await provider.getSubscription(payment.subscriptionId);
    next = applySubscriptionState(settlePendingPlan(next, plans), { ...remote, status: remote.status === "canceled" ? "canceled" : "active" }, now);
  } else if (payment.status === "rejected" && sub.data["status"] !== "canceled") {
    next["status"] = "past_due";
    next["graceUntil"] = (sub.data["graceUntil"] as string | null) ?? graceUntil(now);
  }
  await saveSubscription(sys, uid, next);
  return { status: "processed", detail: `pagamento ${payment.status}` };
}

async function recordPayment(sys: SystemDb, uid: string, sub: DocData, payment: ProviderPayment, now: Date): Promise<void> {
  // Documento determinístico (id do pagamento): repetir não cria outro registro.
  await sys.commit([
    {
      path: paymentPath(uid, payment.id),
      fields: {
        uid,
        planId: String(sub["planId"] ?? "free"),
        subscriptionId: payment.subscriptionId ?? "",
        amountCents: payment.amountCents,
        status: payment.status,
        createdAt: payment.createdAt,
        updatedAt: now.toISOString(),
      },
    },
  ]);
}
