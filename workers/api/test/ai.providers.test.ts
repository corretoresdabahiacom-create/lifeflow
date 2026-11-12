import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createLLMProvider, createSpeechProvider, ProviderError } from "../src/ai/providers";
import { DeepSeekProvider, parseResponse } from "../src/ai/providers/deepseek";
import { GroqSpeechProvider } from "../src/ai/providers/groq";

/** Testes dos adaptadores com `fetch` SIMULADO: provam o formato do pedido e o mapeamento de erros,
 *  NÃO provam o comportamento da API real (não há chaves reais nesta fase). */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const okChat = {
  choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_accounts", arguments: "{}" } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
};
const request = {
  messages: [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: "oi" },
    { role: "assistant" as const, content: null, toolCalls: [{ id: "c0", name: "get_accounts", arguments: "{}" }] },
    { role: "tool" as const, toolCallId: "c0", content: "dados" },
  ],
  tools: [{ name: "get_accounts", description: "d", parameters: { type: "object", properties: {} } }],
  maxTokens: 1024,
};

describe("DeepSeekProvider (fetch simulado)", () => {
  it("monta o pedido compatível com OpenAI, com thinking desligado e credencial só no header", async () => {
    const fetchImpl = vi.fn(async () => json(okChat));
    const llm = new DeepSeekProvider("sk-segredo", "deepseek-flash", "https://api.deepseek.com/", fetchImpl as unknown as typeof fetch);
    const out = await llm.chat(request);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-segredo");
    const body = JSON.parse(String(init.body)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body["model"]).toBe("deepseek-flash");
    expect(body["thinking"]).toEqual({ type: "disabled" });
    expect(body["max_tokens"]).toBe(1024);
    expect(body["tool_choice"]).toBe("auto");
    expect(body["tools"][0]).toEqual({ type: "function", function: { name: "get_accounts", description: "d", parameters: { type: "object", properties: {} } } });
    expect(body["messages"][2].tool_calls[0]).toEqual({ id: "c0", type: "function", function: { name: "get_accounts", arguments: "{}" } });
    expect(body["messages"][3]).toEqual({ role: "tool", tool_call_id: "c0", content: "dados" });
    expect(JSON.stringify(body)).not.toContain("sk-segredo");
    expect(out).toEqual({ content: null, toolCalls: [{ id: "c1", name: "get_accounts", arguments: "{}" }], usage: { inputTokens: 10, outputTokens: 4 }, finishReason: "tool_calls" });
  });

  it("mapeia status HTTP em tipos de erro sem vazar o corpo da resposta", async () => {
    const kinds: Record<number, string> = { 429: "rate_limited", 401: "not_configured", 402: "not_configured", 500: "unavailable", 503: "unavailable" };
    for (const [status, kind] of Object.entries(kinds)) {
      const llm = new DeepSeekProvider("k", "m", "http://x", (async () => new Response("detalhe interno sk-k", { status: Number(status) })) as typeof fetch);
      const error = (await llm.chat(request).catch((e) => e)) as ProviderError;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.kind).toBe(kind);
      expect(error.message).not.toContain("detalhe interno");
    }
  });

  it("falha de rede vira unavailable e prazo estourado vira timeout", async () => {
    const down = new DeepSeekProvider("k", "m", "http://x", (async () => {
      throw new TypeError("boom");
    }) as typeof fetch);
    expect(((await down.chat(request).catch((e) => e)) as ProviderError).kind).toBe("unavailable");

    vi.useFakeTimers();
    try {
      const hang = new DeepSeekProvider("k", "m", "http://x", ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch);
      const pending = hang.chat(request).catch((e) => e);
      await vi.advanceTimersByTimeAsync(25_001);
      expect(((await pending) as ProviderError).kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resposta que não é JSON ou fora do formato vira bad_response", async () => {
    const notJson = new DeepSeekProvider("k", "m", "http://x", (async () => new Response("<html>", { status: 200 })) as typeof fetch);
    expect(((await notJson.chat(request).catch((e) => e)) as ProviderError).kind).toBe("bad_response");
    for (const bad of [null, {}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { tool_calls: [{ id: 1 }] } }] }, { choices: [{ message: { tool_calls: [{ id: "a", function: { name: "x", arguments: {} } }] } }] }]) {
      expect(() => parseResponse(bad)).toThrow(ProviderError);
    }
  });

  it("parseResponse: texto simples, uso ausente ou inválido vira zero", () => {
    expect(parseResponse({ choices: [{ finish_reason: "stop", message: { content: "oi" } }] })).toEqual({
      content: "oi",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
    });
    expect(parseResponse({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: -5, completion_tokens: "a" } }).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("sem ferramentas não envia tools nem tool_choice", async () => {
    const fetchImpl = vi.fn(async () => json({ choices: [{ message: { content: "ok" } }] }));
    await new DeepSeekProvider("k", "m", "http://x", fetchImpl as unknown as typeof fetch).chat({ ...request, tools: [] });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined();
    expect(body["tool_choice"]).toBeUndefined();
  });
});

