import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { describeError, useLoad } from "../../lib/useLoad";

const TYPE_LABELS: Record<string, string> = {
  event_reminder: "Compromisso",
  task_reminder: "Tarefa",
  task_overdue: "Tarefa atrasada",
  payable_due: "Vencimento",
  reminder: "Lembrete",
};

function ReminderForm({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setOk(false);
    const date = new Date(when); // datetime-local é interpretado no horário do dispositivo
    if (!when || Number.isNaN(date.getTime())) return setError("Informe a data e a hora do lembrete.");
    try {
      await api.createReminder({ title: title.trim(), remindAt: date.toISOString() }, key.current());
      key.renew();
      setTitle("");
      setWhen("");
      setOk(true);
      onDone();
    } catch (e) {
      setError(describeError(e));
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} aria-labelledby="rem-new">
      <h2 id="rem-new">Novo lembrete</h2>
      <label className="field">
        <span>O que lembrar</span>
        <input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="field">
        <span>Quando</span>
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {ok ? <p className="form-ok" role="status">Lembrete criado. Ele aparece aqui na hora marcada.</p> : null}
      <button type="submit" className="btn btn--primary">Criar lembrete</button>
    </form>
  );
}

export function NotificationsPage() {
  const api = useApi();
  const [actionError, setActionError] = useState<string | null>(null);
  // Ao abrir, pede ao servidor para gerar o que já venceu; é idempotente, então repetir não duplica.
  const { data, error, loading, reload } = useLoad(async () => {
    await api.generateNotifications().catch(() => undefined);
    return api.listNotifications();
  });

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(describeError(e));
    }
  }

  return (
    <>
      <ReminderForm onDone={reload} />
      <div className="card">
        <div className="calendar__bar">
          <h2>Notificações{data && data.unreadCount > 0 ? ` (${data.unreadCount} não lidas)` : ""}</h2>
          <button type="button" className="btn" disabled={!data || data.unreadCount === 0} onClick={() => void run(() => api.readAllNotifications())}>
            Marcar todas como lidas
          </button>
        </div>
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        {loading && !data ? <LoadingState label="Carregando notificações…" /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {data && data.notifications.length === 0 ? <EmptyState title="Nenhuma notificação">Compromissos, tarefas e vencimentos com lembrete aparecem aqui.</EmptyState> : null}
        {data && data.notifications.length > 0 ? (
          <ul className="events">
            {data.notifications.map((n) => (
              <li key={n.id} className={n.read ? "event" : "event event--unread"}>
                <div className="event__main">
                  <strong>{n.title}</strong>
                  <span className="muted">
                    {TYPE_LABELS[n.type] ?? n.type} · {n.body}
                  </span>
                  <span className="badges">
                    {!n.read ? <span className="badge badge--danger">Nova</span> : null}
                    {n.silent ? <span className="badge">Horário silencioso</span> : null}
                  </span>
                </div>
                <div className="event__actions">
                  {!n.read ? (
                    <button type="button" className="btn" onClick={() => void run(() => api.markNotificationRead(n.id))}>Marcar como lida</button>
                  ) : null}
                  <button type="button" className="btn" onClick={() => void run(() => api.dismissNotification(n.id))}>Dispensar</button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
