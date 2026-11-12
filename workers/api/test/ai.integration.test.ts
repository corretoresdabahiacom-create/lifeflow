import { defineAiSuite, ScriptedLLM, ScriptedSTT, type AiWorld, type AiWorldOptions } from "./ai.suite";
import { Client, tokensFor } from "./finance.suite";
import { grantPlan, makeApp, uidOfToken, type Clock, type Signer } from "./helpers";

/**
 * Mesma suíte do assistente contra o EMULADOR REAL do Firestore, com as Security Rules reais.
 * Execução: `pnpm test:integration` (sobe o emulador).
 */
const host = process.env["FIRESTORE_EMULATOR_HOST"];
if (!host) {
  throw new Error("FIRESTORE_EMULATOR_HOST ausente: rode `pnpm test:integration` (ele inicia o emulador).");
}

async function emulatorWorld(signer: Signer, options: AiWorldOptions): Promise<AiWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const app = makeApp(
    signer,
    fetch,
    { FIRESTORE_BASE_URL: `http://${host}` },
    clock,
    { ...(options.noLlm ? {} : { llm }), stt },
  );
  const { a, b } = await tokensFor(signer);
  if (options.plan) await grantPlan(fetch, `http://${host}`, uidOfToken(a), options.plan);
  return { clock, llm, stt, A: new Client(app, a), B: new Client(app, b) };
}

defineAiSuite("assistente de IA (emulador real do Firestore + Security Rules)", emulatorWorld, { fake: false });