describe("GroqSpeechProvider (fetch simulado)", () => {
  it("envia multipart com arquivo, modelo e idioma; devolve o texto aparado", async () => {
    const fetchImpl = vi.fn(async () => json({ text: "  gastei cinquenta  " }));
    const stt = new GroqSpeechProvider("gsk-segredo", "whisper-large-v3-turbo", "https://api.groq.com/openai/v1", fetchImpl as unknown as typeof fetch);
    const out = await stt.transcribe({ audio: new Uint8Array([1, 2, 3]).buffer, mimeType: "audio/webm;codecs=opus", language: "pt" });
    expect(out.text).toBe("gastei cinquenta");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer gsk-segredo");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("pt");
    expect((form.get("file") as unknown as File).name).toBe("audio.webm");
    expect((form.get("file") as unknown as File).size).toBe(3);
  });

  it("mapeia erros e respostas inválidas", async () => {
    const make = (impl: () => Promise<Response>) => new GroqSpeechProvider("k", "m", "http://x", impl as unknown as typeof fetch);
    const audio = { audio: new ArrayBuffer(4), mimeType: "audio/ogg" };
    expect(((await make(async () => new Response("", { status: 429 })).transcribe(audio).catch((e) => e)) as ProviderError).kind).toBe("rate_limited");
    expect(((await make(async () => new Response("", { status: 401 })).transcribe(audio).catch((e) => e)) as ProviderError).kind).toBe("not_configured");
    expect(((await make(async () => new Response("", { status: 500 })).transcribe(audio).catch((e) => e)) as ProviderError).kind).toBe("unavailable");
    expect(((await make(async () => json({ nada: 1 })).transcribe(audio).catch((e) => e)) as ProviderError).kind).toBe("bad_response");
    expect(((await make(async () => new Response("x", { status: 200 })).transcribe(audio).catch((e) => e)) as ProviderError).kind).toBe("bad_response");
  });
});

describe("fábricas de provedor", () => {
  const base = {} as Env;
  it("sem chave: not_configured; com chave: padrões documentados", () => {
    expect(() => createLLMProvider(base, fetch)).toThrow(ProviderError);
    expect(() => createSpeechProvider(base, fetch)).toThrow(ProviderError);
    const llm = createLLMProvider({ DEEPSEEK_API_KEY: "k" } as Env, fetch);
    expect([llm.name, llm.model]).toEqual(["deepseek", "deepseek-flash"]);
    const stt = createSpeechProvider({ GROQ_API_KEY: "k" } as Env, fetch);
    expect([stt.name, stt.model]).toEqual(["groq", "whisper-large-v3-turbo"]);
    expect(createLLMProvider({ DEEPSEEK_API_KEY: "k", LLM_MODEL: "outro" } as Env, fetch).model).toBe("outro");
  });
  it("provedor desconhecido é recusado", () => {
    expect(() => createLLMProvider({ LLM_PROVIDER: "x", DEEPSEEK_API_KEY: "k" } as unknown as Env, fetch)).toThrow(/desconhecido/);
    expect(() => createSpeechProvider({ STT_PROVIDER: "x", GROQ_API_KEY: "k" } as unknown as Env, fetch)).toThrow(/desconhecido/);
  });
});
