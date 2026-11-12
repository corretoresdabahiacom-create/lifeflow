import { z } from "zod";
import { IdSchema } from "./finance";

// ---- Ferramentas que a IA pode usar (E2 do contrato). Qualquer outro nome é recusado. ----
export const AI_TOOL_NAMES = [
  // Financeiro
  "get_accounts",
  "get_balance",
  "create_transaction",
  "update_transaction",
  "delete_transaction",
  "list_transactions",
  "get_financial_summary",
  "list_payments",
  "mark_payment_as_paid",
  "list_categories",
  // Agenda
  "create_event",
  "update_event",
  "delete_event",
  "list_events",
  "check_schedule_conflicts",
  // Tarefas
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "list_tasks",
  // Lembretes
  "create_reminder",
  "update_reminder",
  "list_reminders",
] as const;
export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export const AI_MESSAGE_MAX_CHARS = 2000;
/** Mensagens anteriores enviadas ao modelo como contexto. */
export const AI_HISTORY_MESSAGES = 12;
/** Rodadas de ferramentas por mensagem do usuário (limite contra laços). */
export const AI_MAX_STEPS = 5;
/** Validade de uma ação aguardando confirmação. */
export const AI_ACTION_TTL_MINUTES = 15;

// ---- Planos (E/J do contrato). Fonte final: configuração comercial no banco (Fase 5). ----
export const PLAN_IDS = ["free", "pro", "premium_ai"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export interface PlanAiLimits {
  aiMessagesPerMonth: number;
  voiceMinutesPerMonth: number;
}
/** Valores iniciais do contrato. Na Fase 5 passam a vir da configuração comercial armazenada. */
export const DEFAULT_PLAN_AI_LIMITS: Record<PlanId, PlanAiLimits> = {
  free: { aiMessagesPerMonth: 30, voiceMinutesPerMonth: 0 },
  pro: { aiMessagesPerMonth: 300, voiceMinutesPerMonth: 30 },
  premium_ai: { aiMessagesPerMonth: 1000, voiceMinutesPerMonth: 120 },
};

// ---- Voz ----
export const AI_AUDIO_MAX_BYTES = 1_500_000;
export const AI_AUDIO_MAX_SECONDS = 60;
/** A Groq cobra no mínimo 10 s por requisição; o consumo debitado segue essa regra. */
export const AI_AUDIO_MIN_BILLED_SECONDS = 10;

export const AiConsentSchema = z.object({ audio: z.boolean() }).strict();

// ---- Entradas ----
export const AiChatRequestSchema = z
  .object({
    conversationId: IdSchema.optional(),
    message: z.string().trim().min(1, "Escreva uma mensagem").max(AI_MESSAGE_MAX_CHARS),
  })
  .strict();
export type AiChatRequest = z.infer<typeof AiChatRequestSchema>;

/** Limites de automação do usuário (E4). Valores em centavos. */
export const AiSettingsSchema = z
  .object({
    /** Ações executadas sem confirmação por dia. 0 = sempre confirmar. */
    autoActionsPerDay: z.number().int().min(0).max(100),
    /** Valor acumulado por dia em ações financeiras automáticas. */
    autoValueLimitCents: z.number().int().min(0).max(10_000_000),
    /** Acima deste valor a confirmação é reforçada (e nunca automática). */
    confirmAboveCents: z.number().int().min(0).max(10_000_000),
  })
  .strict();
export type AiSettings = z.infer<typeof AiSettingsSchema>;
export const DEFAULT_AI_SETTINGS: AiSettings = {
  autoActionsPerDay: 20,
  autoValueLimitCents: 100_000,
  confirmAboveCents: 50_000,
};

export const AiConfirmSchema = z
  .object({
    /** Exigido quando a ação é de confirmação reforçada (valor acima do limite do usuário). */
    reinforced: z.boolean().optional(),
  })
  .strict();

// ---- Saídas ----
export const AI_ACTION_STATUSES = ["pending", "executing", "done", "rejected", "failed", "expired", "blocked"] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];

export interface AiActionView {
  id: string;
  tool: AiToolName;
  /** Resumo montado pelo backend a partir dos parâmetros congelados (não vem do modelo). */
  summary: string;
  status: AiActionStatus;
  reinforced: boolean;
  /** Presente quando a ação foi concluída, falhou ou foi bloqueada. */
  resultNote: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface AiMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AiUsageView {
  month: string;
  messages: number;
  messagesLimit: number;
  voiceSeconds: number;
  voiceSecondsLimit: number;
  plan: PlanId;
}

export interface AiChatReply {
  conversationId: string;
  reply: AiMessageView;
  actions: AiActionView[];
  usage: AiUsageView;
}
