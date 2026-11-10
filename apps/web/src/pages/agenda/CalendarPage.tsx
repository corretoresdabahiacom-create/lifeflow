import type { CalendarEvent, EventScope, Occurrence } from "@lifeflow/shared";
import { useState } from "react";
import { useApi } from "../../app/ApiProvider";
import { useProfile } from "../../app/ProfileProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import type { ConflictItem } from "../../lib/api";
import { useIdempotencyKey } from "../../lib/idempotency";
import { todayLocal, useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";
import { VIEW_LABELS, dayLabel, groupByDate, monthWeeks, rangeFor, shiftCursor, titleFor, type CalendarView } from "./calendar";
import { ConflictNotice, EventForm, formatClock } from "./EventForm";
import { KIND_LABELS } from "./eventForm";

type Editing = { kind: "new" } | { kind: "edit"; event: CalendarEvent; occurrence: Occurrence } | null;

const SCOPE_LABELS: Record<EventScope, string> = {
  one: "Somente esta ocorrência",
  following: "Esta e as próximas",
  all: "Toda a série",
};

function ExpenseAction({ occurrence, onDone }: { occurrence: Occurrence; onDone: () => void }) {
  const api = useApi();
  const money = useMoney();
  const key = useIdempotencyKey();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accounts = useLoad(() => (open ? api.listAccounts() : Promise.resolve(null)), [open]);
  const cost = occurrence.estimatedCostCents;
  if (cost === null || occurrence.expenseTransactionId !== null) {
    return occurrence.expenseTransactionId !== null ? <span className="badge">Despesa registrada</span> : null;
  }
  const list = accounts.data?.accounts ?? [];
  const chosen = accountId || list[0]?.id || "";

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.createEventExpense(
        occurrence.eventId,
        { accountId: chosen, ...(occurrence.recurring ? { occurrenceDate: occurrence.originalDate } : {}) },
        key.current(),
      );
      key.renew();
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Registrar despesa ({money(cost)})
      </button>
    );
  }
  return (
    <div className="inline-form">
      <label className="field">
        <span>Conta</span>
        <select value={chosen} onChange={(e) => setAccountId(e.target.value)}>
          {list.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <button type="button" className="btn btn--primary" disabled={busy || !chosen} onClick={() => void confirm()}>
        {busy ? "Registrando…" : `Registrar ${money(cost)}`}
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancelar</button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
  );
}

