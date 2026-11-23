import { defineBillingSuite, FakePayments, type BillingWorld, type BillingWorldOptions } from "./billing.suite";
import { ScriptedLLM, ScriptedSTT } from "./ai.suite";
import { Client } from "./finance.suite";
import { makeApp, type Clock, type Signer } from "./helpers";
import { defineAccountSuite } from "./account.suite";
import { defineSecuritySuite } from "./security.suite";
import { createStackUser, stackEnv, stackRaw, stackSystemDb } from "./stack";

/** Mesmas suítes contra o Supabase REAL. Execução: `pnpm test:integration`. */
async function stackWorld(_signer: Signer, options: BillingWorldOptions): Promise<BillingWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const payments = new FakePayments();
  const envOverride = {
    ...stackEnv,
    PAYMENT_PROVIDER: "mercadopago",
    WEB_BASE_URL: "https://app.lifeflow.test",
    API_PUBLIC_URL: "https://api.lifeflow.test",
  };
  const app = makeApp(null, fetch, envOverride, clock, { llm, stt, payments });
  const [a, b, admin] = await Promise.all([
    createStackUser("userA", options.noEmailForA ? { noEmail: true } : {}),
    createStackUser("userB"),
    createStackUser("admin", { admin: true }),
  ]);
  return {
    clock,
    payments,
    llm,
    stt,
    A: new Client(app, a.token),
    B: new Client(app, b.token),
    Admin: new Client(app, admin.token),
    uidA: a.uid,
    uidB: b.uid,
    app,
    raw: stackRaw(),
    sys: () => stackSystemDb(),
  };
}

defineBillingSuite("assinaturas, limites e painel admin (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { fake: false });

defineAccountSuite("exportação e exclusão de conta (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { rawClient: (w) => w.raw, fake: false });

defineSecuritySuite("segurança e isolamento entre usuários (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { fake: false });
