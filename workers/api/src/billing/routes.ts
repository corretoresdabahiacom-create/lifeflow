import {
  ChangePlanRequestSchema,
  CheckoutRequestSchema,
  type PlanConfig,
  type PlanId,
} from "@lifeflow/shared";
import type { Env } from "../env";
import { HttpError } from "../errors";
import type { DocData } from "../firestore";
import { pathsFor, type Ctx } from "../finance/common";
import { allow, json, parseBody } from "../http";
import { createSystemDb, type SystemDb } from "../system";
import { createPaymentProvider, PaymentProviderError, type PaymentProvider } from "./index";
import { applySubscriptionState, providerHttpError, sha } from "./service";
import { loadPlans, paymentView, subscriptionPath, subscriptionView } from "./store";

export interface BillingDeps {
  env: Env;
  fetchImpl: typeof fetch;
  /** Substituto do provedor (testes). */
  payments?: PaymentProvider;
  email?: string;
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export function resolveProvider(deps: Pick<BillingDeps, "env" | "fetchImpl" | "payments">): PaymentProvider {
  if (deps.payments) return deps.payments;
  try {
    return createPaymentProvider(deps.env, deps.fetchImpl);
  } catch (error) {
    throw providerHttpError(error);
  }
}

/** Rotas `/v1/billing/*`. Devolve `null` para caminhos que não são de cobrança. */
export async function handleBilling(ctx: Ctx, deps: BillingDeps): Promise<Response | null> {
  const parts = ctx.url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || parts[1] !== "billing") return null;
  const [, , resource, extra] = parts;
  if (extra !== undefined) throw new HttpError(404, "not_found", "Rota não encontrada");
  const method = ctx.request.method;

  switch (resource) {
    case "plans": {
      allow(method, ["GET"]);
      const plans = await loadPlans(ctx.db);
      const current = await currentView(ctx, plans);
      return json({ plans: Object.values(plans).filter((p) => p.active || p.id === current.contractedPlan).sort((a, b) => a.sortOrder - b.sortOrder), current: current.plan });
    }
    case "subscription": {
      allow(method, ["GET"]);
      const plans = await loadPlans(ctx.db);
      const view = await currentView(ctx, plans);
      return json({ subscription: view, limits: plans[view.plan] });
    }
    case "history": {
      allow(method, ["GET"]);
      const docs = await ctx.db.query(pathsFor(ctx.uid).parent, {
        collection: "billingPayments",
        orderBy: { field: "createdAt", direction: "DESCENDING" },
        limit: 50,
      });
      return json({ payments: docs.map((d) => paymentView(d.id, d.data)) });
    }
    case "checkout": {
      allow(method, ["POST"]);
      return checkout(ctx, deps);
    }
    case "change": {
      allow(method, ["POST"]);
      return changePlan(ctx, deps);
    }
    case "cancel": {
      allow(method, ["POST"]);
      return cancel(ctx, deps);
    }
    case "sync": {
      allow(method, ["POST"]);
      return sync(ctx, deps);
    }
    default:
      throw new HttpError(404, "not_found", "Rota não encontrada");
  }
}

async function currentView(ctx: Ctx, plans: Record<PlanId, PlanConfig>) {
  const sub = await ctx.db.get(subscriptionPath(ctx.uid));
  return subscriptionView(sub, plans, ctx.now());
}

async function system(deps: BillingDeps): Promise<SystemDb> {
  return createSystemDb(deps.env, deps.fetchImpl);
}

