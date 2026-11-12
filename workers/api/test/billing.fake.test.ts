import { defineBillingSuite, FakePayments, type BillingWorld, type BillingWorldOptions } from "./billing.suite";
import { ScriptedLLM, ScriptedSTT } from "./ai.suite";
import { Client } from "./finance.suite";
import { env, fakeFirestore, makeApp, signToken, uidOfToken, type Clock, type Signer } from "./helpers";
import { createSystemDb } from "../src/system";

async function fakeWorld(signer: Signer, options: BillingWorldOptions): Promise<BillingWorld> {
  const fake = fakeFirestore();
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetchImpl(input, init)) as typeof fetch;
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const payments = new FakePayments();
  const envOverride = { PAYMENT_PROVIDER: "mercadopago", WEB_BASE_URL: "https://app.lifeflow.test", API_PUBLIC_URL: "https://api.lifeflow.test" };
  const app = makeApp(signer, fetchImpl, envOverride, clock, { llm, stt, payments });
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const a = await signToken(signer, { uid: `userA_${suffix}`, email: options.noEmailForA ? "" : "user@example.com" });
  const b = await signToken(signer, { uid: `userB_${suffix}`, email: "bia@example.com" });
  const admin = await signToken(signer, { uid: `admin_${suffix}`, email: "admin@example.com", admin: true });
  return {
    fake,
    clock,
    payments,
    llm,
    stt,
    A: new Client(app, a),
    B: new Client(app, b),
    Admin: new Client(app, admin),
    uidA: uidOfToken(a),
    uidB: uidOfToken(b),
    app,
    sys: () => createSystemDb({ ...env, ...envOverride }, fetchImpl),
  };
}

defineBillingSuite("assinaturas, limites e painel admin (Firestore falso em memória)", fakeWorld, { fake: true });
