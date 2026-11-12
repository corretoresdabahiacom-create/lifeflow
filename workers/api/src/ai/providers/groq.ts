import {
  ProviderError,
  failureFromStatus,
  fetchWithTimeout,
  type SpeechToTextProvider,
  type TranscribeRequest,
} from "./types";

/**
 * Groq (transcrição). Modelo `whisper-large-v3-turbo`, rota `/openai/v1/audio/transcriptions`,
 * formatos flac/mp3/mp4/mpeg/mpga/m4a/ogg/wav/webm e cobrança mínima de 10 s, conferidos na
 * documentação oficial em 2026-11-11. O áudio é repassado e descartado; nada é gravado.
 */
export class GroqSpeechProvider implements SpeechToTextProvider {
  readonly name = "groq";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async transcribe(request: TranscribeRequest): Promise<{ text: string }> {
    const form = new FormData();
    form.set("file", new Blob([request.audio], { type: request.mimeType }), `audio.${extensionFor(request.mimeType)}`);
    form.set("model", this.model);
    form.set("response_format", "json");
    form.set("temperature", "0");
    if (request.language) form.set("language", request.language);

    const response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) throw failureFromStatus(response.status);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ProviderError("bad_response", "Resposta da transcrição não é JSON");
    }
    const text = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["text"] : undefined;
    if (typeof text !== "string") throw new ProviderError("bad_response", "Resposta da transcrição sem texto");
    return { text: text.trim() };
  }
}

export const AUDIO_MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

function extensionFor(mime: string): string {
  return AUDIO_MIME_EXTENSIONS[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "webm";
}