async function checkout(ctx: Ctx, deps: BillingDeps): Promise<Response> {
  const key = ctx.request.headers.get("Idempotency-Key");
  if (!key) throw new HttpError(400, "idempotency_key_required", "O cabeçalho Idempotency-Key é obrigatório nesta operação");
  if (!KEY_RE.test(key)) throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key inválida (8 a 128 caracteres: letras, números, _ - : .)");
  const { planId } = await parseBody(ctx.request, CheckoutRequestSchema);
  const now = ctx.now();
  const plans = await loadPlans(ctx.db);
  const plan = plans[planId];
  const keyHash = (await sha(`checkout:${ctx.uid}:${key}:${planId}`)).slice(0, 40);

  const sub = await ctx.db.get(subscriptionPath(ctx.uid));
  const view = subscriptionView(sub, plans, now);
  // Repetição do mesmo pedido: devolve o mesmo link, sem criar outra assinatura no provedor.
  if (sub && sub["checkoutKeyHash"] === keyHash && view.status === "pending" && view.checkoutUrl) {
    return json({ subscription: view, checkoutUrl: view.checkoutUrl });
  }
  if (view.status === "active" || view.status === "past_due" || (view.status === "canceled" && view.plan !== "free")) {
    throw new HttpError(409, "subscription_exists", "Você já tem uma assinatura. Para trocar de plano use a troca; para assinar de novo, aguarde o fim do período atual.");
  }
  if (!plan.active) throw new HttpError(422, "plan_unavailable", "Este plano não está disponível no momento");
  if (plan.priceCents <= 0) throw new HttpError(422, "plan_unavailable", "Este plano não pode ser contratado");
  if (!deps.email) throw new HttpError(422, "email_required", "Sua conta precisa de um e-mail para assinar");
  if (!deps.env.WEB_BASE_URL) throw new HttpError(503, "billing_not_configured", "Cobrança ainda não está configurada");

  const provider = resolveProvider(deps);
  const sys = await system(deps);
  const webUrl = deps.env.WEB_BASE_URL.replace(/\/+$/, "");
  let remote;
  try {
    remote = await provider.createSubscription({
      planId,
      planName: plan.name,
      amountCents: plan.priceCents,
      currency: "BRL",
      payerEmail: deps.email,
      externalReference: ctx.uid,
      backUrl: `${webUrl}/assinatura?retorno=1`,
      notificationUrl: deps.env.API_PUBLIC_URL ? `${deps.env.API_PUBLIC_URL.replace(/\/+$/, "")}/webhooks/mercadopago` : null,
      trialDays: sub === null ? plan.trialDays : 0,
      idempotencyKey: keyHash,
    });
  } catch (error) {
    throw providerHttpError(error);
  }
  if (!remote.checkoutUrl) throw new HttpError(502, "payment_provider_error", "O provedor não devolveu o link de pagamento");

  // Um checkout pendente anterior (abandonado) é cancelado no provedor para não haver duas cobranças possíveis.
  const oldId = sub && sub["status"] === "pending" ? (sub["providerSubscriptionId"] as string | undefined) : undefined;
  const doc: DocData = {
    uid: ctx.uid,
    planId,
    pendingPlanId: null,
    status: "pending",
    providerSubscriptionId: remote.id,
    priceCents: plan.priceCents,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: sub === null && plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * 86_400_000).toISOString() : null,
    checkoutUrl: remote.checkoutUrl,
    checkoutKeyHash: keyHash,
    createdAt: (sub?.["createdAt"] as string | undefined) ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await sys.commit([{ path: subscriptionPath(ctx.uid), fields: doc }]);
  if (oldId && oldId !== remote.id) await provider.cancelSubscription(oldId).catch(() => undefined);
  return json({ subscription: subscriptionView(doc, plans, now), checkoutUrl: remote.checkoutUrl }, 201);
}

