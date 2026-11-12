import {
  BILLING_GRACE_DAYS,
  DEFAULT_PLANS,
  PLAN_IDS,
  REPORT_LEVELS,
  type PaymentView,
  type PlanConfig,
  type PlanId,
  type SubscriptionStatus,
  type SubscriptionView,
} from "@lifeflow/shared";
import type { DocData } from "../firestore";

export interface Reader {
  get(path: string): Promise<DocData | null>;
}

export const subscriptionPath = (uid: string) => `subscriptions/${uid}`;
export const planPath = (id: string) => `plans/${id}`;
export const paymentPath = (uid: string, id: string) => `users/${uid}/billingPayments/${id}`;

const isPlanId = (value: unknown): value is PlanId => typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);

/** Mescla o documento do banco sobre o padrão do contrato; valores inválidos voltam ao padrão. */
export function mergePlan(id: PlanId, doc: DocData | null): PlanConfig {
  const base = DEFAULT_PLANS[id];
  if (!doc) return base;
  const int = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback);
  return {
    id,
    name: typeof doc["name"] === "string" && doc["name"] ? doc["name"].slice(0, 40) : base.name,
    priceCents: id === "free" ? 0 : int(doc["priceCents"], base.priceCents),
    currency: "BRL",
    aiMessagesPerMonth: int(doc["aiMessagesPerMonth"], base.aiMessagesPerMonth),
    voiceMinutesPerMonth: int(doc["voiceMinutesPerMonth"], base.voiceMinutesPerMonth),
    reports: (REPORT_LEVELS as readonly unknown[]).includes(doc["reports"]) ? (doc["reports"] as PlanConfig["reports"]) : base.reports,
    trialDays: int(doc["trialDays"], base.trialDays),
    active: id === "free" ? true : typeof doc["active"] === "boolean" ? doc["active"] : base.active,
    sortOrder: base.sortOrder,
  };
}

export async function loadPlans(reader: Reader): Promise<Record<PlanId, PlanConfig>> {
  const docs = await Promise.all(PLAN_IDS.map((id) => reader.get(planPath(id))));
  return Object.fromEntries(PLAN_IDS.map((id, i) => [id, mergePlan(id, docs[i] ?? null)])) as Record<PlanId, PlanConfig>;
}

export type SubscriptionDoc = DocData;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Plano EFETIVO agora. Função pura: pagamento pendente não vale; plano cancelado vale até o fim do período
 * pago; inadimplente vale durante a carência; troca para um plano menor só vale a partir da próxima renovação.
 */
export function effectivePlan(sub: SubscriptionDoc | null, now: Date): PlanId {
  if (!sub) return "free";
  const contracted = isPlanId(sub["planId"]) ? sub["planId"] : "free";
  const status = sub["status"];
  const before = (iso: string | null) => iso !== null && now.getTime() < Date.parse(iso);
  switch (status) {
    case "active": {
      const pending = isPlanId(sub["pendingPlanId"]) ? sub["pendingPlanId"] : null;
      const end = str(sub["currentPeriodEnd"]);
      return pending && end && !before(end) ? pending : contracted;
    }
    case "past_due":
      return before(str(sub["graceUntil"])) ? contracted : "free";
    case "canceled":
      return before(str(sub["currentPeriodEnd"])) ? contracted : "free";
    default:
      return "free";
  }
}

export function subscriptionView(sub: SubscriptionDoc | null, plans: Record<PlanId, PlanConfig>, now: Date): SubscriptionView {
  const plan = effectivePlan(sub, now);
  if (!sub) {
    return { plan, status: "none", contractedPlan: "free", pendingPlan: null, priceCents: 0, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, trialEndsAt: null, checkoutUrl: null };
  }
  const contracted = isPlanId(sub["planId"]) ? sub["planId"] : "free";
  const status = (["pending", "active", "past_due", "canceled"] as const).includes(sub["status"] as SubscriptionStatus)
    ? (sub["status"] as SubscriptionStatus)
    : "pending";
  return {
    plan,
    status,
    contractedPlan: contracted,
    pendingPlan: isPlanId(sub["pendingPlanId"]) ? sub["pendingPlanId"] : null,
    priceCents: typeof sub["priceCents"] === "number" ? sub["priceCents"] : plans[contracted].priceCents,
    currentPeriodEnd: str(sub["currentPeriodEnd"]),
    graceUntil: str(sub["graceUntil"]),
    cancelAtPeriodEnd: sub["cancelAtPeriodEnd"] === true,
    trialEndsAt: str(sub["trialEndsAt"]),
    // O link só faz sentido enquanto o pagamento está pendente.
    checkoutUrl: status === "pending" ? str(sub["checkoutUrl"]) : null,
  };
}

export interface Entitlements {
  plan: PlanId;
  config: PlanConfig;
}

/** Plano efetivo e limites do usuário (lidos do banco, com o token do usuário: as regras permitem a leitura). */
export async function getEntitlements(reader: Reader, uid: string, now: Date): Promise<Entitlements> {
  const sub = await reader.get(subscriptionPath(uid));
  const plan = effectivePlan(sub, now);
  const doc = await reader.get(planPath(plan));
  return { plan, config: mergePlan(plan, doc) };
}

export function paymentView(id: string, doc: DocData): PaymentView {
  const status = ["approved", "rejected", "pending", "refunded"].includes(String(doc["status"])) ? (doc["status"] as PaymentView["status"]) : "pending";
  return {
    id,
    planId: isPlanId(doc["planId"]) ? doc["planId"] : "free",
    amountCents: Number(doc["amountCents"] ?? 0),
    status,
    createdAt: String(doc["createdAt"] ?? ""),
  };
}

export const graceUntil = (now: Date): string => new Date(now.getTime() + BILLING_GRACE_DAYS * 86_400_000).toISOString();
