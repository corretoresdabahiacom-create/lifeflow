import {
  AI_AUDIO_MAX_BYTES,
  AI_AUDIO_MAX_SECONDS,
  AI_AUDIO_MIN_BILLED_SECONDS,
  AiChatRequestSchema,
  AiConfirmSchema,
  AiConsentSchema,
  AiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  DEFAULT_PLAN_AI_LIMITS,
  type AiMessageView,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import { allow, json, parseBody } from "../http";
import { assertId, pathsFor, type Ctx } from "../finance/common";
import { chat, executeAction, rejectAction, type AiDeps } from "./engine";
import { AUDIO_MIME_EXTENSIONS } from "./providers/groq";
import { createSpeechProvider, ProviderError } from "./providers";
import { actionView, addUsage, readDaily, readSettings, readUsage, resolvePlan, writeLog } from "./store";

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

function idempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key");
  if (!key) throw new HttpError(400, "idempotency_key_required", "O cabeçalho Idempotency-Key é obrigatório nesta operação");
  if (!KEY_RE.test(key)) throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key inválida (8 a 128 caracteres: letras, números, _ - : .)");
  return key;
}

/** Rotas `/v1/ai/*`. Devolve `null` para caminhos que não são da IA. */
export async function handleAi(ctx: Ctx, deps: AiDeps): Promise<Response | null> {
  const parts = ctx.url.pathname.split("/").filter(Boolean); // ["v1", "ai", ...]
  if (parts[0] !== "v1" || parts[1] !== "ai") return null;
  const method = ctx.request.method;
  const [, , resource, id, action] = parts;
  const p = pathsFor(ctx.uid);

  switch (resource) {
    case "chat": {
      if (id !== undefined) throw new HttpError(404, "not_found", "Rota não encontrada");
      allow(method, ["POST"]);
      const key = idempotencyKey(ctx.request);
      const input = await parseBody(ctx.request, AiChatRequestSchema);
      return json(await chat(ctx, deps, { ...input, idempotencyKey: key }));
    }

    case "conversations": {
      if (id === undefined) {
        allow(method, ["GET"]);
        const docs = await ctx.db.query(p.parent, {
          collection: "aiConversations",
          orderBy: { field: "updatedAt", direction: "DESCENDING" },
          limit: 30,
        });
        return json({
          conversations: docs.map((d) => ({ id: d.id, title: String(d.data["title"] ?? ""), updatedAt: String(d.data["updatedAt"] ?? "") })),
        });
      }
      assertId(id);
      if (action !== undefined) throw new HttpError(404, "not_found", "Rota não encontrada");
      allow(method, ["GET", "DELETE"]);
      const conversation = await ctx.db.getDoc(p.aiConversation(id));
      if (!conversation) throw new HttpError(404, "not_found", "Conversa não encontrada");
      const messages = await ctx.db.query(p.aiMessagesParent(id), {
        collection: "messages",
        orderBy: { field: "createdAt", direction: "ASCENDING" },
        limit: 200,
      });
      if (method === "DELETE") {
        // Remove o texto da conversa. A trilha de auditoria das ações (aiActions/aiLogs) é mantida (ver SECURITY.md).
        await ctx.db.commit([
          ...messages.map((m) => ({ path: p.aiMessage(id, m.id), delete: true })),
          { path: p.aiConversation(id), delete: true },
        ]);
        return json({ deleted: true });
      }
      const actions = await ctx.db.query(p.parent, {
        collection: "aiActions",
        filters: [{ field: "conversationId", op: "EQUAL", value: id }],
        limit: 100,
      });
      const views: AiMessageView[] = messages.map((m) => ({
        id: m.id,
        role: m.data["role"] === "user" ? "user" : "assistant",
        content: String(m.data["content"] ?? ""),
        createdAt: String(m.data["createdAt"] ?? ""),
      }));
      return json({
        id,
        title: String(conversation.data["title"] ?? ""),
        messages: views,
        actions: actions.map((a) => actionView(a.id, a.data)).sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)),
      });
    }

    case "actions": {
      if (id === undefined) {
        allow(method, ["GET"]);
        const docs = await ctx.db.query(p.parent, {
          collection: "aiActions",
          filters: [{ field: "status", op: "EQUAL", value: "pending" }],
          limit: 50,
        });
        const nowIso = ctx.now().toISOString();
        return json({
          actions: docs
            .filter((d) => String(d.data["expiresAt"]) > nowIso)
            .map((d) => actionView(d.id, d.data))
            .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
        });
      }
      assertId(id);
      if (action !== "confirm" && action !== "reject") throw new HttpError(404, "not_found", "Rota não encontrada");
      allow(method, ["POST"]);
      if (action === "reject") return json({ action: await rejectAction(ctx, id) });

      // O corpo NÃO traz parâmetros da ação: o que roda é o que foi congelado quando a ação foi proposta.
      const body = await parseBody(ctx.request, AiConfirmSchema);
      const stored = await ctx.db.get(p.aiAction(id));
      if (!stored) throw new HttpError(404, "not_found", "Ação não encontrada");
      if (stored["reinforced"] === true && stored["status"] === "pending" && body.reinforced !== true) {
        throw new HttpError(
          422,
          "reinforced_confirmation_required",
          "Esta ação envolve um valor acima do seu limite de segurança e exige confirmação reforçada",
        );
      }
      return json({ action: await executeAction(ctx, id, { auto: false }) });
    }

    case "history": {
      // Histórico completo das ações da IA (trilha de auditoria): propostas, confirmações, bloqueios e falhas.
      allow(method, ["GET"]);
      const docs = await ctx.db.query(p.parent, {
        collection: "aiLogs",
        orderBy: { field: "createdAt", direction: "DESCENDING" },
        limit: 100,
      });
      return json({
        history: docs.map((d) => ({
          id: d.id,
          event: String(d.data["event"]),
          tool: typeof d.data["tool"] === "string" ? d.data["tool"] : null,
          actionId: typeof d.data["actionId"] === "string" ? d.data["actionId"] : null,
          detail: String(d.data["detail"] ?? ""),
          createdAt: String(d.data["createdAt"] ?? ""),
        })),
      });
    }

    case "usage": {
      allow(method, ["GET"]);
      const { daily } = await readDaily(ctx);
      return json({ usage: await readUsage(ctx, deps.env), autoToday: daily });
    }

    case "settings": {
      allow(method, ["GET", "PUT"]);
      if (method === "GET") return json({ settings: await readSettings(ctx), defaults: DEFAULT_AI_SETTINGS });
      const input = await parseBody(ctx.request, AiSettingsSchema);
      await ctx.db.upsert(p.aiSettings, { ...input, uid: ctx.uid, updatedAt: ctx.now().toISOString() });
      return json({ settings: input, defaults: DEFAULT_AI_SETTINGS });
    }

    case "consent": {
      allow(method, ["GET", "PUT"]);
      if (method === "PUT") {
        const input = await parseBody(ctx.request, AiConsentSchema);
        const timestamp = ctx.now().toISOString();
        await ctx.db.upsert(p.aiConsentAudio, { uid: ctx.uid, granted: input.audio, updatedAt: timestamp });
        return json({ audio: input.audio, updatedAt: timestamp });
      }
      const doc = await ctx.db.get(p.aiConsentAudio);
      return json({ audio: doc?.["granted"] === true, updatedAt: typeof doc?.["updatedAt"] === "string" ? doc["updatedAt"] : null });
    }

    case "transcribe": {
      allow(method, ["POST"]);
      return transcribe(ctx, deps);
    }

    default:
      throw new HttpError(404, "not_found", "Rota não encontrada");
  }
}

