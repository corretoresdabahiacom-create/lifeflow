import { describe, expect, it } from "vitest";
import {
  EventCreateSchema,
  EventPatchSchema,
  ReminderCreateSchema,
  TaskCreateSchema,
  buildOccurrence,
  eventFromFields,
  eventOccurrenceDates,
  expandEvents,
  markConflicts,
  occurrenceIndex,
  recurrenceToFields,
  type CalendarEvent,
  type EventException,
  type EventRecurrence,
} from "./agenda";
import { utcMsToZoned, zonedToUtcMs } from "./timezone";

const rule = (r: Partial<EventRecurrence> & Pick<EventRecurrence, "frequency">): EventRecurrence => ({
  interval: 1,
  weekdays: [],
  until: null,
  count: null,
  ...r,
});

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  uid: "u",
  title: "Reunião",
  kind: "meeting",
  description: null,
  startDate: "2026-03-02",
  startTime: "10:00",
  durationMin: 60,
  timeZone: "America/Sao_Paulo",
  location: null,
  contact: null,
  link: null,
  notes: null,
  estimatedCostCents: null,
  reminders: [],
  recurrence: null,
  expenseTransactionId: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("fuso horário", () => {
  it("São Paulo é UTC-3 sem horário de verão", () => {
    expect(new Date(zonedToUtcMs("2026-01-15", "09:00", "America/Sao_Paulo")).toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });
  it("Nova York muda de -5 para -4 no horário de verão", () => {
    expect(new Date(zonedToUtcMs("2026-01-15", "09:00", "America/New_York")).toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(new Date(zonedToUtcMs("2026-07-15", "09:00", "America/New_York")).toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });
  it("mesmo horário de parede em dois fusos dá instantes diferentes", () => {
    expect(zonedToUtcMs("2026-07-15", "09:00", "Asia/Tokyo")).not.toBe(zonedToUtcMs("2026-07-15", "09:00", "America/Sao_Paulo"));
  });
  it("lacuna do horário de verão (02:30 em 08/03/2026, Nova York) avança, sem lançar erro", () => {
    const ms = zonedToUtcMs("2026-03-08", "02:30", "America/New_York");
    expect(utcMsToZoned(ms, "America/New_York").time).toBe("03:30");
  });
  it("horário repetido (01:30 em 01/11/2026, Nova York) usa a primeira ocorrência", () => {
    expect(new Date(zonedToUtcMs("2026-11-01", "01:30", "America/New_York")).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("ida e volta preserva data e hora", () => {
    const ms = zonedToUtcMs("2026-12-31", "23:45", "Europe/Lisbon");
    expect(utcMsToZoned(ms, "Europe/Lisbon")).toEqual({ date: "2026-12-31", time: "23:45" });
  });
});

describe("recorrência", () => {
  it("diária a cada 2 dias com contagem", () => {
    expect(eventOccurrenceDates("2026-03-01", rule({ frequency: "daily", interval: 2, count: 3 }), "2026-03-01", "2026-12-31")).toEqual([
      "2026-03-01",
      "2026-03-03",
      "2026-03-05",
    ]);
  });
  it("semanal sem dias usa o dia da semana da data inicial", () => {
    expect(eventOccurrenceDates("2026-03-02", rule({ frequency: "weekly" }), "2026-03-01", "2026-03-31")).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
      "2026-03-23",
      "2026-03-30",
    ]);
  });
  it("personalizada: segunda e quarta a cada 2 semanas, nunca antes do início", () => {
    expect(
      eventOccurrenceDates("2026-03-04", rule({ frequency: "custom", interval: 2, weekdays: [1, 3] }), "2026-03-01", "2026-03-31"),
    ).toEqual(["2026-03-04", "2026-03-16", "2026-03-18", "2026-03-30"]);
  });
  it("mensal no dia 31 não desliza para 28", () => {
    expect(eventOccurrenceDates("2026-01-31", rule({ frequency: "monthly" }), "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });
  it("anual em 29/fev cai em 28/fev nos anos comuns", () => {
    expect(eventOccurrenceDates("2024-02-29", rule({ frequency: "yearly" }), "2024-01-01", "2026-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
    ]);
  });
  it("respeita data final e janela; a contagem vale desde o início, não desde a janela", () => {
    const r = rule({ frequency: "daily", count: 5 });
    expect(eventOccurrenceDates("2026-03-01", r, "2026-03-04", "2026-03-31")).toEqual(["2026-03-04", "2026-03-05"]);
    expect(eventOccurrenceDates("2026-03-01", rule({ frequency: "daily", until: "2026-03-03" }), "2026-03-01", "2026-03-31")).toHaveLength(3);
  });
  it("occurrenceIndex devolve a posição e -1 para datas que não são ocorrência", () => {
    const r = rule({ frequency: "weekly" });
    expect(occurrenceIndex("2026-03-02", r, "2026-03-16")).toBe(2);
    expect(occurrenceIndex("2026-03-02", r, "2026-03-17")).toBe(-1);
    expect(occurrenceIndex("2026-03-02", r, "2026-02-23")).toBe(-1);
  });
});

describe("ocorrências e exceções", () => {
  const series = event({ recurrence: rule({ frequency: "weekly" }) });

  it("editar uma ocorrência não altera as demais", () => {
    const exceptions: EventException[] = [
      { seriesId: "e1", originalDate: "2026-03-09", canceled: false, overrides: { title: "Reunião especial", startTime: "15:00" } },
    ];
    const list = expandEvents([series], exceptions, "2026-03-01", "2026-03-31");
    expect(list.map((o) => [o.originalDate, o.title, o.startTime])).toEqual([
      ["2026-03-02", "Reunião", "10:00"],
      ["2026-03-09", "Reunião especial", "15:00"],
      ["2026-03-16", "Reunião", "10:00"],
      ["2026-03-23", "Reunião", "10:00"],
      ["2026-03-30", "Reunião", "10:00"],
    ]);
    expect(list[1]?.modified).toBe(true);
    expect(list[0]?.modified).toBe(false);
  });
  it("ocorrência cancelada some; as outras continuam", () => {
    const list = expandEvents([series], [{ seriesId: "e1", originalDate: "2026-03-16", canceled: true, overrides: {} }], "2026-03-01", "2026-03-31");
    expect(list.map((o) => o.originalDate)).toEqual(["2026-03-02", "2026-03-09", "2026-03-23", "2026-03-30"]);
  });
  it("ocorrência movida de dia aparece na data nova, mesmo em outro mês", () => {
    const moved: EventException[] = [{ seriesId: "e1", originalDate: "2026-03-30", canceled: false, overrides: { startDate: "2026-04-02" } }];
    expect(expandEvents([series], moved, "2026-03-01", "2026-03-31").some((o) => o.originalDate === "2026-03-30")).toBe(false);
    const april = expandEvents([series], moved, "2026-04-01", "2026-04-05");
    expect(april.map((o) => [o.originalDate, o.startDate])).toContainEqual(["2026-03-30", "2026-04-02"]);
  });
  it("sobrescrever com null remove o valor herdado (horário → dia inteiro)", () => {
    const o = buildOccurrence(series, "2026-03-09", { seriesId: "e1", originalDate: "2026-03-09", canceled: false, overrides: { startTime: null } });
    expect(o.allDay).toBe(true);
    expect(o.durationMin).toBe(1440);
  });
  it("o horário local se mantém ao cruzar a mudança de horário de verão (Nova York)", () => {
    const ny = event({ timeZone: "America/New_York", startDate: "2026-03-02", recurrence: rule({ frequency: "weekly" }) });
    const list = expandEvents([ny], [], "2026-03-02", "2026-03-16");
    expect(list.map((o) => o.startUtc)).toEqual(["2026-03-02T15:00:00.000Z", "2026-03-09T14:00:00.000Z", "2026-03-16T14:00:00.000Z"]);
  });
});

describe("conflitos", () => {
  const at = (id: string, time: string, minutes: number, extra: Partial<CalendarEvent> = {}) =>
    event({ id, startTime: time, durationMin: minutes, ...extra });

  it("detecta sobreposição parcial nos dois sentidos", () => {
    const list = markConflicts(expandEvents([at("a", "10:00", 60), at("b", "10:30", 60)], [], "2026-03-02", "2026-03-02"));
    expect(list[0]?.conflictsWith).toEqual(["b@2026-03-02"]);
    expect(list[1]?.conflictsWith).toEqual(["a@2026-03-02"]);
  });
  it("encostar (fim = início) não é conflito", () => {
    const list = markConflicts(expandEvents([at("a", "10:00", 60), at("b", "11:00", 30)], [], "2026-03-02", "2026-03-02"));
    expect(list.every((o) => o.conflictsWith.length === 0)).toBe(true);
  });
  it("evento que contém outro é conflito; o mais longo pega vários", () => {
    const list = markConflicts(expandEvents([at("a", "09:00", 240), at("b", "10:00", 30), at("c", "11:00", 30)], [], "2026-03-02", "2026-03-02"));
    expect(list.find((o) => o.eventId === "a")?.conflictsWith.sort()).toEqual(["b@2026-03-02", "c@2026-03-02"]);
  });
  it("mesmo horário de parede em fusos diferentes não conflita; instantes iguais conflitam", () => {
    const sp = at("a", "10:00", 60);
    const ny = at("b", "10:00", 60, { timeZone: "America/New_York" });
    expect(markConflicts(expandEvents([sp, ny], [], "2026-03-02", "2026-03-02")).every((o) => o.conflictsWith.length === 0)).toBe(true);
    const sameInstant = at("c", "08:00", 60, { timeZone: "America/New_York" });
    expect(markConflicts(expandEvents([sp, sameInstant], [], "2026-03-02", "2026-03-02")).every((o) => o.conflictsWith.length === 1)).toBe(true);
  });
  it("dia inteiro não conflita", () => {
    const list = markConflicts(expandEvents([at("a", "10:00", 60), event({ id: "d", startTime: null })], [], "2026-03-02", "2026-03-02"));
    expect(list.every((o) => o.conflictsWith.length === 0)).toBe(true);
  });
  it("evento que atravessa a meia-noite conflita com o do dia seguinte", () => {
    const list = markConflicts(expandEvents([at("a", "23:00", 120), at("b", "00:30", 30, { startDate: "2026-03-03" })], [], "2026-03-02", "2026-03-03"));
    expect(list.every((o) => o.conflictsWith.length === 1)).toBe(true);
  });
});

describe("conversão para o banco", () => {
  it("ida e volta de recorrência e lembretes", () => {
    const r = rule({ frequency: "custom", interval: 2, weekdays: [3, 1], until: "2027-01-01" });
    const fields = { ...recurrenceToFields(r), uid: "u", title: "x", kind: "personal", startDate: "2026-03-02", reminders: "10,60" };
    const e = eventFromFields("e", fields);
    expect(e.recurrence).toEqual({ ...r, weekdays: [1, 3] });
    expect(e.reminders).toEqual([10, 60]);
    expect(eventFromFields("e", { ...fields, ...recurrenceToFields(null) }).recurrence).toBeNull();
  });
});

describe("schemas", () => {
  const base = { title: "Dentista", startDate: "2026-03-02" };
  it("aplica padrões e rejeita campos desconhecidos (uid, status)", () => {
    const e = EventCreateSchema.parse(base);
    expect(e).toMatchObject({ kind: "personal", durationMin: 60, startTime: null, reminders: [], recurrence: null });
    expect(EventCreateSchema.safeParse({ ...base, uid: "x" }).success).toBe(false);
  });
  it("rejeita fuso, horário, link e lembretes inválidos", () => {
    expect(EventCreateSchema.safeParse({ ...base, timeZone: "Marte/Olimpo" }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, startTime: "25:00" }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, link: "javascript:alert(1)" }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, reminders: [10, 10] }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, reminders: [1, 2, 3, 4, 5, 6] }).success).toBe(false);
  });
  it("recorrência personalizada exige dias; data final e contagem são exclusivas", () => {
    expect(EventCreateSchema.safeParse({ ...base, recurrence: { frequency: "custom" } }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, recurrence: { frequency: "daily", until: "2026-04-01", count: 3 } }).success).toBe(false);
    expect(EventCreateSchema.safeParse({ ...base, recurrence: { frequency: "daily", until: "2026-03-01" } }).success).toBe(false);
  });
  it("patch exige alguma mudança e o escopo é limitado", () => {
    expect(EventPatchSchema.safeParse({ changes: {} }).success).toBe(false);
    expect(EventPatchSchema.safeParse({ scope: "tudo", changes: { title: "x" } }).success).toBe(false);
    expect(EventPatchSchema.parse({ changes: { title: "x" } }).scope).toBe("all");
  });
  it("tarefa: hora e lembrete exigem prazo", () => {
    expect(TaskCreateSchema.safeParse({ title: "x", dueTime: "10:00" }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ title: "x", reminderMinutes: 10 }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ title: "x", dueDate: "2026-03-02", reminderMinutes: 10 }).success).toBe(true);
  });
  it("lembrete avulso exige instante UTC", () => {
    expect(ReminderCreateSchema.safeParse({ title: "x", remindAt: "2026-03-02T10:00:00Z" }).success).toBe(true);
    expect(ReminderCreateSchema.safeParse({ title: "x", remindAt: "2026-03-02T10:00:00-03:00" }).success).toBe(false);
    expect(ReminderCreateSchema.safeParse({ title: "x", remindAt: "amanhã" }).success).toBe(false);
  });
});
