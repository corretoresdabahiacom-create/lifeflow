import { AI_AUDIO_MAX_SECONDS } from "@lifeflow/shared";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../app/ApiProvider";
import { describeError } from "../../lib/useLoad";

type Phase = "idle" | "consent" | "recording" | "sending";

/**
 * Voz → texto. Antes do primeiro uso pede consentimento explícito (microfone + envio do áudio ao
 * provedor de transcrição). O texto transcrito vai para a caixa de mensagem para o usuário revisar;
 * nada é enviado ao assistente sem ele apertar "Enviar". O áudio não é guardado.
 */
export function VoiceButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);

  useEffect(() => () => stop(true), []);

  const supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  function stop(discard = false) {
    const r = recorder.current;
    if (r && r.state !== "inactive") {
      if (discard) r.ondataavailable = null;
      if (discard) r.onstop = null;
      r.stop();
    }
    recorder.current = null;
    release();
  }

  async function begin() {
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(media);
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onstop = () => {
        const seconds = (Date.now() - startedAt.current) / 1000;
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        release();
        setPhase("sending");
        api
          .aiTranscribe(blob, seconds)
          .then((r) => onText(r.text))
          .catch((e: unknown) => setError(describeError(e)))
          .finally(() => setPhase("idle"));
      };
      startedAt.current = Date.now();
      setElapsed(0);
      rec.start();
      setPhase("recording");
      timer.current = setInterval(() => {
        const s = Math.floor((Date.now() - startedAt.current) / 1000);
        setElapsed(s);
        if (s >= AI_AUDIO_MAX_SECONDS) stop();
      }, 500);
    } catch {
      release();
      setPhase("idle");
      setError("Não foi possível acessar o microfone. Verifique a permissão do navegador.");
    }
  }

  async function click() {
    if (phase === "recording") return stop();
    setError(null);
    try {
      const consent = await api.aiGetConsent();
      if (!consent.audio) return setPhase("consent");
      await begin();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function grant() {
    try {
      await api.aiPutConsent(true);
      await begin();
    } catch (e) {
      setPhase("idle");
      setError(describeError(e));
    }
  }

  if (!supported) return null;
  return (
    <div className="voice">
      <button
        type="button"
        className={phase === "recording" ? "btn btn--danger" : "btn"}
        disabled={disabled || phase === "sending" || phase === "consent"}
        aria-pressed={phase === "recording"}
        onClick={() => void click()}
      >
        {phase === "recording" ? `Parar (${elapsed}s)` : phase === "sending" ? "Transcrevendo…" : "🎤 Falar"}
      </button>
      {phase === "consent" ? (
        <div className="notice" role="dialog" aria-label="Consentimento para uso da voz">
          <strong>Usar a voz?</strong>
          <p>
            O navegador vai pedir acesso ao microfone e o áudio gravado será enviado a um serviço externo (Groq) apenas para virar texto.
            O áudio não é guardado pelo LIFEFlow. Você pode revogar isso a qualquer momento em Assistente → Privacidade.
          </p>
          <div className="row__actions">
            <button type="button" className="btn btn--primary" onClick={() => void grant()}>Autorizar e gravar</button>
            <button type="button" className="btn" onClick={() => setPhase("idle")}>Agora não</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}
