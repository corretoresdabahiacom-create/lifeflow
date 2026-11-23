import { defineAiSuite, ScriptedLLM, ScriptedSTT, type AiWorld, type AiWorldOptions } from "./ai.suite";
import { Client } from "./finance.suite";
import { grantPlan, makeApp, type Clock, type Signer } from "./helpers";
import { createStackUser, stackEnv } from "./stack";

/** Mesma suíte do assistente contra o Supabase REAL. Execução: `pnpm test:integration`. */
async function stackWorld(_signer: Signer, options: AiWorldOptions): Promise<AiWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const app = makeApp(null, fetch, stackEnv, clock, { ...(options.noLlm ? {} : { llm }), stt });
  const [a, b] = await Promise.all([createStackUser("userA"), createStackUser("userB")]);
  if (options.plan) await grantPlan(fetch, stackEnv.SUPABASE_URL as string, a.uid, options.plan, {}, stackEnv.SUPABASE_SECRET_KEY);
  return { clock, llm, stt, A: new Client(app, a.token), B: new Client(app, b.token) };
}

defineAiSuite("assistente de IA (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { fake: false });
