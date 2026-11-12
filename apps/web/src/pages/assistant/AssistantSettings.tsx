import { DEFAULT_AI_SETTINGS, type AiSettings } from "@lifeflow/shared";
import { useEffect, useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { ErrorState, LoadingState } from "../../components/States";
import { formatDate, useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

const EVENT_LABELS: Record<string, string> = {
  proposed: "Proposta criada",
  auto_executed: "Executada automaticamente",
  confirmed: "Confirmada por você",
  executed: "Executada",
  failed: "Falhou",
  rejected: "Recusada",
  blocked: "Bloqueada",
  expired: "Expirada",
  unauthorized_tool: "Ferramenta não autorizada recusada",
  invalid_args: "Parâmetros inválidos recusados",
  provider_error: "Falha do provedor de IA",
};

/** Privacidade (consentimento de voz), limites de automação e histórico de ações da IA. */
export function AssistantSettings() {
  const api = useApi();
  const money = useMoney();
  const settings = useLoad(() => api.aiGetSettings(), []);
  const consent = useLoad(() => api.aiGetConsent(), []);
  const history = useLoad(() => api.aiHistory(), []);
  const [form, setForm] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setForm(settings.data.settings);
  }, [settings.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.aiPutSettings(form);
      setMessage("Limites salvos.");
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function toggleAudio(next: boolean) {
    setError(null);
    try {
      await api.aiPutConsent(next);
      consent.reload();
    } catch (e) {
      setError(describeError(e));
    }
  }

  if (settings.loading || consent.loading) return <LoadingState />;
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />;

  const num = (key: keyof AiSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: Number.isFinite(e.target.valueAsNumber) ? Math.trunc(e.target.valueAsNumber) : 0 }));

  return (
    <div className="stack">
      <section className="card" aria-labelledby="ai-privacy">
        <h2 id="ai-privacy">Privacidade</h2>
        <label className="check">
          <input type="checkbox" checked={consent.data?.audio === true} onChange={(e) => void toggleAudio(e.target.checked)} />
          <span>Permitir enviar áudio ao serviço de transcrição (Groq) quando eu usar o botão de voz</span>
        </label>
        <p className="muted">O áudio é usado só para virar texto e não é guardado. Sem esta permissão a voz não funciona.</p>
      </section>

      <form className="card form" onSubmit={(e) => void save(e)} aria-labelledby="ai-limits">
        <h2 id="ai-limits">Limites de automação</h2>
        <p className="muted">
          Por padrão o assistente sempre pede sua confirmação. Se você desligar “confirmar criações” em Ajustes, ele só cria sozinho dentro destes
          limites. Estornos, baixas, edições e exclusões sempre pedem confirmação.
        </p>
        <label className="field">
          <span>Ações automáticas por dia</span>
          <input type="number" min={0} max={100} value={form.autoActionsPerDay} onChange={num("autoActionsPerDay")} />
        </label>
        <label className="field">
          <span>Valor automático máximo por dia (centavos)</span>
          <input type="number" min={0} max={10000000} value={form.autoValueLimitCents} onChange={num("autoValueLimitCents")} />
          <small className="muted">{money(form.autoValueLimitCents)}</small>
        </label>
        <label className="field">
          <span>Confirmação reforçada acima de (centavos)</span>
          <input type="number" min={0} max={10000000} value={form.confirmAboveCents} onChange={num("confirmAboveCents")} />
          <small className="muted">{money(form.confirmAboveCents)}</small>
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {message ? <p role="status">{message}</p> : null}
        <button type="submit" className="btn btn--primary">Salvar limites</button>
      </form>

      <section className="card" aria-labelledby="ai-history">
        <h2 id="ai-history">Histórico de ações da IA</h2>
        {history.loading ? <LoadingState /> : null}
        {history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : null}
        {history.data && history.data.history.length === 0 ? <p className="muted">Nenhuma ação ainda.</p> : null}
        <ul className="list">
          {(history.data?.history ?? []).map((h) => (
            <li key={h.id} className="row">
              <div className="row__main">
                <strong>{EVENT_LABELS[h.event] ?? h.event}</strong>
                <span className="muted">{h.detail}</span>
              </div>
              <span className="muted">{formatDate(h.createdAt.slice(0, 10))}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
