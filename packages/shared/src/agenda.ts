import { z } from "zod";
import { addDays, addMonthsClamped, isValidDate } from "./dates";
import { DateSchema, IdSchema, PositiveCentsSchema } from "./finance";
import { isValidTimeZone, zonedToUtcMs } from "./timezone";

/**
 * Agenda (Fase 3): eventos (com recorrência, exceções e conflitos), tarefas e lembretes.
 * Datas de calendário são texto `AAAA-MM-DD` e horários `HH:MM` no fuso do próprio evento;
 * o instante UTC é derivado (DST-aware). Schemas de entrada são `strict`.
 */

export const EVENT_KINDS = ["personal", "professional", "medical", "family", "meeting", "trip", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_FREQUENCIES = ["daily", "weekly", "monthly", "yearly", "custom"] as const;
export type EventFrequency = (typeof EVENT_FREQUENCIES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ["pending", "in_progress", "completed", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const MAX_REMINDER_MINUTES = 40_320; // 28 dias
export const MAX_EVENT_MINUTES = 60 * 24 * 14;

export const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido, use HH:MM");
export const TimeZoneSchema = z.string().max(64).refine(isValidTimeZone, "Fuso horário inválido");

const title = z.string().trim().min(1, "Informe um título").max(120);
const longText = z.string().trim().max(1000);
const shortText = z.string().trim().max(200);
const linkText = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), "Link inválido (http ou https)");

const RemindersSchema = z
  .array(z.number().int().min(0).max(MAX_REMINDER_MINUTES))
  .max(5, "No máximo 5 lembretes")
  .refine((list) => new Set(list).size === list.length, "Lembretes repetidos");

export const EventRecurrenceSchema = z
  .object({
    frequency: z.enum(EVENT_FREQUENCIES),
    /** A cada N dias/semanas/meses/anos (semanal e personalizada: a cada N semanas). */
    interval: z.number().int().min(1).max(99).default(1),
    /** 0 = domingo … 6 = sábado. Usado em semanal e personalizada. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    until: DateSchema.nullable().default(null),
    count: z.number().int().min(1).max(1000).nullable().default(null),
  })
  .strict()
  .refine((r) => r.frequency !== "custom" || r.weekdays.length > 0, {
    message: "A recorrência personalizada exige ao menos um dia da semana",
    path: ["weekdays"],
  })
  .refine((r) => r.until === null || r.count === null, {
    message: "Informe a data final ou a quantidade, não os dois",
    path: ["count"],
  });
export type EventRecurrence = z.infer<typeof EventRecurrenceSchema>;

const eventFields = {
  title,
  kind: z.enum(EVENT_KINDS),
  description: longText.nullable(),
  startDate: DateSchema,
  /** `null` = dia inteiro. */
  startTime: TimeSchema.nullable(),
  durationMin: z.number().int().min(1).max(MAX_EVENT_MINUTES),
  timeZone: TimeZoneSchema,
  location: shortText.nullable(),
  contact: shortText.nullable(),
  link: linkText.nullable(),
  notes: longText.nullable(),
  estimatedCostCents: PositiveCentsSchema.nullable(),
  reminders: RemindersSchema,
  recurrence: EventRecurrenceSchema.nullable(),
};

export const EventCreateSchema = z
  .object({
    title: eventFields.title,
    kind: eventFields.kind.default("personal"),
    description: eventFields.description.default(null),
    startDate: eventFields.startDate,
    startTime: eventFields.startTime.default(null),
    durationMin: eventFields.durationMin.default(60),
    timeZone: eventFields.timeZone.optional(),
    location: eventFields.location.default(null),
    contact: eventFields.contact.default(null),
    link: eventFields.link.default(null),
    notes: eventFields.notes.default(null),
    estimatedCostCents: eventFields.estimatedCostCents.default(null),
    reminders: eventFields.reminders.default([]),
    recurrence: eventFields.recurrence.default(null),
  })
  .strict()
  .refine((e) => e.recurrence === null || e.recurrence.until === null || e.recurrence.until >= e.startDate, {
    message: "A data final não pode ser anterior à inicial",
    path: ["recurrence", "until"],
  });
export type EventCreateInput = z.infer<typeof EventCreateSchema>;

export const EVENT_SCOPES = ["one", "following", "all"] as const;
export type EventScope = (typeof EVENT_SCOPES)[number];

export const EventChangesSchema = z
  .object({
    title: eventFields.title.optional(),
    kind: eventFields.kind.optional(),
    description: eventFields.description.optional(),
    startDate: eventFields.startDate.optional(),
    startTime: eventFields.startTime.optional(),
    durationMin: eventFields.durationMin.optional(),
    timeZone: eventFields.timeZone.optional(),
    location: eventFields.location.optional(),
    contact: eventFields.contact.optional(),
    link: eventFields.link.optional(),
    notes: eventFields.notes.optional(),
    estimatedCostCents: eventFields.estimatedCostCents.optional(),
    reminders: eventFields.reminders.optional(),
    recurrence: eventFields.recurrence.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type EventChanges = z.infer<typeof EventChangesSchema>;

export const EventPatchSchema = z
  .object({
    scope: z.enum(EVENT_SCOPES).default("all"),
    /** Data ORIGINAL da ocorrência (obrigatória em `one` e `following` de eventos recorrentes). */
    occurrenceDate: DateSchema.optional(),
    changes: EventChangesSchema,
  })
  .strict();
export type EventPatchInput = z.infer<typeof EventPatchSchema>;

export const ConflictCheckSchema = z
  .object({
    startDate: DateSchema,
    startTime: TimeSchema,
    durationMin: z.number().int().min(1).max(MAX_EVENT_MINUTES).default(60),
    timeZone: TimeZoneSchema.optional(),
    recurrence: EventRecurrenceSchema.nullable().default(null),
    /** Ignora este evento (ao editar). */
    excludeEventId: IdSchema.optional(),
  })
  .strict();
export type ConflictCheckInput = z.infer<typeof ConflictCheckSchema>;

export const EventExpenseSchema = z
  .object({
    accountId: IdSchema,
    occurrenceDate: DateSchema.optional(),
    date: DateSchema.optional(),
    amountCents: PositiveCentsSchema.optional(),
    categoryId: IdSchema.nullable().default(null),
  })
  .strict();
export type EventExpenseInput = z.infer<typeof EventExpenseSchema>;

// ---- Tarefas ----
const taskTitle = z.string().trim().min(1, "Informe um título").max(140);

export const TaskCreateSchema = z
  .object({
    title: taskTitle,
    description: longText.nullable().default(null),
    priority: z.enum(TASK_PRIORITIES).default("medium"),
    categoryId: IdSchema.nullable().default(null),
    dueDate: DateSchema.nullable().default(null),
    dueTime: TimeSchema.nullable().default(null),
    status: z.enum(["pending", "in_progress"]).default("pending"),
    /** Minutos de antecedência do lembrete em relação ao prazo; exige prazo. */
    reminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES).nullable().default(null),
  })
  .strict()
  .refine((t) => t.dueTime === null || t.dueDate !== null, { message: "Informe a data do prazo", path: ["dueDate"] })
  .refine((t) => t.reminderMinutes === null || t.dueDate !== null, {
    message: "O lembrete exige um prazo",
    path: ["reminderMinutes"],
  });
export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;

export const TaskPatchSchema = z
  .object({
    title: taskTitle.optional(),
    description: longText.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    categoryId: IdSchema.nullable().optional(),
    dueDate: DateSchema.nullable().optional(),
    dueTime: TimeSchema.nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    reminderMinutes: z.number().int().min(0).max(MAX_REMINDER_MINUTES).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");
export type TaskPatchInput = z.infer<typeof TaskPatchSchema>;

export const TaskCategoryCreateSchema = z.object({ name: z.string().trim().min(1, "Informe um nome").max(60) }).strict();
export const TaskCategoryPatchSchema = z
  .object({ name: z.string().trim().min(1).max(60).optional(), archived: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar");

// ---- Lembretes avulsos ----
export const ReminderCreateSchema = z
  .object({
    title: z.string().trim().min(1, "Informe um título").max(140),
    /** Instante UTC em ISO 8601 (ex.: 2026-12-01T12:00:00.000Z). */
    remindAt: z
      .string()
      .refine((v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(v) && !Number.isNaN(Date.parse(v)), {
        message: "Data e hora inválidas, use ISO 8601 em UTC (terminando em Z)",
      }),
  })
  .strict();
export type ReminderCreateInput = z.infer<typeof ReminderCreateSchema>;

// ---- Documentos devolvidos pela API ----
export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  kind: EventKind;
  description: string | null;
  startDate: string;
  startTime: string | null;
  durationMin: number;
  timeZone: string;
  location: string | null;
  contact: string | null;
  link: string | null;
  notes: string | null;
  estimatedCostCents: number | null;
  reminders: number[];
  recurrence: EventRecurrence | null;
  expenseTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  uid: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  categoryId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  status: TaskStatus;
  reminderMinutes: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Derivado na leitura: não concluída/cancelada e com prazo vencido. */
  overdue?: boolean;
}

export type NotificationType = "event_reminder" | "task_reminder" | "task_overdue" | "payable_due" | "reminder";

export interface AppNotification {
  id: string;
  uid: string;
  type: NotificationType;
  title: string;
  body: string;
  sourceType: "event" | "task" | "payable" | "reminder";
  sourceId: string;
  occurrenceKey: string;
  triggerAt: string;
  silent: boolean;
  read: boolean;
  readAt: string | null;
  dismissed: boolean;
  createdAt: string;
}

// ---- Recorrência ----

const MAX_LOOPS = 30_000;

function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function* candidates(startDate: string, rule: EventRecurrence): Generator<string> {
  const step = rule.interval;
  for (let n = 0; n < MAX_LOOPS; n++) {
    switch (rule.frequency) {
      case "daily":
        yield addDays(startDate, n * step);
        break;
      case "monthly":
        yield addMonthsClamped(startDate, n * step);
        break;
      case "yearly":
        yield addMonthsClamped(startDate, 12 * n * step);
        break;
      case "weekly":
      case "custom": {
        const days = rule.weekdays.length > 0 ? [...new Set(rule.weekdays)].sort((a, b) => a - b) : [weekday(startDate)];
        const weekStart = addDays(startDate, -weekday(startDate));
        const base = addDays(weekStart, 7 * step * n);
        for (const day of days) {
          const date = addDays(base, day);
          if (date >= startDate) yield date;
        }
        break;
      }
    }
  }
}

/**
 * Datas de ocorrência (datas ORIGINAIS da série) entre `from` e `to`, inclusive, em ordem.
 * A contagem (`count`) e o início valem desde `startDate`, não desde `from`. Meses curtos
 * ficam no último dia (31/jan → 28/fev → 31/mar, calculado a partir da data inicial).
 */
export function eventOccurrenceDates(startDate: string, rule: EventRecurrence | null, from: string, to: string): string[] {
  if (rule === null) return startDate >= from && startDate <= to ? [startDate] : [];
  const end = rule.until !== null && rule.until < to ? rule.until : to;
  const out: string[] = [];
  let emitted = 0;
  for (const date of candidates(startDate, rule)) {
    if (date > end) break;
    if (rule.count !== null && emitted >= rule.count) break;
    emitted++;
    if (date >= from) out.push(date);
  }
  return out;
}

/** Posição (0 = primeira) de `date` na série, ou -1 se a data não é uma ocorrência. */
export function occurrenceIndex(startDate: string, rule: EventRecurrence | null, date: string): number {
  if (!isValidDate(date)) return -1;
  const dates = eventOccurrenceDates(startDate, rule, startDate, date);
  return dates[dates.length - 1] === date ? dates.length - 1 : -1;
}

// ---- Expansão de ocorrências ----

/** Campos que uma exceção (uma ocorrência) pode sobrescrever. */
export interface OccurrenceOverrides {
  startDate?: string;
  startTime?: string | null;
  durationMin?: number;
  title?: string;
  kind?: EventKind;
  description?: string | null;
  location?: string | null;
  contact?: string | null;
  link?: string | null;
  notes?: string | null;
  estimatedCostCents?: number | null;
  reminders?: number[];
  expenseTransactionId?: string | null;
}

export interface EventException {
  seriesId: string;
  originalDate: string;
  canceled: boolean;
  overrides: OccurrenceOverrides;
}

export interface Occurrence {
  /** Identifica a ocorrência: `<eventId>@<data original>`. */
  key: string;
  eventId: string;
  originalDate: string;
  recurring: boolean;
  modified: boolean;
  title: string;
  kind: EventKind;
  description: string | null;
  startDate: string;
  startTime: string | null;
  allDay: boolean;
  durationMin: number;
  timeZone: string;
  startUtc: string;
  endUtc: string;
  location: string | null;
  contact: string | null;
  link: string | null;
  notes: string | null;
  estimatedCostCents: number | null;
  reminders: number[];
  expenseTransactionId: string | null;
  /** Chaves das ocorrências que se sobrepõem a esta (preenchido por `markConflicts`). */
  conflictsWith: string[];
}

export function buildOccurrence(event: CalendarEvent, originalDate: string, exception?: EventException): Occurrence {
  const o = exception?.overrides ?? {};
  const startDate = o.startDate ?? originalDate;
  const startTime = "startTime" in o ? (o.startTime ?? null) : event.startTime;
  const allDay = startTime === null;
  const durationMin = allDay ? 1440 : (o.durationMin ?? event.durationMin);
  const startMs = zonedToUtcMs(startDate, startTime ?? "00:00", event.timeZone);
  return {
    key: `${event.id}@${originalDate}`,
    eventId: event.id,
    originalDate,
    recurring: event.recurrence !== null,
    modified: exception !== undefined && Object.keys(exception.overrides).length > 0,
    title: o.title ?? event.title,
    kind: o.kind ?? event.kind,
    description: "description" in o ? (o.description ?? null) : event.description,
    startDate,
    startTime,
    allDay,
    durationMin,
    timeZone: event.timeZone,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + durationMin * 60_000).toISOString(),
    location: "location" in o ? (o.location ?? null) : event.location,
    contact: "contact" in o ? (o.contact ?? null) : event.contact,
    link: "link" in o ? (o.link ?? null) : event.link,
    notes: "notes" in o ? (o.notes ?? null) : event.notes,
    estimatedCostCents: "estimatedCostCents" in o ? (o.estimatedCostCents ?? null) : event.estimatedCostCents,
    reminders: o.reminders ?? event.reminders,
    expenseTransactionId: "expenseTransactionId" in o ? (o.expenseTransactionId ?? null) : event.expenseTransactionId,
    conflictsWith: [],
  };
}

/**
 * Ocorrências visíveis entre `from` e `to` (pela data EFETIVA, já com exceções aplicadas).
 * Ocorrências canceladas não aparecem. Ordenadas por início.
 */
export function expandEvents(
  events: readonly CalendarEvent[],
  exceptions: readonly EventException[],
  from: string,
  to: string,
): Occurrence[] {
  const byKey = new Map(exceptions.map((e) => [`${e.seriesId}@${e.originalDate}`, e]));
  const out: Occurrence[] = [];
  // Uma ocorrência pode ser movida para fora da própria data original: busca com folga e filtra depois.
  const searchFrom = addDays(from, -62);
  const searchTo = addDays(to, 62);
  for (const event of events) {
    const dates = eventOccurrenceDates(event.startDate, event.recurrence, searchFrom, searchTo);
    for (const originalDate of dates) {
      const exception = byKey.get(`${event.id}@${originalDate}`);
      if (exception?.canceled) continue;
      const occurrence = buildOccurrence(event, originalDate, exception);
      if (occurrence.startDate >= from && occurrence.startDate <= to) out.push(occurrence);
    }
  }
  return out.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : a.key < b.key ? -1 : 1));
}

/** Dois intervalos [início, fim) se sobrepõem; encostar (fim = início) não é conflito. */
export function overlaps(a: { startUtc: string; endUtc: string }, b: { startUtc: string; endUtc: string }): boolean {
  return a.startUtc < b.endUtc && b.startUtc < a.endUtc;
}

/** Preenche `conflictsWith`. Eventos de dia inteiro não entram na detecção. */
export function markConflicts(occurrences: Occurrence[]): Occurrence[] {
  const timed = occurrences.filter((o) => !o.allDay);
  for (const occurrence of timed) occurrence.conflictsWith = [];
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i] as Occurrence;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j] as Occurrence;
      if (b.startUtc >= a.endUtc) break; // ordenado por início: nenhum seguinte encosta em `a`
      if (overlaps(a, b)) {
        a.conflictsWith.push(b.key);
        b.conflictsWith.push(a.key);
      }
    }
  }
  return occurrences;
}