/**
 * Voz → texto. Exige consentimento explícito, plano com voz e limites de tamanho/duração.
 * O áudio é repassado ao provedor e descartado: não é gravado em lugar nenhum.
 */
async function transcribe(ctx: Ctx, deps: AiDeps): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const consent = await ctx.db.get(p.aiConsentAudio);
  if (consent?.["granted"] !== true) {
    throw new HttpError(403, "audio_consent_required", "Autorize o uso do microfone e o envio do áudio para transcrição antes de usar a voz");
  }
  const plan = resolvePlan(deps.env);
  if (DEFAULT_PLAN_AI_LIMITS[plan].voiceMinutesPerMonth <= 0) {
    throw new HttpError(403, "voice_not_in_plan", "A transcrição por voz não está disponível no seu plano");
  }

  const mime = (ctx.request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(mime in AUDIO_MIME_EXTENSIONS)) throw new HttpError(415, "unsupported_media_type", "Formato de áudio não suportado");
  const seconds = Number(ctx.request.headers.get("X-Audio-Seconds"));
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > AI_AUDIO_MAX_SECONDS) {
    throw new HttpError(422, "audio_duration_invalid", `Informe a duração do áudio em X-Audio-Seconds (1 a ${AI_AUDIO_MAX_SECONDS} s)`);
  }
  if (Number(ctx.request.headers.get("Content-Length") ?? "0") > AI_AUDIO_MAX_BYTES) {
    throw new HttpError(413, "audio_too_large", "O áudio é grande demais");
  }
  const audio = await ctx.request.arrayBuffer();
  if (audio.byteLength === 0) throw new HttpError(422, "audio_empty", "Áudio vazio");
  if (audio.byteLength > AI_AUDIO_MAX_BYTES) throw new HttpError(413, "audio_too_large", "O áudio é grande demais");

  const billed = Math.max(AI_AUDIO_MIN_BILLED_SECONDS, Math.ceil(seconds));
  const usage = await readUsage(ctx, deps.env);
  if (usage.voiceSeconds + billed > usage.voiceSecondsLimit) {
    throw new HttpError(429, "ai_voice_limit_reached", "Você atingiu o limite mensal de transcrição por voz do seu plano");
  }

  let text: string;
  try {
    const stt = deps.stt ?? createSpeechProvider(deps.env, deps.fetchImpl);
    ({ text } = await stt.transcribe({ audio, mimeType: mime, language: "pt" }));
  } catch (error) {
    await writeLog(ctx, { event: "provider_error", detail: error instanceof ProviderError ? `stt:${error.kind}` : "stt" });
    if (error instanceof ProviderError && error.kind === "not_configured") {
      throw new HttpError(503, "ai_not_configured", "A transcrição por voz ainda não está disponível.");
    }
    throw new HttpError(502, "ai_provider_error", "Não foi possível transcrever o áudio agora. Tente novamente ou digite.");
  }
  if (text === "") throw new HttpError(422, "empty_transcription", "Não entendi o áudio. Tente falar de novo ou digite.");
  await addUsage(ctx, { voiceSeconds: billed });
  return json({ text: text.slice(0, 2000), billedSeconds: billed });
}
