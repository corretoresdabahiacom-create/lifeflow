import { EVENT_KINDS, type CalendarEvent, type EventScope, type Occurrence } from "@lifeflow/shared";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { useProfile } from "../../app/ProfileProvider";
import { ApiError, type ConflictItem } from "../../lib/api";
import { useIdempotencyKey } from "../../lib/idempotency";
import { describeError } from "../../lib/useLoad";
import {
  KIND_LABELS,
  REMINDER_OPTIONS,
  REPEAT_LABELS,
  WEEKDAY_LABELS,
  buildChanges,
  buildCreateInput,
  emptyState,
  stateFromEvent,
  type EventFormState,
} from "./eventForm";

const COMMON_ZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Fortaleza",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "UTC",
];

const SCOPE_LABELS: Record<EventScope, string> = {
  one: "Somente esta ocorrência",
  following: "Esta e as próximas",
  all: "Toda a série",
};

export function formatClock(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" });
}

export function ConflictNotice({ conflicts }: { conflicts: ConflictItem[] }) {
  if (conflicts.length === 0) return null;
  const first = conflicts[0] as ConflictItem;
  return (
    <div className="notice notice--warn" role="status" aria-live="polite">
      <strong>Conflito de horário</strong>
      <span>
        Este horário se sobrepõe a {first.with.map((w) => `“${w.title}”`).join(", ")}
        {conflicts.length > 1 ? ` e a outros eventos em mais ${conflicts.length - 1} data(s)` : ""}. Você ainda pode salvar.
      </span>
    </div>
  );
}

interface Props {
  /** Evento (série) a editar; ausente = novo evento. */
  event?: CalendarEvent;
  /** Ocorrência clicada (em séries). */
  occurrence?: Occurrence;
  defaultDate: string;
  /** Recebe os conflitos do que foi salvo (a página mostra o aviso; salvar nunca é bloqueado). */
  onDone: (conflicts: ConflictItem[]) => void;
  onCancel: () => void;
}

