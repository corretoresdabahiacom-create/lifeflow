import { z } from "zod";
import { type PlanId } from "./ai";

/** Níveis de relatório do contrato (Parte H). Hoje só são EXPOSTOS: nenhum relatório é bloqueado por eles. */
export const REPORT_LEVELS = ["basic", "full", "smart"] as const;
export type ReportLevel = (typeof REPORT_LEVELS)[number];

export const PAID_PLAN_IDS = ["pro", "premium_ai"] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/** Configuração comercial de um plano (documento `plans/{id}` no banco). */
export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Preço mensal em centavos (configurável pelo administrador). */
  priceCents: number;
  currency: "BRL";
  aiMessagesPerMonth: number;
  voiceMinutesPerMonth: number;
  reports: ReportLevel;
  /** Dias de teste gratuito, quando o provedor suporta (0 = sem teste). */
  trialDays: number;
  active: boolean;
  sortOrder: number;
}

/** Valores iniciais do contrato (Parte H). Usados quando o administrador ainda não gravou a configuração. */
export const DEFAULT_PLANS: Record<PlanId, PlanConfig> = {
  free: { id: "free", name: "Free", priceCents: 0, currency: "BRL", aiMessagesPerMonth: 30, voiceMinutesPerMonth: 0, reports: "basic", trialDays: 0, active: true, sortOrder: 0 },
  pro: { id: "pro", name: "Pro", priceCents: 1490, currency: "BRL", aiMessagesPerMonth: 300, voiceMinutesPerMonth: 30, reports: "full", trialDays: 0, active: true, sortOrder: 1 },
  premium_ai: { id: "premium_ai", name: "Premium AI", priceCents: 2990, currency: "BRL", aiMessagesPerMonth: 1000, voiceMinutesPerMonth: 120, reports: "smart", trialDays: 0, active: true, sortOrder: 2 },
};

/** Edição de plano pelo administrador. `free` não pode ter preço. */
export const PlanConfigInputSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    priceCents: z.number().int().min(0).max(10_000_00),
    aiMessagesPerMonth: z.number().int().min(0).max(100_000),
    voiceMinutesPerMonth: z.number().int().min(0).max(10_000),
    reports: z.enum(REPORT_LEVELS),
    trialDays: z.number().int().min(0).max(90),
    active: z.boolean(),
  })
  .strict();
export type PlanConfigInput = z.infer<typeof PlanConfigInputSchema>;

export const SUBSCRIPTION_STATUSES = ["pending", "active", "past_due", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Dias em que o plano pago continua valendo depois de uma cobrança que falhou (inadimplência). */
export const BILLING_GRACE_DAYS = 3;

/** Assinatura como o usuário a vê (sem identificadores internos do provedor). */
export interface SubscriptionView {
  /** Plano EFETIVO agora (já considera período pago, carência e troca agendada). */
  plan: PlanId;
  /** `none` = nunca assinou. */
  status: SubscriptionStatus | "none";
  /** Plano contratado (pode diferir do efetivo, ex.: pagamento pendente). */
  contractedPlan: PlanId;
  pendingPlan: PlanId | null;
  priceCents: number;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  checkoutUrl: string | null;
}

export interface PaymentView {
  id: string;
  planId: PlanId;
  amountCents: number;
  status: "approved" | "rejected" | "pending" | "refunded";
  createdAt: string;
}

export const CheckoutRequestSchema = z.object({ planId: z.enum(PAID_PLAN_IDS) }).strict();
export const ChangePlanRequestSchema = z.object({ planId: z.enum(PAID_PLAN_IDS) }).strict();
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

