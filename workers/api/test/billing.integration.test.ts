import { defineBillingSuite, FakePayments, type BillingWorld, type BillingWorldOptions } from "./billing.suite";
import { ScriptedLLM, ScriptedSTT } from "./ai.suite";
import { Client } from "./finance.suite";
import { env, makeApp, signToken, uidOfToken, type Clock, type Signer } from "./helpers";
import { createSystemDb } from "../src/system";

/** Mesma suíte contra o EMULADOR REAL do Firestore. Execução: `pnpm test:integration`. */
const host = process.env["FIRESTORE_EMULATOR_HOST"];
if (!host) {
  throw new Error("FIRESTORE_EMULATOR_HOST ausente: rode `pnpm test:integration` (ele inicia o emulador).");
}

async function emulatorWorld(signer: Signer, options: BillingWorldOptions): Promise<BillingWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const payments = new FakePayments();
  const envOverride = {
    FIRESTORE_BASE_URL: `http://${host}`,
    PAYMENT_PROVIDER: "mercadopago",
    WEB_BASE_URL: "https://app.lifeflow.test",
    API_PUBLIC_URL: "https://api.lifeflow.test",
  };
  const app = makeApp(signer, fetch, envOverride, clock, { llm, stt, payments });
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const a = await signToken(signer, { uid: `userA_${suffix}`, email: options.noEmailForA ? "" : "user@example.com" });
  const b = await signToken(signer, { uid: `userB_${suffix}`, email: "bia@example.com" });
  const admin = await signToken(signer, { uid: `admin_${suffix}`, email: "admin@example.com", admin: true });
  return {
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
    sys: () => createSystemDb({ ...env, ...envOverride }, fetch),
  };
}

defineBillingSuite("assinaturas, limites e painel admin (emulador real do Firestore + Security Rules)", emulatorWorld, { fake: false });
