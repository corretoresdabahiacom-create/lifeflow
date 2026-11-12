import { PLAN_IDS, PlanConfigInputSchema, type PlanId } from "@lifeflow/shared";
import type { Env } from "../env";
import { HttpError } from "../errors";
import type { DocData } from "../firestore";
import { allow, json, parseBody } from "../http";
import { loadPlans, mergePlan, paymentView, subscriptionPath } from "../billing/store";
import type { SystemDb } from "../system";

/** Estimativa de custo da IA (USD por 1 M de tokens e por hora de áudio) — valores lidos em COSTS.md, sujeitos a mudança. */
export const COST_ESTIMATE = { inputPerMillion: 0.15, outputPerMillion: 0.6, voicePerHour: 0.04 };

export interface AdminCtx {
  request: Request;
  url: URL;
  uid: string;
  email?: string;
  now: () => Date;
  sys: SystemDb;
  env: Env;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Registro de auditoria administrativo (só inclusão). Falha ao gravar NEGA a operação de escrita. */
async function audit(ctx: AdminCtx, action: string, target: string, detail = ""): Promise<void> {
  const id = crypto.randomUUID().replace(/-/g, "");
  await ctx.sys.commit([
    {
      path: `adminLogs/${id}`,
      fields: { adminUid: ctx.uid, action, target: target.slice(0, 120), detail: detail.slice(0, 300), createdAt: ctx.now().toISOString() },
      precondition: { exists: false },
    },
  ]);
}

const intParam = (url: URL, name: string, fallback: number, min: number, max: number): number => {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "invalid_query", `Parâmetro ${name} inválido`);
  return n;
};

/**
 * Painel administrativo (`/v1/admin/*`). Exige a claim `admin` (verificada no servidor) e é auditado.
 * O administrador NÃO tem acesso ao conteúdo financeiro dos clientes: o caminho privilegiado só alcança
 * assinaturas, planos, logs e AGREGADOS de consumo (ver `system.ts`).
 */
export async function handleAdmin(ctx: AdminCtx): Promise<Response> {
  const parts = ctx.url.pathname.split("/").filter(Boolean); // v1 admin <resource> [id]
  const [, , resource, id, extra] = parts;
  const method = ctx.request.method;
  if (extra !== undefined) throw new HttpError(404, "not_found", "Rota não encontrada");

  switch (resource) {
    case "overview": {
      allow(method, ["GET"]);
      await audit(ctx, "overview.read", "overview");
      return json(await overview(ctx));
    }
    case "plans": {
      if (id === undefined) {
        allow(method, ["GET"]);
        await audit(ctx, "plans.read", "plans");
        return json({ plans: Object.values(await loadPlans(ctx.sys)) });
      }
      if (!(PLAN_IDS as readonly string[]).includes(id)) throw new HttpError(404, "not_found", "Plano não encontrado");
      allow(method, ["PUT"]);
      const input = await parseBody(ctx.request, PlanConfigInputSchema);
      if (id === "free" && (input.priceCents !== 0 || !input.active)) {
        throw new HttpError(422, "invalid_plan", "O plano Free deve custar R$ 0 e permanecer ativo");
      }
      const before = mergePlan(id as PlanId, await ctx.sys.get(`plans/${id}`));
      const now = ctx.now().toISOString();
      await audit(ctx, "plans.update", id, `preço ${before.priceCents}→${input.priceCents}; msgs ${before.aiMessagesPerMonth}→${input.aiMessagesPerMonth}; voz ${before.voiceMinutesPerMonth}→${input.voiceMinutesPerMonth}`);
      await ctx.sys.commit([{ path: `plans/${id}`, fields: { ...input, updatedAt: now, updatedBy: ctx.uid } }]);
      return json({ plan: mergePlan(id as PlanId, await ctx.sys.get(`plans/${id}`)) });
    }
    case "subscriptions": {
      allow(method, ["GET"]);
      if (id !== undefined) {
        if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id", "Identificador inválido");
        await audit(ctx, "subscription.read", id);
        const sub = await ctx.sys.get(subscriptionPath(id));
        if (!sub) throw new HttpError(404, "not_found", "Assinatura não encontrada");
        const payments = await ctx.sys.query(`users/${id}`, { collection: "billingPayments", orderBy: { field: "createdAt", direction: "DESCENDING" }, limit: 50 });
        return json({ subscription: publicSub(sub), payments: payments.map((p) => paymentView(p.id, p.data)) });
      }
      const filters: Array<{ field: string; op: "EQUAL"; value: string }> = [];
      const status = ctx.url.searchParams.get("status");
      const plan = ctx.url.searchParams.get("plan");
      if (status) filters.push({ field: "status", op: "EQUAL", value: status });
      if (plan) filters.push({ field: "planId", op: "EQUAL", value: plan });
      await audit(ctx, "subscriptions.list", "subscriptions", `status=${status ?? ""} plan=${plan ?? ""}`);
      const docs = await ctx.sys.query("", { collection: "subscriptions", filters, limit: intParam(ctx.url, "limit", 50, 1, 200) });
      return json({ subscriptions: docs.map((d) => publicSub(d.data)) });
    }
    case "usage": {
      allow(method, ["GET"]);
      const month = ctx.url.searchParams.get("month") ?? ctx.now().toISOString().slice(0, 7);
      if (!MONTH_RE.test(month)) throw new HttpError(400, "invalid_query", "month deve ser AAAA-MM");
      await audit(ctx, "usage.read", month);
      return json({ month, ...(await aiUsage(ctx, month)) });
    }
    case "logs": {
      allow(method, ["GET"]);
      const kind = ctx.url.searchParams.get("kind") ?? "admin";
      if (kind !== "admin" && kind !== "webhooks") throw new HttpError(400, "invalid_query", "kind deve ser admin ou webhooks");
      await audit(ctx, "logs.read", kind);
      const collection = kind === "admin" ? "adminLogs" : "webhookEvents";
      const docs = await ctx.sys.query("", {
        collection,
        orderBy: { field: kind === "admin" ? "createdAt" : "receivedAt", direction: "DESCENDING" },
        limit: intParam(ctx.url, "limit", 50, 1, 200),
      });
      return json({ kind, logs: docs.map((d) => ({ id: d.id, ...d.data })) });
    }
    case "integrations": {
      allow(method, ["GET"]);
      await audit(ctx, "integrations.read", "integrations");
      const e = ctx.env;
      // Só informa se está configurado — nunca o valor.
      return json({
        integrations: [
          { name: "LLM (DeepSeek)", configured: Boolean(e.DEEPSEEK_API_KEY), model: e.LLM_MODEL ?? "deepseek-flash" },
          { name: "Transcrição (Groq)", configured: Boolean(e.GROQ_API_KEY), model: e.STT_MODEL ?? "whisper-large-v3-turbo" },
          { name: "Pagamentos (Mercado Pago)", configured: Boolean(e.MERCADOPAGO_ACCESS_TOKEN), webhookSecret: Boolean(e.MERCADOPAGO_WEBHOOK_SECRET) },
          { name: "Credencial de serviço (Firebase)", configured: Boolean(e.GOOGLE_SERVICE_ACCOUNT_JSON || e.FIRESTORE_BASE_URL) },
          { name: "E-mail (Resend)", configured: false, note: "Não implementado" },
          { name: "Web Push", configured: false, note: "Não implementado" },
        ],
        note: "Chaves e modelos são definidos no ambiente do Worker (secrets); esta tela só mostra o estado.",
      });
    }
    default:
      throw new HttpError(404, "not_found", "Rota não encontrada");
  }
}

