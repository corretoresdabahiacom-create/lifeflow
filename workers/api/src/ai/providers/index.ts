import type { Env } from "../../env";
import { DeepSeekProvider } from "./deepseek";
import { GroqSpeechProvider } from "./groq";
import { ProviderError, type LLMProvider, type SpeechToTextProvider } from "./types";

export const DEFAULT_LLM_MODEL = "deepseek-flash";
export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_STT_MODEL = "whisper-large-v3-turbo";
export const DEFAULT_STT_BASE_URL = "https://api.groq.com/openai/v1";

/** Provedor e modelo vêm do ambiente; credenciais só de secrets. Sem credencial: `not_configured`. */
export function createLLMProvider(env: Env, fetchImpl: typeof fetch): LLMProvider {
  const provider = env.LLM_PROVIDER ?? "deepseek";
  if (provider !== "deepseek") throw new ProviderError("not_configured", `Provedor de LLM desconhecido: ${provider}`);
  if (!env.DEEPSEEK_API_KEY) throw new ProviderError("not_configured", "DEEPSEEK_API_KEY não configurada");
  return new DeepSeekProvider(
    env.DEEPSEEK_API_KEY,
    env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    fetchImpl,
  );
}

export function createSpeechProvider(env: Env, fetchImpl: typeof fetch): SpeechToTextProvider {
  const provider = env.STT_PROVIDER ?? "groq";
  if (provider !== "groq") throw new ProviderError("not_configured", `Provedor de transcrição desconhecido: ${provider}`);
  if (!env.GROQ_API_KEY) throw new ProviderError("not_configured", "GROQ_API_KEY não configurada");
  return new GroqSpeechProvider(
    env.GROQ_API_KEY,
    env.STT_MODEL ?? DEFAULT_STT_MODEL,
    env.STT_BASE_URL ?? DEFAULT_STT_BASE_URL,
    fetchImpl,
  );
}

export * from "./types";