// ---- Conversão de/para o formato do banco (campos escalares) ----

export type EventDocFields = Record<string, string | number | boolean | null>;

const csv = (list: readonly number[]): string => list.join(",");
const parseCsv = (value: unknown): number[] =>
  typeof value === "string" && value !== "" ? value.split(",").map(Number).filter(Number.isInteger) : [];

export function recurrenceToFields(rule: EventRecurrence | null): EventDocFields {
  if (rule === null) {
    return { recFrequency: null, recInterval: null, recWeekdays: "", recUntil: null, recCount: null };
  }
  return {
    recFrequency: rule.frequency,
    recInterval: rule.interval,
    recWeekdays: csv([...new Set(rule.weekdays)].sort((a, b) => a - b)),
    recUntil: rule.until,
    recCount: rule.count,
  };
}

export function recurrenceFromFields(data: EventDocFields): EventRecurrence | null {
  if (typeof data["recFrequency"] !== "string") return null;
  return {
    frequency: data["recFrequency"] as EventFrequency,
    interval: typeof data["recInterval"] === "number" ? data["recInterval"] : 1,
    weekdays: parseCsv(data["recWeekdays"]),
    until: typeof data["recUntil"] === "string" ? data["recUntil"] : null,
    count: typeof data["recCount"] === "number" ? data["recCount"] : null,
  };
}

