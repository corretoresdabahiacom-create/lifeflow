import type { AiActionView } from "@lifeflow/shared";
import { useState } from "react";
import { useApi } from "../../app/ApiProvider";
import { describeError } from "../../lib/useLoad";

export const ACTION_STATUS_LABELS: Record<AiActionView["status"], string> = {
  pending: "Aguardando sua confirmação",
  executing: "Executando…",
  done: "Concluída",
  rejected: "Recusada",
  failed: "Falhou",
  expired: "Expirada",
  blocked: "Bloqueada",
};

/**
 * Cartão de uma ação proposta pela IA. O resumo vem do backend (montado a partir dos parâmetros
 * congelados), nunca do texto do modelo. Nada acontece até o usuário confirmar aqui.
 */
export function ActionCard({ action, onChange }: { action: AiActionView; onChange: (next: AiActionView) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const pending = action.status === "pending";

  async function run(kind: "confirm" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const result = kind === "confirm" ? await api.aiConfirm(action.id, action.reinforced) : await api.aiReject(action.id);
      onChange(result.action);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={action.reinforced && pending ? "card ai-action ai-action--reinforced" : "card ai-action"} role="group" aria-label="Ação proposta pelo assistente">
      <div className="ai-action__head">
        <strong>{action.summary}</strong>
        <span className={action.status === "done" ? "badge" : action.status === "pending" ? "badge badge--ai" : "badge badge--danger"}>
          {ACTION_STATUS_LABELS[action.status]}
        </span>
      </div>
      {action.reinforced && pending ? (
        <div className="notice notice--warn" role="alert">
          Valor acima do seu limite de segurança. Confira com atenção antes de confirmar.
          <label className="check">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>Conferi e quero confirmar</span>
          </label>
        </div>
      ) : null}
      {action.resultNote ? <p className="muted">{action.resultNote}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {pending ? (
        <div className="row__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || (action.reinforced && !understood)}
            onClick={() => void run("confirm")}
          >
            Confirmar
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void run("reject")}>
            Recusar
          </button>
        </div>
      ) : null}
    </div>
  );
}
