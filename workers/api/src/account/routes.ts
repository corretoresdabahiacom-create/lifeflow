import { z } from "zod";
import type { Env } from "../env";
import { HttpError } from "../errors";
import { pathsFor, readAll, type Ctx } from "../finance/common";
import { allow, json, parseBody } from "../http";
import { PaymentProviderError, type PaymentProvider } from "../billing/provider";
import { resolveProvider } from "../billing/routes";
import { providerHttpError } from "../billing/service";
import { log } from "../logger";
import { createUserErasure } from "../system";

export interface AccountDeps {
  env: Env;
  fetchImpl: typeof fetch;
  payments?: PaymentProvider;
  /** Momento (epoch, s) do último login com credencial, do token validado. */
  authTime?: number;
}

/** Login recente exigido para apagar a conta (5 minutos). */
export const RECENT_LOGIN_SECONDS = 300;
export const DELETE_CONFIRMATION = "EXCLUIR MINHA CONTA";
const DeleteRequestSchema = z.object({ confirm: z.literal(DELETE_CONFIRMATION) }).strict();

/** Subcoleções de `users/{uid}` incluídas na exportação (a de mensagens da IA entra dentro das conversas). */
const EXPORT_COLLECTIONS = [
  "accounts",
  "categories",
  "transactions",
  "transfers",
  "payables",
  "recurring",
  "events",
  "eventExceptions",
  "tasks",
  "taskCategories",
  "reminders",
  "notifications",
  "aiActions",
  "aiLogs",
  "aiUsage",
  "aiDaily",
  "billingPayments",
  "preferences",
  "consents",
] as const;
const MAX_PER_COLLECTION = 5000;

/** Rotas `/v1/account/*`: exportação completa dos dados e exclusão da conta. */
export async function handleAccount(ctx: Ctx, deps: AccountDeps): Promise<Response | null> {
  const parts = ctx.url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "account") return null;
  const [, , resource, extra] = parts;
  if (extra !== undefined) throw new HttpError(404, "not_found", "Rota não encontrada");
  switch (resource) {
    case "export":
      allow(ctx.request.method, ["GET"]);
      return exportData(ctx);
    case "delete":
      allow(ctx.request.method, ["POST"]);
      return deleteAccount(ctx, deps);
    default:
      throw new HttpError(404, "not_found", "Rota não encontrada");
  }
}

async function exportData(ctx: Ctx): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const truncated: string[] = [];
  const data: Record<string, unknown> = {};

  data["profile"] = await ctx.db.get(p.profile);
  for (const collection of EXPORT_COLLECTIONS) {
    const { docs, truncated: cut } = await readAll(ctx.db, p.parent, { collection }, MAX_PER_COLLECTION);
    if (cut) truncated.push(collection);
    data[collection] = docs.map((d) => ({ id: d.id, ...d.data }));
  }

  const conversations = await readAll(ctx.db, p.parent, { collection: "aiConversations" }, MAX_PER_COLLECTION);
  if (conversations.truncated) truncated.push("aiConversations");
  data["aiConversations"] = await Promise.all(
    conversations.docs.map(async (c) => {
      const messages = await readAll(ctx.db, p.aiMessagesParent(c.id), { collection: "messages", orderBy: { field: "createdAt", direction: "ASCENDING" } }, MAX_PER_COLLECTION);
      if (messages.truncated) truncated.push(`aiConversations/${c.id}/messages`);
      return { id: c.id, ...c.data, messages: messages.docs.map((m) => ({ id: m.id, ...m.data })) };
    }),
  );

  const subscription = await ctx.db.get(`subscriptions/${ctx.uid}`);
  data["subscription"] = subscription ? stripInternal(subscription) : null;

  const exportedAt = ctx.now().toISOString();
  const body = JSON.stringify({ format: "lifeflow-export", version: 1, exportedAt, uid: ctx.uid, truncated, data }, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="lifeflow-dados-${exportedAt.slice(0, 10)}.json"`,
    },
  });
}

/** Campos técnicos da assinatura (id no provedor, hash de chave) não são dado do usuário. */
function stripInternal(sub: Record<string, unknown>): Record<string, unknown> {
  const { providerSubscriptionId: _p, checkoutKeyHash: _k, checkoutUrl: _c, ...rest } = sub;
  return rest;
}

async function deleteAccount(ctx: Ctx, deps: AccountDeps): Promise<Response> {
  await parseBody(ctx.request, DeleteRequestSchema);
  const nowSeconds = Math.floor(ctx.now().getTime() / 1000);
  if (deps.authTime === undefined || nowSeconds - deps.authTime > RECENT_LOGIN_SECONDS) {
    throw new HttpError(401, "recent_login_required", "Confirme sua senha novamente para excluir a conta");
  }

  // 1) Encerra a cobrança ANTES de apagar: se o provedor falhar, nada é apagado e o usuário pode tentar de novo.
  const sub = await ctx.db.get(`subscriptions/${ctx.uid}`);
  const providerId = typeof sub?.["providerSubscriptionId"] === "string" ? sub["providerSubscriptionId"] : null;
  if (providerId && sub?.["status"] !== "canceled") {
    const provider = resolveProvider({ env: deps.env, fetchImpl: deps.fetchImpl, ...(deps.payments ? { payments: deps.payments } : {}) });
    try {
      await provider.cancelSubscription(providerId);
    } catch (error) {
      if (!(error instanceof PaymentProviderError && error.kind === "not_found")) throw providerHttpError(error);
    }
  }

  // 2) Apaga tudo do próprio usuário.
  const erasure = await createUserErasure(deps.env, deps.fetchImpl, ctx.uid);
  const documents = await erasure.eraseAll();
  log("info", "account_deleted", { requestId: "account", uid: ctx.uid, documents });
  return json({ deleted: true, documents });
}