export function remindersToField(list: readonly number[]): string {
  return csv([...list].sort((a, b) => a - b));
}

export function remindersFromField(value: unknown): number[] {
  return parseCsv(value);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export function eventFromFields(id: string, data: EventDocFields): CalendarEvent {
  return {
    id,
    uid: String(data["uid"] ?? ""),
    title: String(data["title"] ?? ""),
    kind: (str(data["kind"]) ?? "other") as EventKind,
    description: str(data["description"]),
    startDate: String(data["startDate"] ?? ""),
    startTime: str(data["startTime"]),
    durationMin: num(data["durationMin"]) ?? 60,
    timeZone: str(data["timeZone"]) ?? "UTC",
    location: str(data["location"]),
    contact: str(data["contact"]),
    link: str(data["link"]),
    notes: str(data["notes"]),
    estimatedCostCents: num(data["estimatedCostCents"]),
    reminders: remindersFromField(data["reminders"]),
    recurrence: recurrenceFromFields(data),
    expenseTransactionId: str(data["expenseTransactionId"]),
    createdAt: String(data["createdAt"] ?? ""),
    updatedAt: String(data["updatedAt"] ?? ""),
  };
}

/** Campos de exceção ausentes = herda da série; presentes (inclusive `null`) = sobrescreve. */
export function overridesFromFields(data: EventDocFields): OccurrenceOverrides {
  const o: Record<string, unknown> = {};
  const has = (key: string): boolean => key in data;
  if (has("startDate") && typeof data["startDate"] === "string") o["startDate"] = data["startDate"];
  if (has("startTime")) o["startTime"] = str(data["startTime"]);
  if (has("durationMin") && typeof data["durationMin"] === "number") o["durationMin"] = data["durationMin"];
  if (has("title") && typeof data["title"] === "string") o["title"] = data["title"];
  if (has("kind") && typeof data["kind"] === "string") o["kind"] = data["kind"];
  for (const key of ["description", "location", "contact", "link", "notes", "expenseTransactionId"]) {
    if (has(key)) o[key] = str(data[key]);
  }
  if (has("estimatedCostCents")) o["estimatedCostCents"] = num(data["estimatedCostCents"]);
  if (has("reminders")) o["reminders"] = remindersFromField(data["reminders"]);
  return o as OccurrenceOverrides;
}

export function exceptionFromFields(data: EventDocFields): EventException {
  return {
    seriesId: String(data["seriesId"] ?? ""),
    originalDate: String(data["originalDate"] ?? ""),
    canceled: data["canceled"] === true,
    overrides: overridesFromFields(data),
  };
}