async function changePlan(ctx: Ctx, deps: BillingDeps): Promise<Response> {
  const { planId } = await parseBody(ctx.request, ChangePlanRequestSchema);
  const now = ctx.now();
  const plans = await loadPlans(ctx.db);
  const sub = await ctx.db.get(subscriptionPath(ctx.uid));
  if (!sub || sub["status"] !== "active") throw new HttpError(409, "no_active_subscription", "É preciso ter uma assinatura ativa para trocar de plano");
  const target = plans[planId];
  if (!target.active) throw new HttpError(422, "plan_unavailable", "Este plano não está disponível no momento");
  const contracted = String(sub["planId"]) as PlanId;
  const pending = (sub["pendingPlanId"] as string | null) ?? null;
  if (planId === contracted && pending === null) throw new HttpError(409, "same_plan", "Você já está neste plano");
  if (planId === pending) return json({ subscription: subscriptionView(sub, plans, now) });

  const provider = resolveProvider(deps);
  const sys = await system(deps);
  const next: DocData = { ...sub, updatedAt: now.toISOString() };
  const upgrade = target.priceCents > plans[contracted].priceCents;
  try {
    // O preço novo vale a partir da PRÓXIMA cobrança.
    await provider.changeAmount(String(sub["providerSubscriptionId"]), target.priceCents);
  } catch (error) {
    throw providerHttpError(error);
  }
  next["priceCents"] = target.priceCents;
  if (planId === contracted) {
    next["pendingPlanId"] = null; // desistiu do downgrade agendado
  } else if (upgrade) {
    next["planId"] = planId; // upgrade: limites maiores já
    next["pendingPlanId"] = null;
  } else {
    next["pendingPlanId"] = planId; // downgrade: só na próxima renovação
  }
  await sys.commit([{ path: subscriptionPath(ctx.uid), fields: next }]);
  return json({ subscription: subscriptionView(next, plans, now), effective: upgrade || planId === contracted ? "now" : "next_renewal" });
}

async function cancel(ctx: Ctx, deps: BillingDeps): Promise<Response> {
  const now = ctx.now();
  const plans = await loadPlans(ctx.db);
  const sub = await ctx.db.get(subscriptionPath(ctx.uid));
  if (!sub) throw new HttpError(404, "no_subscription", "Você não tem assinatura");
  if (sub["status"] === "canceled") return json({ subscription: subscriptionView(sub, plans, now) });

  const provider = resolveProvider(deps);
  const sys = await system(deps);
  try {
    await provider.cancelSubscription(String(sub["providerSubscriptionId"]));
  } catch (error) {
    // Já inexistente no provedor = já cancelada: seguimos.
    if (!(error instanceof PaymentProviderError && error.kind === "not_found")) throw providerHttpError(error);
  }
  const next: DocData = {
    ...sub,
    status: "canceled",
    cancelAtPeriodEnd: true,
    pendingPlanId: null,
    graceUntil: null,
    currentPeriodEnd: sub["status"] === "pending" ? null : ((sub["currentPeriodEnd"] as string | null) ?? null),
    updatedAt: now.toISOString(),
  };
  await sys.commit([{ path: subscriptionPath(ctx.uid), fields: next }]);
  return json({ subscription: subscriptionView(next, plans, now), message: `Assinatura cancelada. O plano segue até o fim do período já pago.` });
}

/** Consulta o provedor e atualiza a assinatura (útil se o webhook atrasou). Só mexe na assinatura do próprio usuário. */
async function sync(ctx: Ctx, deps: BillingDeps): Promise<Response> {
  const now = ctx.now();
  const plans = await loadPlans(ctx.db);
  const sub = await ctx.db.get(subscriptionPath(ctx.uid));
  if (!sub || typeof sub["providerSubscriptionId"] !== "string") return json({ subscription: subscriptionView(sub, plans, now) });
  const provider = resolveProvider(deps);
  const sys = await system(deps);
  let remote;
  try {
    remote = await provider.getSubscription(sub["providerSubscriptionId"]);
  } catch (error) {
    throw providerHttpError(error);
  }
  if (remote.externalReference !== ctx.uid) throw new HttpError(409, "subscription_mismatch", "A assinatura no provedor não pertence a esta conta");
  const next = applySubscriptionState(sub, remote, now);
  await sys.commit([{ path: subscriptionPath(ctx.uid), fields: next }]);
  return json({ subscription: subscriptionView(next, plans, now) });
}