export function EventForm({ event, occurrence, defaultDate, onDone, onCancel }: Props) {
  const api = useApi();
  const { profile } = useProfile();
  const key = useIdempotencyKey();
  const profileZone = profile?.timezone ?? "America/Sao_Paulo";
  const recurring = event?.recurrence != null;
  const [scope, setScope] = useState<EventScope>(recurring ? "one" : "all");
  const [state, setState] = useState<EventFormState>(() =>
    event ? stateFromEvent(event, occurrence) : emptyState(defaultDate, profileZone),
  );
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof EventFormState>(field: K, value: EventFormState[K]) => setState((s) => ({ ...s, [field]: value }));
  const toggle = (field: "reminders" | "weekdays", value: number) =>
    setState((s) => ({ ...s, [field]: s[field].includes(value) ? s[field].filter((v) => v !== value) : [...s[field], value] }));

  const zones = useMemo(() => [...new Set([state.timeZone, profileZone, ...COMMON_ZONES])], [state.timeZone, profileZone]);
  const seriesFieldsLocked = recurring && scope === "one";

  // Aviso de conflito ao vivo: só avisa, nunca impede salvar.
  useEffect(() => {
    if (state.allDay || !state.date || !state.time) {
      setConflicts([]);
      return;
    }
    const duration = Number(state.duration);
    if (!Number.isInteger(duration) || duration < 1) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .checkConflicts({
          startDate: state.date,
          startTime: state.time,
          durationMin: duration,
          timeZone: state.timeZone,
          ...(event ? { excludeEventId: event.id } : {}),
        })
        .then((reply) => {
          if (!cancelled) setConflicts(reply.conflicts);
        })
        .catch(() => {
          if (!cancelled) setConflicts([]);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, event, state.allDay, state.date, state.time, state.duration, state.timeZone, state.repeat]);

  async function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!event) {
        const built = buildCreateInput(state);
        if (!built.ok) return setError(built.error);
        const created = await api.createEvent(built.value, key.current());
        key.renew();
        onDone(created.conflicts);
        return;
      } else {
        // Em "toda a série", a data só muda se o usuário a alterou (senão manteria a data da ocorrência clicada).
        const effective: EventFormState =
          scope === "all" && occurrence && state.date === occurrence.startDate ? { ...state, date: event.startDate } : state;
        const built = buildChanges(effective, scope);
        if (!built.ok) return setError(built.error);
        const saved = await api.patchEvent(event.id, {
          scope: recurring ? scope : "all",
          ...(recurring ? { occurrenceDate: occurrence?.originalDate ?? event.startDate } : {}),
          changes: built.value,
        });
        onDone(saved.conflicts ?? []);
      }
    } catch (e) {
      // Erro de rede/servidor: a chave NÃO é renovada, então tentar de novo nunca cria dois eventos.
      setError(e instanceof ApiError ? e.message : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} aria-labelledby="ev-form-title">
      <h2 id="ev-form-title">{event ? "Editar evento" : "Novo evento"}</h2>

      {recurring ? (
        <fieldset className="field">
          <legend>Aplicar a</legend>
          {(["one", "following", "all"] as const).map((value) => (
            <label key={value} className="check">
              <input type="radio" name="scope" checked={scope === value} onChange={() => setScope(value)} />
              {SCOPE_LABELS[value]}
            </label>
          ))}
        </fieldset>
      ) : null}

      <label className="field">
        <span>Título</span>
        <input value={state.title} maxLength={120} onChange={(e) => set("title", e.target.value)} required />
      </label>
      <label className="field">
        <span>Tipo</span>
        <select value={state.kind} onChange={(e) => set("kind", e.target.value as EventFormState["kind"])}>
          {EVENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Data</span>
        <input type="date" value={state.date} onChange={(e) => set("date", e.target.value)} required />
      </label>
      <label className="check">
        <input type="checkbox" checked={state.allDay} onChange={(e) => set("allDay", e.target.checked)} />
        Dia inteiro
      </label>
      {!state.allDay ? (
        <>
          <label className="field">
            <span>Horário</span>
            <input type="time" value={state.time} onChange={(e) => set("time", e.target.value)} required />
          </label>
          <label className="field">
            <span>Duração (minutos)</span>
            <input type="number" min={1} value={state.duration} onChange={(e) => set("duration", e.target.value)} required />
          </label>
        </>
      ) : null}
      <label className="field">
        <span>Fuso horário</span>
        <select value={state.timeZone} disabled={seriesFieldsLocked} onChange={(e) => set("timeZone", e.target.value)}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>{zone}</option>
          ))}
        </select>
      </label>

      <ConflictNotice conflicts={conflicts} />

      <label className="field">
        <span>Local</span>
        <input value={state.location} maxLength={200} onChange={(e) => set("location", e.target.value)} />
      </label>
      <label className="field">
        <span>Contato</span>
        <input value={state.contact} maxLength={200} onChange={(e) => set("contact", e.target.value)} />
      </label>
      <label className="field">
        <span>Link</span>
        <input type="url" value={state.link} placeholder="https://" onChange={(e) => set("link", e.target.value)} />
      </label>
      <label className="field">
        <span>Custo previsto (opcional)</span>
        <input inputMode="decimal" value={state.cost} placeholder="0,00" onChange={(e) => set("cost", e.target.value)} />
        <small className="muted">Não vira despesa sozinho: você decide depois se quer registrar.</small>
      </label>
      <label className="field">
        <span>Observações</span>
        <textarea value={state.notes} maxLength={1000} rows={2} onChange={(e) => set("notes", e.target.value)} />
      </label>

      <fieldset className="field">
        <legend>Lembretes</legend>
        {REMINDER_OPTIONS.map((option) => (
          <label key={option.minutes} className="check">
            <input type="checkbox" checked={state.reminders.includes(option.minutes)} onChange={() => toggle("reminders", option.minutes)} />
            {option.label}
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span>Repetição</span>
        <select value={state.repeat} disabled={seriesFieldsLocked} onChange={(e) => set("repeat", e.target.value as EventFormState["repeat"])}>
          {(Object.keys(REPEAT_LABELS) as Array<keyof typeof REPEAT_LABELS>).map((value) => (
            <option key={value} value={value}>{REPEAT_LABELS[value]}</option>
          ))}
        </select>
      </label>
      {state.repeat !== "none" ? (
        <>
          <label className="field">
            <span>A cada (intervalo)</span>
            <input type="number" min={1} max={99} value={state.interval} disabled={seriesFieldsLocked} onChange={(e) => set("interval", e.target.value)} />
          </label>
          {state.repeat === "weekly" || state.repeat === "custom" ? (
            <fieldset className="field">
              <legend>Dias da semana</legend>
              <div className="weekdays">
                {WEEKDAY_LABELS.map((label, index) => (
                  <label key={label} className="check">
                    <input type="checkbox" checked={state.weekdays.includes(index)} disabled={seriesFieldsLocked} onChange={() => toggle("weekdays", index)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <label className="field">
            <span>Termina</span>
            <select value={state.endMode} disabled={seriesFieldsLocked} onChange={(e) => set("endMode", e.target.value as EventFormState["endMode"])}>
              <option value="never">Nunca</option>
              <option value="until">Em uma data</option>
              <option value="count">Após N vezes</option>
            </select>
          </label>
          {state.endMode === "until" ? (
            <label className="field">
              <span>Data final</span>
              <input type="date" value={state.until} disabled={seriesFieldsLocked} onChange={(e) => set("until", e.target.value)} />
            </label>
          ) : null}
          {state.endMode === "count" ? (
            <label className="field">
              <span>Quantidade de repetições</span>
              <input type="number" min={1} max={1000} value={state.count} disabled={seriesFieldsLocked} onChange={(e) => set("count", e.target.value)} />
            </label>
          ) : null}
        </>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
