import {
  ProviderError,
  failureFromStatus,
  fetchWithTimeout,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "./types";

/**
 * DeepSeek (API compatível com OpenAI). Modelo `deepseek-flash`, URL base `https://api.deepseek.com`,
 * rota `/chat/completions` e `tools` confirmados na documentação oficial em 2026-11-11.
 * O raciocínio (thinking) fica desligado: o fluxo é de ferramentas curtas, e `tool_choice` fixo
 * não é aceito em modo thinking.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const body = {
      model: this.model,
      messages: request.messages.map(toWire),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
      max_tokens: request.maxTokens,
      thinking: { type: "disabled" },
      stream: false,
    };
    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw failureFromStatus(response.status);

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError("bad_response", "Resposta do provedor não é JSON");
    }
    return parseResponse(data);
  }
}

function toWire(message: LLMMessage): Record<string, unknown> {
  switch (message.role) {
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A resposta do provedor é entrada não confiável: só o que tem o formato esperado é aceito. */
export function parseResponse(data: unknown): LLMResponse {
  if (!isRecord(data) || !Array.isArray(data["choices"]) || !isRecord(data["choices"][0])) {
    throw new ProviderError("bad_response", "Resposta do provedor sem choices");
  }
  const choice = data["choices"][0];
  const message = choice["message"];
  if (!isRecord(message)) throw new ProviderError("bad_response", "Resposta do provedor sem message");

  const toolCalls: LLMResponse["toolCalls"] = [];
  if (Array.isArray(message["tool_calls"])) {
    for (const raw of message["tool_calls"]) {
      if (!isRecord(raw) || !isRecord(raw["function"])) throw new ProviderError("bad_response", "tool_call malformado");
      const fn = raw["function"];
      if (typeof raw["id"] !== "string" || typeof fn["name"] !== "string" || typeof fn["arguments"] !== "string") {
        throw new ProviderError("bad_response", "tool_call malformado");
      }
      toolCalls.push({ id: raw["id"], name: fn["name"], arguments: fn["arguments"] });
    }
  }
  const content = typeof message["content"] === "string" ? message["content"] : null;
  const usage = isRecord(data["usage"]) ? data["usage"] : {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    content,
    toolCalls,
    usage: { inputTokens: num(usage["prompt_tokens"]), outputTokens: num(usage["completion_tokens"]) },
    finishReason: typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : "unknown",
  };
}