function publicSub(sub: DocData) {
  return {
    uid: sub["uid"],
    planId: sub["planId"],
    pendingPlanId: sub["pendingPlanId"] ?? null,
    status: sub["status"],
    priceCents: sub["priceCents"],
    currentPeriodEnd: sub["currentPeriodEnd"] ?? null,
    graceUntil: sub["graceUntil"] ?? null,
    cancelAtPeriodEnd: sub["cancelAtPeriodEnd"] === true,
    createdAt: sub["createdAt"],
    updatedAt: sub["updatedAt"],
  };
}

async function aiUsage(ctx: AdminCtx, month: string) {
  const docs = await ctx.sys.group({
    collection: "aiUsage",
    filters: [
      { field: "updatedAt", op: "GREATER_THAN_OR_EQUAL", value: `${month}-01` },
    ],
    limit: 1000,
  });
  const mine = docs.filter((d) => d.path.endsWith(`/aiUsage/${month}`));
  const sum = (key: string) => mine.reduce((total, d) => total + Number(d.data[key] ?? 0), 0);
  const messages = sum("messages");
  const voiceSeconds = sum("voiceSeconds");
  const inputTokens = sum("inputTokens");
  const outputTokens = sum("outputTokens");
  const estimatedCostUsd =
    (inputTokens / 1e6) * COST_ESTIMATE.inputPerMillion + (outputTokens / 1e6) * COST_ESTIMATE.outputPerMillion + (voiceSeconds / 3600) * COST_ESTIMATE.voicePerHour;
  return {
    activeUsers: mine.length,
    messages,
    voiceSeconds,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 10_000) / 10_000,
    costNote: "Estimativa com os preços de docs/COSTS.md; não é a fatura do provedor.",
    truncated: docs.length >= 1000,
  };
}

async function overview(ctx: AdminCtx) {
  const now = ctx.now();
  const month = now.toISOString().slice(0, 7);
  const [users, subs, usage, failedWebhooks, providerErrors] = await Promise.all([
    ctx.sys.count("users"),
    ctx.sys.query("", { collection: "subscriptions", limit: 1000 }),
    aiUsage(ctx, month),
    ctx.sys.query("", { collection: "webhookEvents", filters: [{ field: "status", op: "EQUAL", value: "failed" }], limit: 100 }),
    ctx.sys
      .group({ collection: "aiLogs", filters: [{ field: "event", op: "EQUAL", value: "provider_error" }, { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: `${month}-01` }], limit: 1000 })
      .then((d) => d.length),
  ]);
  const byStatus: Record<string, number> = {};
  const byPlan: Record<string, number> = {};
  let mrrCents = 0;
  let canceledLast30d = 0;
  const since = now.getTime() - 30 * 86_400_000;
  for (const { data } of subs) {
    const status = String(data["status"]);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status === "active" || status === "past_due") {
      byPlan[String(data["planId"])] = (byPlan[String(data["planId"])] ?? 0) + 1;
      if (status === "active") mrrCents += Number(data["priceCents"] ?? 0);
    }
    if (status === "canceled" && Date.parse(String(data["updatedAt"])) >= since) canceledLast30d += 1;
  }
  return {
    month,
    users: { total: users },
    activity: { aiActiveUsersThisMonth: usage.activeUsers },
    subscriptions: { byStatus, activeByPlan: byPlan, mrrCents, canceledLast30d, truncated: subs.length >= 1000 },
    ai: usage,
    errors: { aiProviderErrorsThisMonth: providerErrors, failedWebhooks: failedWebhooks.length },
    notifications: { available: false, note: "Notificações (Web Push/e-mail) ainda não implementadas" },
  };
}
