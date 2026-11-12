import { AI_MESSAGE_MAX_CHARS, type AiActionView, type AiMessageView, type AiUsageView } from "@lifeflow/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { ErrorState, LoadingState } from "../../components/States";
import type { AiConversationSummary } from "../../lib/api";
import { useIdempotencyKey } from "../../lib/idempotency";
import { describeError, useLoad } from "../../lib/useLoad";
import { ActionCard } from "./ActionCard";
import { AssistantSettings } from "./AssistantSettings";
import { VoiceButton } from "./VoiceButton";

type Tab = "chat" | "settings";

export function AssistantPage() {
  const [tab, setTab] = useState<Tab>("chat");
  return (
    <>
      <h1>Assistente</h1>
      <div className="tabs" role="tablist" aria-label="Seções do assistente">
        <button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "tab tab--active" : "tab"} onClick={() => setTab("chat")}>
          Conversa
        </button>
        <button type="button" role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "tab tab--active" : "tab"} onClick={() => setTab("settings")}>
          Privacidade, limites e histórico
        </button>
      </div>
      {tab === "chat" ? <Chat /> : <AssistantSettings />}
    </>
  );
}

function usageText(usage: AiUsageView): string {
  const minutes = Math.floor(usage.voiceSeconds / 60);
  const limitMinutes = Math.floor(usage.voiceSecondsLimit / 60);
  return `${usage.messages} de ${usage.messagesLimit} mensagens neste mês` + (usage.voiceSecondsLimit > 0 ? ` · voz: ${minutes} de ${limitMinutes} min` : " · voz não incluída no seu plano");
}

function Chat() {
  const api = useApi();
  const key = useIdempotencyKey();
  const conversations = useLoad(() => api.aiListConversations(), []);
  const usage = useLoad(() => api.aiUsage(), []);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<AiMessageView[]>([]);
  const [actions, setActions] = useState<AiActionView[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageNow, setUsageNow] = useState<AiUsageView | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // `scrollIntoView` não existe em todos os ambientes (ex.: testes).
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages, actions]);

  // Ações ainda pendentes (de conversas anteriores) continuam acessíveis para confirmar ou recusar.
  useEffect(() => {
    api
      .aiPendingActions()
      .then((r) => setActions((current) => mergeActions(current, r.actions)))
      .catch(() => undefined);
  }, [api]);

  async function open(id: string) {
    setError(null);
    try {
      const detail = await api.aiGetConversation(id);
      setConversationId(id);
      setMessages(detail.messages);
      setActions(detail.actions);
      key.renew();
    } catch (e) {
      setError(describeError(e));
    }
  }

  function fresh() {
    setConversationId(undefined);
    setMessages([]);
    setActions([]);
    setError(null);
    key.renew();
  }

  async function remove() {
    if (!conversationId) return;
    try {
      await api.aiDeleteConversation(conversationId);
      fresh();
      conversations.reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A mesma chave é reutilizada se o envio falhar: reenviar não gasta outra mensagem nem duplica ações.
      const reply = await api.aiChat(message, conversationId, key.current());
      key.renew();
      setConversationId(reply.conversationId);
      setMessages((m) => [
        ...m,
        { id: `u-${reply.reply.id}`, role: "user", content: message, createdAt: reply.reply.createdAt },
        reply.reply,
      ]);
      setActions((current) => mergeActions(current, reply.actions));
      setUsageNow(reply.usage);
      setText("");
      conversations.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function onActionChange(next: AiActionView) {
    setActions((list) => list.map((a) => (a.id === next.id ? next : a)));
    usage.reload();
  }

  const shownUsage = usageNow ?? usage.data?.usage ?? null;
  const list: AiConversationSummary[] = conversations.data?.conversations ?? [];
  const visibleActions = actions.filter((a) => a.status !== "expired" || messages.length > 0);

  return (
    <div className="ai">
      <div className="card ai__bar">
        <label className="field ai__select">
          <span>Conversa</span>
          <select value={conversationId ?? ""} onChange={(e) => (e.target.value ? void open(e.target.value) : fresh())}>
            <option value="">Nova conversa</option>
            {list.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </label>
        {conversationId ? (
          <button type="button" className="btn" onClick={() => void remove()}>Apagar conversa</button>
        ) : null}
      </div>

      {conversations.error ? <ErrorState message={conversations.error} onRetry={conversations.reload} /> : null}

      <div className="card ai__thread" role="log" aria-live="polite" aria-label="Mensagens">
        {messages.length === 0 ? (
          <p className="muted">
            Peça em linguagem natural: “gastei 50 reais no almoço”, “marque dentista amanhã às 14h”, “quanto gastei esse mês?”. O assistente
            propõe e <strong>você confirma</strong> antes de qualquer gravação.
          </p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "bubble bubble--user" : "bubble"}>
            <span className="visually-hidden">{m.role === "user" ? "Você: " : "Assistente: "}</span>
            {m.content}
          </div>
        ))}
        {busy ? <LoadingState label="O assistente está pensando…" /> : null}
        <div ref={endRef} />
      </div>

      {visibleActions.length > 0 ? (
        <section aria-label="Ações propostas" className="stack">
          {visibleActions.map((a) => (
            <ActionCard key={a.id} action={a} onChange={onActionChange} />
          ))}
        </section>
      ) : null}

      <form className="card form ai__form" onSubmit={(e) => void send(e)}>
        <label className="field">
          <span>Sua mensagem</span>
          <textarea
            value={text}
            rows={2}
            maxLength={AI_MESSAGE_MAX_CHARS}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="row__actions">
          <button type="submit" className="btn btn--primary" disabled={busy || text.trim() === ""}>Enviar</button>
          <VoiceButton disabled={busy} onText={(t) => setText((current) => (current ? `${current} ${t}` : t))} />
        </div>
        {shownUsage ? <small className="muted">{usageText(shownUsage)}</small> : null}
        <small className="muted">O assistente pode errar. Confira sempre o resumo antes de confirmar.</small>
      </form>
    </div>
  );
}

function mergeActions(current: AiActionView[], incoming: AiActionView[]): AiActionView[] {
  const byId = new Map(current.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
}
