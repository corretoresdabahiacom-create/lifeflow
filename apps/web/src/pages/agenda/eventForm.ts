import {
  parseMoneyToCents,
  type CalendarEvent,
  type EventChanges,
  type EventFrequency,
  type EventKind,
  type EventRecurrence,
  type Occurrence,
} from "@lifeflow/shared";
import type { EventInput } from "../../lib/api";

export const KIND_LABELS: Record<EventKind, string> = {
  personal: "Pessoal",
  professional: "Profissional",
  medical: "Médico",
  family: "Familiar",
  meeting: "Reunião",
  trip: "Viagem",
  other: "Outro",
};

export const REPEAT_LABELS: Record<"none" | EventFrequency, string> = {
  none: "Não repete",
  daily: "Todos os dias",
  weekly: "Toda semana",
  monthly: "Todo mês",
  yearly: "Todo ano",
  custom: "Personalizada (dias da semana)",
};

export const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
export const REMINDER_OPTIONS = [
  { minutes: 0, label: "Na hora" },
  { minutes: 10, label: "10 min antes" },
  { minutes: 30, label: "30 min antes" },
  { minutes: 60, label: "1 h antes" },
  { minutes: 1440, label: "1 dia antes" },
] as const;

export interface EventFormState {
  title: string;
  kind: EventKind;
  date: string;
  allDay: boolean;
  time: string;
  duration: string;
  timeZone: string;
  location: string;
  contact: string;
  link: string;
  notes: string;
  cost: string;
  reminders: number[];
  repeat: "none" | EventFrequency;
  interval: string;
  weekdays: number[];
  endMode: "never" | "until" | "count";
  until: string;
  count: string;
}

export function emptyState(date: string, timeZone: string): EventFormState {
  return {
    title: "",
    kind: "personal",
    date,
    allDay: false,
    time: "09:00",
    duration: "60",
    timeZone,
    location: "",
    contact: "",
    link: "",
    notes: "",
    cost: "",
    reminders: [],
    repeat: "none",
    interval: "1",
    weekdays: [],
    endMode: "never",
    until: "",
    count: "",
  };
}

const centsToText = (cents: number | null): string =>
  cents === null ? "" : `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;

/** Estado do formulário a partir de um evento (série) e, opcionalmente, de uma ocorrência já resolvida. */
export function stateFromEvent(event: CalendarEvent, occurrence?: Occurrence): EventFormState {
  const rule = event.recurrence;
  const o = occurrence;
  const startTime = o ? o.startTime : event.startTime;
  return {
    title: o?.title ?? event.title,
    kind: o?.kind ?? event.kind,
    date: o?.startDate ?? event.startDate,
    allDay: startTime === null,
    time: startTime ?? "09:00",
    duration: String(startTime === null ? 60 : (o?.durationMin ?? event.durationMin)),
    timeZone: event.timeZone,
    location: (o ? o.location : event.location) ?? "",
    contact: (o ? o.contact : event.contact) ?? "",
    link: (o ? o.link : event.link) ?? "",
    notes: (o ? o.notes : event.notes) ?? "",
    cost: centsToText(o ? o.estimatedCostCents : event.estimatedCostCents),
    reminders: o?.reminders ?? event.reminders,
    repeat: rule?.frequency ?? "none",
    interval: String(rule?.interval ?? 1),
    weekdays: rule?.weekdays ?? [],
    endMode: rule?.until ? "until" : rule?.count ? "count" : "never",
    until: rule?.until ?? "",
    count: rule?.count ? String(rule.count) : "",
  };
}

export type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string };

function buildRecurrence(state: EventFormState): BuildResult<EventRecurrence | null> {
  if (state.repeat === "none") return { ok: true, value: null };
  const interval = Number(state.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) {
    return { ok: false, error: "Informe um intervalo de 1 a 99." };
  }
  if (state.repeat === "custom" && state.weekdays.length === 0) {
    return { ok: false, error: "Escolha ao menos um dia da semana." };
  }
  let until: string | null = null;
  let count: number | null = null;
  if (state.endMode === "until") {
    if (!state.until) return { ok: false, error: "Informe a data final da repetição." };
    if (state.until < state.date) return { ok: false, error: "A data final não pode ser anterior à inicial." };
    until = state.until;
  } else if (state.endMode === "count") {
    count = Number(state.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) return { ok: false, error: "Informe a quantidade de repetições (1 a 1000)." };
  }
  const weekdays = state.repeat === "weekly" || state.repeat === "custom" ? [...state.weekdays].sort((a, b) => a - b) : [];
  return { ok: true, value: { frequency: state.repeat, interval, weekdays, until, count } };
}

/** Valida o formulário e monta os campos comuns (sem recorrência nem fuso). */
function buildCommon(state: EventFormState): BuildResult<Required<Omit<EventChanges, "recurrence" | "timeZone" | "description">>> {
  const title = state.title.trim();
  if (!title) return { ok: false, error: "Informe o título." };
  if (!state.date) return { ok: false, error: "Informe a data." };
  const duration = Number(state.duration);
  if (!state.allDay && (!Number.isInteger(duration) || duration < 1)) return { ok: false, error: "Informe a duração em minutos." };
  let estimatedCostCents: number | null = null;
  if (state.cost.trim() !== "") {
    estimatedCostCents = parseMoneyToCents(state.cost);
    if (estimatedCostCents === null || estimatedCostCents <= 0) return { ok: false, error: "Custo previsto inválido." };
  }
  const link = state.link.trim();
  if (link !== "" && !/^https?:\/\/\S+$/i.test(link)) return { ok: false, error: "O link deve começar com http:// ou https://." };
  const text = (value: string): string | null => (value.trim() === "" ? null : value.trim());
  return {
    ok: true,
    value: {
      title,
      kind: state.kind,
      startDate: state.date,
      startTime: state.allDay ? null : state.time,
      durationMin: state.allDay ? 1440 : duration,
      location: text(state.location),
      contact: text(state.contact),
      link: link === "" ? null : link,
      notes: text(state.notes),
      estimatedCostCents,
      reminders: [...state.reminders].sort((a, b) => a - b),
    },
  };
}

export function buildCreateInput(state: EventFormState): BuildResult<EventInput> {
  const common = buildCommon(state);
  if (!common.ok) return common;
  const recurrence = buildRecurrence(state);
  if (!recurrence.ok) return recurrence;
  return { ok: true, value: { ...common.value, timeZone: state.timeZone, recurrence: recurrence.value } };
}

/** Alterações para PATCH. Em "uma ocorrência" fuso e recorrência não são enviados. */
export function buildChanges(state: EventFormState, scope: "one" | "following" | "all"): BuildResult<EventChanges> {
  const common = buildCommon(state);
  if (!common.ok) return common;
  if (scope === "one") return { ok: true, value: common.value };
  const recurrence = buildRecurrence(state);
  if (!recurrence.ok) return recurrence;
  return { ok: true, value: { ...common.value, timeZone: state.timeZone, recurrence: recurrence.value } };
}
