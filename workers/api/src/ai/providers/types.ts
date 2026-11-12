/**
 * Interfaces independentes de provedor (contrato A3). O código de negócio só conhece estas
 * interfaces: nomes, endpoints e modelos de provedores ficam nesta pasta.
 */

export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON em texto, como devolvido pelo modelo. É NÃO CONFIÁVEL até ser validado. */
  arguments: string;
}

export type LLMMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LLMToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema dos parâmetros. */
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools: LLMToolSpec[];
  maxTokens: number;
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
}

export interface TranscribeRequest {
  audio: ArrayBuffer;
  mimeType: string;
  /** Código ISO-639-1 (ex.: `pt`). */
  language?: string;
}

export interface SpeechToTextProvider {
  readonly name: string;
  readonly model: string;
  transcribe(request: TranscribeRequest): Promise<{ text: string }>;
}

export type ProviderErrorKind = "not_configured" | "unavailable" | "timeout" | "rate_limited" | "bad_response";

/** Falha do provedor externo. A mensagem é interna: nunca contém credenciais nem o corpo da resposta. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export const PROVIDER_TIMEOUT_MS = 25_000;

/** `fetch` com prazo: o Worker não fica pendurado se o provedor travar. */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProviderError("timeout", "O provedor não respondeu a tempo");
    throw new ProviderError("unavailable", `Falha de rede com o provedor (${error instanceof Error ? error.name : "erro"})`);
  } finally {
    clearTimeout(timer);
  }
}

export function failureFromStatus(status: number): ProviderError {
  if (status === 429) return new ProviderError("rate_limited", "O provedor limitou as requisições", status);
  if (status === 401 || status === 403 || status === 402) {
    return new ProviderError("not_configured", "Credencial do provedor recusada ou sem saldo", status);
  }
  return new ProviderError("unavailable", `O provedor respondeu com erro ${status}`, status);
}
