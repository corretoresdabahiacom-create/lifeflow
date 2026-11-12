import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_PLAN_AI_LIMITS,
  PLAN_IDS,
  type AiActionStatus,
  type AiActionView,
  type AiSettings,
  type AiToolName,
  type AiUsageView,
  type PlanId,
} from "@lifeflow/shared";
import { todayInTimeZone } from "@lifeflow/shared";
import type { Env } from "../env";
import type { DocData } from "../firestore";
import { pathsFor, profileTimeZone, sha256Hex, type Ctx } from "../finance/common";

/** Registro de auditoria (append-only): quem pediu o quê, o que foi proposto e o que de fato aconteceu. */
export type AiLogEvent =
  | "proposed"
  | "auto_executed"
  | "confirmed"
  | "executed"
  | "failed"
  | "rejected"
  | "blocked"
  | "expired"
  | "unauthorized_tool"
  | "invalid_args"
  | "provider_error";

export async function writeLog(
  ctx: Ctx,
  entry: {
    event: AiLogEvent;
    tool?: string | null;
    actionId?: string | null;
    argsHash?: string | null;
    detail?: string;
    conversationId?: string | null;
  },
): Promise<void> {
  // Determinístico por (ação, evento): repetir o mesmo passo não duplica a trilha.
  const id = entry.actionId
    ? (await sha256Hex(`ailog:${entry.actionId}:${entry.event}`)).slice(0, 40)
    : (await sha256Hex(`ailog:${crypto.randomUUID()}`)).slice(0, 40);
  const doc: DocData = {
    uid: ctx.uid,
    event: entry.event,
    tool: entry.tool ?? null,
    actionId: entry.actionId ?? null,
    argsHash: entry.argsHash ?? null,
    detail: (entry.detail ?? "").slice(0, 300),
    conversationId: entry.conversationId ?? null,
    createdAt: ctx.now().toISOString(),
  };
  try {
    await ctx.db.commit([{ path: pathsFor(ctx.uid).aiLog(id), fields: doc, precondition: { exists: false } }]);
  } catch {
    // A trilha nunca derruba a operação do usuário; a duplicata (já registrada) também é aceitável.
  }
}

// ---- Plano e consumo ----

export function resolvePlan(env: Env): PlanId {
  const wanted = env.AI_DEFAULT_PLAN ?? "free";
  return (PLAN_IDS as readonly string[]).includes(wanted) ? (wanted as PlanId) : "free";
}

export async function monthKey(ctx: Ctx): Promise<{ month: string; today: string; timeZone: string }> {
  const timeZone = await profileTimeZone(ctx);
  const today = todayInTimeZone(ctx.now(), timeZone);
  return { month: today.slice(0, 7), today, timeZone };
}

export async function readUsage(ctx: Ctx, env: Env): Promise<AiUsageView> {
  const { month } = await monthKey(ctx);
  const doc = await ctx.db.get(pathsFor(ctx.uid).aiUsage(month));
  const plan = resolvePlan(env);
  const limits = DEFAULT_PLAN_AI_LIMITS[plan];
  return {
    month,
    messages: Number(doc?.["messages"] ?? 0),
    messagesLimit: limits.aiMessagesPerMonth,
    voiceSeconds: Number(doc?.["voiceSeconds"] ?? 0),
    voiceSecondsLimit: limits.voiceMinutesPerMonth * 60,
    plan,
  };
}

export async function addUsage(
  ctx: Ctx,
  delta: { messages?: number; voiceSeconds?: number; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  const { month } = await monthKey(ctx);
  const increments: Record<string, number> = {};
  for (const [key, value] of Object.entries(delta)) if (value) increments[key] = value;
  if (Object.keys(increments).length === 0) return;
  await ctx.db.commit([
    {
      path: pathsFor(ctx.uid).aiUsage(month),
      fields: { uid: ctx.uid, updatedAt: ctx.now().toISOString() },
      increments,
    },
  ]);
}

export interface DailyAuto {
  autoActions: number;
  autoValueCents: number;
}

export async function readDaily(ctx: Ctx): Promise<{ date: string; daily: DailyAuto }> {
  const { today } = await monthKey(ctx);
  const doc = await ctx.db.get(pathsFor(ctx.uid).aiDaily(today));
  return {
    date: today,
    daily: { autoActions: Number(doc?.["autoActions"] ?? 0), autoValueCents: Number(doc?.["autoValueCents"] ?? 0) },
  };
}

export async function readSettings(ctx: Ctx): Promise<AiSettings> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).aiSettings);
  if (!doc) return DEFAULT_AI_SETTINGS;
  const num = (key: keyof AiSettings): number => (typeof doc[key] === "number" ? (doc[key] as number) : DEFAULT_AI_SETTINGS[key]);
  return {
    autoActionsPerDay: num("autoActionsPerDay"),
    autoValueLimitCents: num("autoValueLimitCents"),
    confirmAboveCents: num("confirmAboveCents"),
  };
}

export function actionView(id: string, d: DocData): AiActionView {
  return {
    id,
    tool: String(d["tool"]) as AiToolName,
    summary: String(d["summary"] ?? ""),
    status: String(d["status"]) as AiActionStatus,
    reinforced: d["reinforced"] === true,
    resultNote: typeof d["resultNote"] === "string" ? d["resultNote"] : null,
    expiresAt: String(d["expiresAt"] ?? ""),
    createdAt: String(d["createdAt"] ?? ""),
  };
}