function OccurrenceRow({
  occurrence,
  profileZone,
  onEdit,
  onDelete,
  onChanged,
}: {
  occurrence: Occurrence;
  profileZone: string;
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const o = occurrence;
  const hasConflict = o.conflictsWith.length > 0;
  const when = o.allDay ? "Dia inteiro" : `${formatClock(o.startUtc, o.timeZone)}–${formatClock(o.endUtc, o.timeZone)}`;
  return (
    <li className={hasConflict ? "event event--conflict" : "event"}>
      <div className="event__main">
        <strong>{o.title}</strong>
        <span className="muted">
          {when}
          {o.timeZone !== profileZone ? ` (${o.timeZone})` : ""} · {KIND_LABELS[o.kind]}
          {o.location ? ` · ${o.location}` : ""}
        </span>
        <span className="badges">
          {hasConflict ? <span className="badge badge--danger">Conflito</span> : null}
          {o.recurring ? <span className="badge">Recorrente</span> : null}
          {o.modified ? <span className="badge">Editada</span> : null}
        </span>
      </div>
      <div className="event__actions">
        <ExpenseAction occurrence={o} onDone={onChanged} />
        <button type="button" className="btn" onClick={onEdit}>Editar</button>
        <button type="button" className="btn btn--danger" onClick={onDelete}>Excluir</button>
      </div>
    </li>
  );
}

function DeletePanel({ occurrence, onDone, onCancel }: { occurrence: Occurrence; onDone: () => void; onCancel: () => void }) {
  const api = useApi();
  const [scope, setScope] = useState<EventScope>("one");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteEvent(occurrence.eventId, occurrence.recurring ? scope : "all", occurrence.recurring ? occurrence.originalDate : undefined);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" role="alertdialog" aria-labelledby="ev-del-title">
      <h2 id="ev-del-title">Excluir “{occurrence.title}”?</h2>
      {occurrence.recurring ? (
        <fieldset className="field">
          <legend>Excluir</legend>
          {(["one", "following", "all"] as const).map((value) => (
            <label key={value} className="check">
              <input type="radio" name="del-scope" checked={scope === value} onChange={() => setScope(value)} />
              {SCOPE_LABELS[value]}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="muted">Esta ação não pode ser desfeita.</p>
      )}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void confirm()}>
          {busy ? "Excluindo…" : "Excluir"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

export function CalendarPage() {
  const api = useApi();
  const [view, setView] = useState<CalendarView>("week");
  const [cursor, setCursor] = useState(todayLocal());
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Occurrence | null>(null);
  const [flash, setFlash] = useState<{ text: string; conflicts: ConflictItem[] } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const range = rangeFor(view, cursor);
  const { data, error, loading, reload } = useLoad(() => api.listEvents(range.from, range.to), [range.from, range.to]);
  const { profile } = useProfile();
  const profileZone = profile?.timezone ?? "America/Sao_Paulo";
  const groups = groupByDate(data?.occurrences ?? []);

  async function startEdit(occurrence: Occurrence) {
    setOpenError(null);
    try {
      const event = await api.getEvent(occurrence.eventId);
      setEditing({ kind: "edit", event, occurrence });
    } catch (e) {
      setOpenError(describeError(e));
    }
  }

  function saved(text: string, conflicts: ConflictItem[]) {
    setEditing(null);
    setDeleting(null);
    setFlash({ text, conflicts });
    reload();
  }

  const header = (
    <div className="calendar__bar">
      <div className="seg" role="group" aria-label="Visualização">
        {(Object.keys(VIEW_LABELS) as CalendarView[]).map((value) => (
          <button key={value} type="button" className={view === value ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={view === value} onClick={() => setView(value)}>
            {VIEW_LABELS[value]}
          </button>
        ))}
      </div>
      <div className="calendar__nav">
        <button type="button" className="btn" aria-label="Período anterior" onClick={() => setCursor(shiftCursor(view, cursor, -1))}>‹</button>
        <button type="button" className="btn" onClick={() => setCursor(todayLocal())}>Hoje</button>
        <button type="button" className="btn" aria-label="Próximo período" onClick={() => setCursor(shiftCursor(view, cursor, 1))}>›</button>
      </div>
      <h2 className="calendar__title" aria-live="polite">{titleFor(view, cursor)}</h2>
      <button type="button" className="btn btn--primary" onClick={() => { setFlash(null); setEditing({ kind: "new" }); }}>Novo evento</button>
    </div>
  );

  const days = view === "month" ? [] : [...new Set([...groups.keys(), ...(view === "day" ? [cursor] : [])])].sort();

  return (
    <>
      {header}
      {flash ? (
        <div className="notice notice--ok" role="status">
          <strong>{flash.text}</strong>
          <ConflictNotice conflicts={flash.conflicts} />
        </div>
      ) : null}
      {openError ? <p className="form-error" role="alert">{openError}</p> : null}

      {editing ? (
        <EventForm
          key={editing.kind === "edit" ? `${editing.event.id}@${editing.occurrence.originalDate}` : "new"}
          {...(editing.kind === "edit" ? { event: editing.event, occurrence: editing.occurrence } : {})}
          defaultDate={cursor}
          onDone={(conflicts) => saved("Evento salvo.", conflicts)}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {deleting ? <DeletePanel occurrence={deleting} onDone={() => saved("Evento excluído.", [])} onCancel={() => setDeleting(null)} /> : null}

      {loading && !data ? <LoadingState label="Carregando agenda…" /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}

      {data && view === "month" ? (
        <div className="card month" role="grid" aria-label="Calendário do mês">
          <div className="month__head" role="row">
            {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((d) => (
              <span key={d} role="columnheader">{d}</span>
            ))}
          </div>
          {monthWeeks(cursor).map((week) => (
            <div key={week[0]} className="month__week" role="row">
              {week.map((date) => {
                const list = groups.get(date) ?? [];
                const inMonth = date.slice(0, 7) === cursor.slice(0, 7);
                const hasConflict = list.some((o) => o.conflictsWith.length > 0);
                return (
                  <button
                    key={date}
                    type="button"
                    role="gridcell"
                    className={[
                      "month__day",
                      inMonth ? "" : "month__day--out",
                      date === todayLocal() ? "month__day--today" : "",
                      date === cursor ? "month__day--selected" : "",
                    ].join(" ")}
                    aria-label={`${dayLabel(date)}: ${list.length} evento(s)${hasConflict ? ", com conflito" : ""}`}
                    onClick={() => setCursor(date)}
                  >
                    <span>{Number(date.slice(8))}</span>
                    {list.length > 0 ? <span className={hasConflict ? "dot dot--danger" : "dot"}>{list.length}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}

      {data ? (
        <div className="card" aria-live="polite">
          {view === "month" ? <h3>{dayLabel(cursor)}</h3> : null}
          {(view === "month" ? [cursor] : days).map((date) => {
            const list = groups.get(date) ?? [];
            return (
              <section key={date} className="day" aria-label={dayLabel(date)}>
                {view !== "month" ? <h3>{dayLabel(date)}</h3> : null}
                {list.length === 0 ? (
                  <EmptyState title="Nada neste dia">Use “Novo evento” para criar um compromisso.</EmptyState>
                ) : (
                  <ul className="events">
                    {list.map((o) => (
                      <OccurrenceRow
                        key={o.key}
                        occurrence={o}
                        profileZone={profileZone}
                        onEdit={() => void startEdit(o)}
                        onDelete={() => { setEditing(null); setDeleting(o); }}
                        onChanged={reload}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          {view !== "month" && days.length === 0 ? <EmptyState title="Nenhum evento neste período" /> : null}
          {data.conflictCount > 0 ? (
            <p className="muted">{data.conflictCount} ocorrência(s) com sobreposição de horário neste período.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
