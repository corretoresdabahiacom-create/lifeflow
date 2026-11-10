import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from "@lifeflow/shared";
import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatDate, todayLocal } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

export const PRIORITY_LABELS: Record<TaskPriority, string> = { low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" };
export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "Pendente",
  in_progress: "Em andamento",
  completed: "Concluída",
  canceled: "Cancelada",
};
const REMINDERS = [
  { value: "", label: "Sem lembrete" },
  { value: "0", label: "Na hora do prazo" },
  { value: "60", label: "1 h antes" },
  { value: "1440", label: "1 dia antes" },
];

type Filter = "open" | "overdue" | "completed" | "all";

function TaskForm({ categories, onDone }: { categories: Array<{ id: string; name: string }>; onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [reminder, setReminder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (dueTime && !dueDate) return setError("Informe a data do prazo.");
    if (reminder && !dueDate) return setError("O lembrete exige um prazo.");
    setBusy(true);
    try {
      await api.createTask(
        {
          title: title.trim(),
          priority,
          dueDate: dueDate || null,
          dueTime: dueTime || null,
          categoryId: categoryId || null,
          reminderMinutes: reminder === "" ? null : Number(reminder),
        },
        key.current(),
      );
      key.renew();
      setTitle("");
      setDueDate("");
      setDueTime("");
      setReminder("");
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} aria-labelledby="task-new">
      <h2 id="task-new">Nova tarefa</h2>
      <label className="field">
        <span>Título</span>
        <input value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label className="field">
        <span>Prioridade</span>
        <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Prazo</span>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Horário (opcional)</span>
        <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
      </label>
      <label className="field">
        <span>Categoria</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Sem categoria</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Lembrete</span>
        <select value={reminder} onChange={(e) => setReminder(e.target.value)}>
          {REMINDERS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Salvando…" : "Adicionar tarefa"}</button>
    </form>
  );
}

function CategoryForm({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.createTaskCategory(name.trim(), key.current());
      key.renew();
      setName("");
      onDone();
    } catch (e) {
      setError(describeError(e));
    }
  }
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span>Nova categoria de tarefa</span>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
      </label>
      <button type="submit" className="btn">Criar categoria</button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </form>
  );
}

export function TasksPage() {
  const api = useApi();
  const [filter, setFilter] = useState<Filter>("open");
  const [priority, setPriority] = useState<"" | TaskPriority>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const query = {
    ...(filter === "overdue" ? { overdue: "true" } : {}),
    ...(filter === "completed" ? { status: "completed" } : {}),
    ...(filter === "all" ? { includeDone: "true" } : {}),
    priority: priority || null,
  };
  const tasks = useLoad(() => api.listTasks(query), [filter, priority]);
  const categories = useLoad(() => api.listTaskCategories());
  const categoryName = new Map((categories.data?.categories ?? []).map((c) => [c.id, c.name]));

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      tasks.reload();
    } catch (e) {
      setActionError(describeError(e));
    }
  }

  return (
    <>
      <TaskForm categories={categories.data?.categories ?? []} onDone={tasks.reload} />
      <div className="card">
        <CategoryForm onDone={categories.reload} />
      </div>
      <div className="card">
        <div className="filters">
          <div className="seg" role="group" aria-label="Filtro de tarefas">
            {(
              [
                ["open", "Abertas"],
                ["overdue", `Atrasadas${tasks.data && tasks.data.overdueCount > 0 ? ` (${tasks.data.overdueCount})` : ""}`],
                ["completed", "Concluídas"],
                ["all", "Todas"],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button key={value} type="button" className={filter === value ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Prioridade</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as "" | TaskPriority)}>
              <option value="">Todas</option>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </select>
          </label>
        </div>
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        {tasks.loading && !tasks.data ? <LoadingState label="Carregando tarefas…" /> : null}
        {tasks.error ? <ErrorState message={tasks.error} onRetry={tasks.reload} /> : null}
        {tasks.data && tasks.data.tasks.length === 0 ? <EmptyState title="Nenhuma tarefa aqui" /> : null}
        {tasks.data && tasks.data.tasks.length > 0 ? (
          <ul className="events">
            {tasks.data.tasks.map((task: Task) => (
              <li key={task.id} className={task.overdue ? "event event--conflict" : "event"}>
                <div className="event__main">
                  <strong className={task.status === "completed" ? "done" : undefined}>{task.title}</strong>
                  <span className="muted">
                    {PRIORITY_LABELS[task.priority]}
                    {task.dueDate ? ` · prazo ${formatDate(task.dueDate)}${task.dueTime ? ` ${task.dueTime}` : ""}` : ""}
                    {task.categoryId && categoryName.get(task.categoryId) ? ` · ${categoryName.get(task.categoryId)}` : ""}
                  </span>
                  <span className="badges">
                    {task.overdue ? <span className="badge badge--danger">Atrasada</span> : null}
                    <span className="badge">{STATUS_LABELS[task.status]}</span>
                  </span>
                </div>
                <div className="event__actions">
                  {task.status !== "completed" && task.status !== "canceled" ? (
                    <button type="button" className="btn btn--primary" onClick={() => void run(() => api.completeTask(task.id))}>Concluir</button>
                  ) : (
                    <button type="button" className="btn" onClick={() => void run(() => api.patchTask(task.id, { status: "pending" }))}>Reabrir</button>
                  )}
                  <label className="field field--inline">
                    <span className="sr-only">Status de {task.title}</span>
                    <select value={task.status} onChange={(e) => void run(() => api.patchTask(task.id, { status: e.target.value as TaskStatus }))}>
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn--danger" onClick={() => void run(() => api.deleteTask(task.id))}>Excluir</button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="muted">Hoje é {formatDate(todayLocal())}. Tarefas com prazo vencido aparecem como atrasadas.</p>
      </div>
    </>
  );
}
