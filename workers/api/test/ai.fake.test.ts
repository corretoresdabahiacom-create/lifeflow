import { defineAiSuite, ScriptedLLM, ScriptedSTT, type AiWorld, type AiWorldOptions } from "./ai.suite";
import { Client, tokensFor } from "./finance.suite";
import { fakeFirestore, makeApp, type Clock, type Signer } from "./helpers";

async function fakeWorld(signer: Signer, options: AiWorldOptions): Promise<AiWorld> {
  const fake = fakeFirestore();
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const llm = new ScriptedLLM();
  const stt = new ScriptedSTT();
  const app = makeApp(
    signer,
    ((input: RequestInfo | URL, init?: RequestInit) => fake.fetchImpl(input, init)) as typeof fetch,
    { AI_DEFAULT_PLAN: options.plan ?? "free" },
    clock,
    { ...(options.noLlm ? {} : { llm }), stt },
  );
  const { a, b } = await tokensFor(signer);
  return { fake, clock, llm, stt, A: new Client(app, a), B: new Client(app, b) };
}

defineAiSuite("assistente de IA (Firestore falso em memória)", fakeWorld, { fake: true });
