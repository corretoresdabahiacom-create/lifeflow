import {
  ConflictCheckSchema,
  EVENT_KINDS,
  EVENT_SCOPES,
  EventCreateSchema,
  EventExpenseSchema,
  EventPatchSchema,
  addDays,
  buildOccurrence,
  eventFromFields,
  exceptionFromFields,
  expandEvents,
  isValidDate,
  markConflicts,
  occurrenceIndex,
  recurrenceToFields,
  remindersToField,
  signedAmount,
  type CalendarEvent,
  type EventChanges,
  type EventException,
  type EventRecurrence,
  type EventScope,
  type Occurrence,
  type Transaction,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import type { DocData, StoredDoc, WriteOp } from "../firestore";
import { allow, json, parseBody } from "../http";
import { balanceOp, transactionDoc } from "../finance/ledger";
import {
  assertId,
  checkCategory,
  commitIdempotent,
  commitOrConflict,
  dateParam,
  enumParam,
  loadAccount,
  notFound,
  pathsFor,
  profileTimeZone,
  publicDoc,
  readAll,
  readIdempotency,
  replayResponse,
  sha256Hex,
  todayFor,
  type Ctx,
} from "../finance/common";

const MAX_RANGE_DAYS = 400;
const CONFLICT_HORIZON_DAYS = 180;
const MAX_EXCEPTIONS_TOUCHED = 20;

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

// ------------------------------------------------------------------ leitura

async function loadEvents(ctx: Ctx, upTo: string): Promise<CalendarEvent[]> {
  const { docs } = await readAll(
    ctx.db,
    pathsFor(ctx.uid).parent,
    {
      collection: "events",
      filters: [{ field: "startDate", op: "LESS_THAN_OR_EQUAL", value: upTo }],
      orderBy: { field: "startDate", direction: "ASCENDING" },
    },
    2000,
  );
  return docs.map((doc) => eventFromFields(doc.id, doc.data));
}

async function loadExceptions(ctx: Ctx, from: string, to: string): Promise<EventException[]> {
  const { docs } = await readAll(
    ctx.db,
    pathsFor(ctx.uid).parent,
    {
      collection: "eventExceptions",
      filters: [
        { field: "originalDate", op: "GREATER_THAN_OR_EQUAL", value: addDays(from, -62) },
        { field: "originalDate", op: "LESS_THAN_OR_EQUAL", value: addDays(to, 62) },
      ],
      orderBy: { field: "originalDate", direction: "ASCENDING" },
    },
    2000,
  );
  return docs.map((doc) => exceptionFromFields(doc.data));
}

/** Ocorrências da janela, com conflitos marcados. Usado pela listagem e pelas notificações. */
export async function occurrencesBetween(ctx: Ctx, from: string, to: string): Promise<Occurrence[]> {
  const [events, exceptions] = await Promise.all([loadEvents(ctx, to), loadExceptions(ctx, from, to)]);
  return markConflicts(expandEvents(events, exceptions, from, to));
}

export interface ConflictReport {
  /** Data efetiva da ocorrência proposta. */
  startDate: string;
  startUtc: string;
  endUtc: string;
  with: Array<{ key: string; eventId: string; title: string; startUtc: string; endUtc: string }>;
}

/** Conflitos de um evento (já gravado ou apenas proposto) com os demais, até 180 dias à frente. */
async function conflictsFor(ctx: Ctx, candidate: CalendarEvent): Promise<ConflictReport[]> {
  const from = candidate.startDate;
  const horizon = addDays(from, CONFLICT_HORIZON_DAYS);
  const to = candidate.recurrence?.until && candidate.recurrence.until < horizon ? candidate.recurrence.until : horizon;
  const [others, exceptions] = await Promise.all([loadEvents(ctx, to), loadExceptions(ctx, from, to)]);
  const all = [...others.filter((event) => event.id !== candidate.id), candidate];
  const list = markConflicts(expandEvents(all, exceptions, from, to));
  const byKey = new Map(list.map((o) => [o.key, o]));
  const reports: ConflictReport[] = [];
  for (const occurrence of list) {
    if (occurrence.eventId !== candidate.id || occurrence.conflictsWith.length === 0) continue;
    reports.push({
      startDate: occurrence.startDate,
      startUtc: occurrence.startUtc,
      endUtc: occurrence.endUtc,
      with: occurrence.conflictsWith.flatMap((key) => {
        const other = byKey.get(key);
        return other
          ? [{ key, eventId: other.eventId, title: other.title, startUtc: other.startUtc, endUtc: other.endUtc }]
          : [];
      }),
    });
    if (reports.length >= 50) break;
  }
  return reports;
}

// ------------------------------------------------------------------ gravação

interface EventDocInput {
  uid: string;
  title: string;
  kind: string;
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

function eventDoc(e: EventDocInput, requestHash?: string): DocData {
  return {
    uid: e.uid,
    title: e.title,
    kind: e.kind,
    description: e.description,
    startDate: e.startDate,
    startTime: e.startTime,
    durationMin: e.startTime === null ? 1440 : e.durationMin,
    timeZone: e.timeZone,
    location: e.location,
    contact: e.contact,
    link: e.link,
    notes: e.notes,
    estimatedCostCents: e.estimatedCostCents,
    reminders: remindersToField(e.reminders),
    ...recurrenceToFields(e.recurrence),
    expenseTransactionId: e.expenseTransactionId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(requestHash ? { requestHash } : {}),
  };
}

const exceptionId = async (seriesId: string, originalDate: string): Promise<string> =>
  `x${(await sha256Hex(`exception|${seriesId}|${originalDate}`)).slice(0, 39)}`;

async function seriesExceptions(ctx: Ctx, seriesId: string): Promise<StoredDoc[]> {
  const docs = await ctx.db.query(pathsFor(ctx.uid).parent, {
    collection: "eventExceptions",
    filters: [{ field: "seriesId", op: "EQUAL", value: seriesId }],
    limit: MAX_EXCEPTIONS_TOUCHED + 1,
  });
  if (docs.length > MAX_EXCEPTIONS_TOUCHED) {
    throw new HttpError(
      422,
      "too_many_exceptions",
      `A série tem mais de ${MAX_EXCEPTIONS_TOUCHED} ocorrências editadas; esta operação não é suportada`,
    );
  }
  return docs;
}

const toEvent = (id: string, data: DocData): CalendarEvent => eventFromFields(id, data);

function validateMerged(event: CalendarEvent): void {
  if (event.recurrence?.until && event.recurrence.until < event.startDate) {
    throw new HttpError(422, "invalid_recurrence", "A data final não pode ser anterior à inicial");
  }
}

function applyChanges(event: CalendarEvent, changes: EventChanges, updatedAt: string): CalendarEvent {
  const next: CalendarEvent = { ...event, updatedAt };
  const assign = <K extends keyof CalendarEvent>(key: K, value: CalendarEvent[K] | undefined): void => {
    if (value !== undefined) next[key] = value;
  };
  assign("title", changes.title);
  assign("kind", changes.kind);
  assign("description", changes.description);
  assign("startDate", changes.startDate);
  assign("startTime", changes.startTime);
  assign("durationMin", changes.durationMin);
  assign("timeZone", changes.timeZone);
  assign("location", changes.location);
  assign("contact", changes.contact);
  assign("link", changes.link);
  assign("notes", changes.notes);
  assign("estimatedCostCents", changes.estimatedCostCents);
  assign("reminders", changes.reminders);
  assign("recurrence", changes.recurrence);
  if (next.startTime === null) next.durationMin = 1440;
  return next;
}

// ------------------------------------------------------------------ roteamento

export async function eventsRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listEvents(ctx) : createEvent(ctx);
  }
  if (id === "check-conflicts") {
    if (action !== undefined) throw notFound("Rota");
    allow(method, ["POST"]);
    return checkConflicts(ctx);
  }
  assertId(id);
  if (action === "expense") {
    allow(method, ["POST"]);
    return createEventExpense(ctx, id);
  }
  if (action !== undefined) throw notFound("Rota");
  allow(method, ["GET", "PATCH", "DELETE"]);
  if (method === "GET") return getEvent(ctx, id);
  return method === "PATCH" ? patchEvent(ctx, id) : deleteEvent(ctx, id);
}

async function listEvents(ctx: Ctx): Promise<Response> {
  const today = await todayFor(ctx);
  const from = dateParam(ctx.url, "from", isValidDate) ?? today;
  const to = dateParam(ctx.url, "to", isValidDate) ?? addDays(from, 30);
  if (from > to) throw new HttpError(400, "invalid_query", "O período inicial não pode ser posterior ao final");
  if (daysBetween(from, to) > MAX_RANGE_DAYS) {
    throw new HttpError(400, "invalid_query", `O período máximo é de ${MAX_RANGE_DAYS} dias`);
  }
  const kind = enumParam(ctx.url, "kind", EVENT_KINDS);
  const conflictsOnly = ctx.url.searchParams.get("conflicts") === "true";
  let occurrences = await occurrencesBetween(ctx, from, to);
  if (kind) occurrences = occurrences.filter((o) => o.kind === kind);
  if (conflictsOnly) occurrences = occurrences.filter((o) => o.conflictsWith.length > 0);
  return json({ from, to, occurrences, conflictCount: occurrences.filter((o) => o.conflictsWith.length > 0).length });
}

async function getEvent(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).event(id));
  if (!doc) throw notFound("Evento");
  return json(toEvent(id, doc));
}

async function createEvent(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, EventCreateSchema);
  const idem = await readIdempotency(ctx.request, "event", input);
  const path = pathsFor(ctx.uid).event(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  const timeZone = input.timeZone ?? (await profileTimeZone(ctx));
  const timestamp = ctx.now().toISOString();
  const doc = eventDoc(
    {
      uid: ctx.uid,
      ...input,
      timeZone,
      expenseTransactionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    idem.hash,
  );
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [{ path, fields: doc, precondition: { exists: false } }]);
  if (replay) return replay;
  const event = toEvent(idem.id, doc);
  // Conflito é aviso, nunca bloqueio: o evento já foi criado.
  return json({ ...event, conflicts: await conflictsFor(ctx, event) }, 201);
}

async function checkConflicts(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, ConflictCheckSchema);
  const timeZone = input.timeZone ?? (await profileTimeZone(ctx));
  const proposed: CalendarEvent = {
    id: "proposed",
    uid: ctx.uid,
    title: "Novo evento",
    kind: "other",
    description: null,
    startDate: input.startDate,
    startTime: input.startTime,
    durationMin: input.durationMin,
    timeZone,
    location: null,
    contact: null,
    link: null,
    notes: null,
    estimatedCostCents: null,
    reminders: [],
    recurrence: input.recurrence,
    expenseTransactionId: null,
    createdAt: "",
    updatedAt: "",
  };
  const withoutExcluded = async (): Promise<ConflictReport[]> => {
    if (input.excludeEventId === undefined) return conflictsFor(ctx, proposed);
    const reports = await conflictsFor(ctx, proposed);
    return reports
      .map((r) => ({ ...r, with: r.with.filter((w) => w.eventId !== input.excludeEventId) }))
      .filter((r) => r.with.length > 0);
  };
  const conflicts = await withoutExcluded();
  return json({ hasConflicts: conflicts.length > 0, conflicts });
}

// ------------------------------------------------------------------ edição

function requireOccurrence(event: CalendarEvent, occurrenceDate: string | undefined, scope: EventScope): string {
  if (occurrenceDate === undefined) {
    throw new HttpError(400, "occurrence_required", `Informe occurrenceDate para o escopo "${scope}"`);
  }
  if (occurrenceIndex(event.startDate, event.recurrence, occurrenceDate) < 0) {
    throw new HttpError(422, "invalid_occurrence", "A data informada não é uma ocorrência deste evento");
  }
  return occurrenceDate;
}

const SCHEDULE_FIELDS = ["startDate", "recurrence"] as const;

async function patchEvent(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, EventPatchSchema);
  const p = pathsFor(ctx.uid);
  const stored = await ctx.db.getDoc(p.event(id));
  if (!stored) throw notFound("Evento");
  const event = toEvent(id, stored.data);
  const timestamp = ctx.now().toISOString();
  const scope: EventScope = event.recurrence === null ? "all" : input.scope;

  if (scope === "one") return patchOccurrence(ctx, event, input.occurrenceDate, input.changes, timestamp);

  if (scope === "following") {
    const date = requireOccurrence(event, input.occurrenceDate, scope);
    if (date !== event.startDate) return splitSeries(ctx, event, stored.updateTime, date, input.changes, timestamp);
    // Escolher a primeira ocorrência equivale a editar a série toda.
  }

  // Toda a série (ou evento simples).
  const next = applyChanges(event, input.changes, timestamp);
  validateMerged(next);
  const ops: WriteOp[] = [];
  const scheduleChanged = SCHEDULE_FIELDS.some((field) => input.changes[field] !== undefined);
  if (scheduleChanged && (event.recurrence !== null || next.recurrence !== null)) {
    // Mudou a regra de datas: as exceções (presas às datas antigas) deixam de fazer sentido.
    for (const exception of await seriesExceptions(ctx, id)) ops.push({ path: p.eventException(exception.id), delete: true });
  }
  ops.push({
    path: p.event(id),
    fields: eventDoc(next),
    merge: true,
    precondition: { updateTime: stored.updateTime },
  });
  await commitOrConflict(ctx, ops);
  return json({ event: next, conflicts: await conflictsFor(ctx, next) });
}

async function patchOccurrence(
  ctx: Ctx,
  event: CalendarEvent,
  occurrenceDate: string | undefined,
  changes: EventChanges,
  timestamp: string,
): Promise<Response> {
  const date = requireOccurrence(event, occurrenceDate, "one");
  if (changes.recurrence !== undefined || changes.timeZone !== undefined) {
    throw new HttpError(422, "not_allowed_for_one", "Fuso horário e recorrência só podem ser alterados na série");
  }
  const p = pathsFor(ctx.uid);
  const xId = await exceptionId(event.id, date);
  const current = await ctx.db.getDoc(p.eventException(xId));
  const fields: DocData = {
    ...(current?.data ?? {}),
    uid: ctx.uid,
    seriesId: event.id,
    originalDate: date,
    canceled: false,
    createdAt: typeof current?.data["createdAt"] === "string" ? current.data["createdAt"] : timestamp,
    updatedAt: timestamp,
  };
  const set = (key: string, value: DocData[string] | undefined): void => {
    if (value !== undefined) fields[key] = value;
  };
  set("title", changes.title);
  set("kind", changes.kind);
  set("description", changes.description);
  set("startDate", changes.startDate);
  set("startTime", changes.startTime);
  set("durationMin", changes.durationMin);
  set("location", changes.location);
  set("contact", changes.contact);
  set("link", changes.link);
  set("notes", changes.notes);
  set("estimatedCostCents", changes.estimatedCostCents);
  if (changes.reminders !== undefined) fields["reminders"] = remindersToField(changes.reminders);
  if (changes.startTime === null) fields["durationMin"] = 1440;

  await commitOrConflict(ctx, [
    {
      path: p.eventException(xId),
      fields,
      precondition: current ? { updateTime: current.updateTime } : { exists: false },
    },
  ]);
  const occurrence = buildOccurrence(event, date, exceptionFromFields(fields));
  const proposed: CalendarEvent = { ...event, id: "proposed-one", recurrence: null, startDate: occurrence.startDate, startTime: occurrence.startTime, durationMin: occurrence.durationMin };
  const others = await conflictsFor(ctx, proposed);
  return json({ occurrence, conflicts: others.filter((c) => c.startDate === occurrence.startDate) });
}

/** "Esta e as próximas": encerra a série antiga na véspera e cria uma nova a partir da ocorrência. */
async function splitSeries(
  ctx: Ctx,
  event: CalendarEvent,
  updateTime: string,
  date: string,
  changes: EventChanges,
  timestamp: string,
): Promise<Response> {
  const rule = event.recurrence as EventRecurrence;
  const index = occurrenceIndex(event.startDate, rule, date);
  const p = pathsFor(ctx.uid);
  const newId = `s${(await sha256Hex(`split|${event.id}|${date}`)).slice(0, 39)}`;

  const oldRule: EventRecurrence =
    rule.count !== null ? { ...rule, count: index, until: null } : { ...rule, until: addDays(date, -1) };
  const base: CalendarEvent = { ...event, id: newId, startDate: date, expenseTransactionId: null, createdAt: timestamp };
  const created = applyChanges(
    { ...base, recurrence: rule.count !== null ? { ...rule, count: rule.count - index } : rule },
    changes,
    timestamp,
  );
  validateMerged(created);

  const scheduleChanged = SCHEDULE_FIELDS.some((field) => changes[field] !== undefined);
  const ops: WriteOp[] = [
    {
      path: p.event(event.id),
      fields: eventDoc({ ...event, recurrence: oldRule, updatedAt: timestamp }),
      merge: true,
      precondition: { updateTime },
    },
    { path: p.event(newId), fields: eventDoc(created, `split-${event.id}`), precondition: { exists: false } },
  ];
  // Exceções a partir da data pertencem à parte nova da série: mudam de série (ou saem, se o calendário mudou).
  for (const exception of await seriesExceptions(ctx, event.id)) {
    if (String(exception.data["originalDate"]) < date) continue;
    ops.push({ path: p.eventException(exception.id), delete: true });
    if (!scheduleChanged) {
      const newXId = await exceptionId(newId, String(exception.data["originalDate"]));
      ops.push({
        path: p.eventException(newXId),
        fields: { ...exception.data, seriesId: newId, updatedAt: timestamp },
        precondition: { exists: false },
      });
    }
  }
  await commitOrConflict(ctx, ops);
  return json({
    event: created,
    previous: toEvent(event.id, eventDoc({ ...event, recurrence: oldRule, updatedAt: timestamp })),
    conflicts: await conflictsFor(ctx, created),
  });
}

// ------------------------------------------------------------------ exclusão

async function deleteEvent(ctx: Ctx, id: string): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const stored = await ctx.db.getDoc(p.event(id));
  if (!stored) throw notFound("Evento");
  const event = toEvent(id, stored.data);
  const scope: EventScope = event.recurrence === null ? "all" : (enumParam(ctx.url, "scope", EVENT_SCOPES) ?? "all");
  const occurrenceDate = dateParam(ctx.url, "occurrenceDate", isValidDate) ?? undefined;
  const timestamp = ctx.now().toISOString();

  if (scope === "one") {
    const date = requireOccurrence(event, occurrenceDate, scope);
    const xId = await exceptionId(id, date);
    const current = await ctx.db.getDoc(p.eventException(xId));
    await commitOrConflict(ctx, [
      {
        path: p.eventException(xId),
        fields: {
          uid: ctx.uid,
          seriesId: id,
          originalDate: date,
          canceled: true,
          createdAt: typeof current?.data["createdAt"] === "string" ? current.data["createdAt"] : timestamp,
          updatedAt: timestamp,
        },
        precondition: current ? { updateTime: current.updateTime } : { exists: false },
      },
    ]);
    return json({ deleted: true, scope, occurrenceDate: date });
  }

  const ops: WriteOp[] = [];
  const rule = event.recurrence;
  const date = scope === "following" ? requireOccurrence(event, occurrenceDate, scope) : undefined;
  if (scope === "following" && date !== undefined && date !== event.startDate && rule !== null) {
    // Encerra a série na véspera; as exceções posteriores saem.
    const index = occurrenceIndex(event.startDate, rule, date);
    const cut: EventRecurrence = rule.count !== null ? { ...rule, count: index, until: null } : { ...rule, until: addDays(date, -1) };
    ops.push({
      path: p.event(id),
      fields: { ...recurrenceToFields(cut), updatedAt: timestamp },
      merge: true,
      precondition: { updateTime: stored.updateTime },
    });
    for (const exception of await seriesExceptions(ctx, id)) {
      if (String(exception.data["originalDate"]) >= date) ops.push({ path: p.eventException(exception.id), delete: true });
    }
  } else {
    ops.push({ path: p.event(id), delete: true, precondition: { updateTime: stored.updateTime } });
    for (const exception of await seriesExceptions(ctx, id)) ops.push({ path: p.eventException(exception.id), delete: true });
  }
  await commitOrConflict(ctx, ops);
  return json({ deleted: true, scope: ops[0]?.delete ? "all" : scope });
}

// ------------------------------------------------------------------ despesa vinculada

/**
 * Gera a despesa REAL a partir do evento (D6). O custo previsto nunca vira despesa sozinho:
 * só esta chamada explícita cria o lançamento, junto do saldo, e marca o evento/ocorrência.
 */
async function createEventExpense(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, EventExpenseSchema);
  const idem = await readIdempotency(ctx.request, "event-expense", { eventId: id, ...input });
  const p = pathsFor(ctx.uid);
  const txPath = p.transaction(idem.id);
  const existing = await ctx.db.get(txPath);
  if (existing) return replayResponse(idem.id, existing, idem);

  const stored = await ctx.db.getDoc(p.event(id));
  if (!stored) throw notFound("Evento");
  const event = toEvent(id, stored.data);

  let occurrenceDate = event.startDate;
  let exception: Awaited<ReturnType<Ctx["db"]["getDoc"]>> = null;
  if (event.recurrence !== null) {
    occurrenceDate = requireOccurrence(event, input.occurrenceDate, "one");
    exception = await ctx.db.getDoc(p.eventException(await exceptionId(id, occurrenceDate)));
  }
  const occurrence = buildOccurrence(event, occurrenceDate, exception ? exceptionFromFields(exception.data) : undefined);
  if (occurrence.expenseTransactionId !== null) {
    throw new HttpError(409, "expense_already_linked", "Este evento já tem uma despesa vinculada");
  }
  const amountCents = input.amountCents ?? occurrence.estimatedCostCents;
  if (amountCents === null) {
    throw new HttpError(422, "amount_required", "Informe o valor: o evento não tem custo previsto");
  }
  await loadAccount(ctx, input.accountId);
  await checkCategory(ctx, input.categoryId, "expense");

  const timestamp = ctx.now().toISOString();
  const date = input.date ?? occurrence.startDate;
  const tx = transactionDoc({
    uid: ctx.uid,
    accountId: input.accountId,
    type: "expense",
    amountCents,
    date,
    categoryId: input.categoryId,
    description: occurrence.title,
    notes: `Evento: ${occurrence.title} (${occurrence.startDate})`,
    transferId: null,
    payableId: null,
    timestamp,
    requestHash: idem.hash,
  });
  const link: WriteOp =
    event.recurrence === null
      ? { path: p.event(id), fields: { expenseTransactionId: idem.id, updatedAt: timestamp }, merge: true, precondition: { updateTime: stored.updateTime } }
      : {
          path: p.eventException(await exceptionId(id, occurrenceDate)),
          fields: {
            ...(exception?.data ?? {}),
            uid: ctx.uid,
            seriesId: id,
            originalDate: occurrenceDate,
            canceled: false,
            expenseTransactionId: idem.id,
            createdAt: typeof exception?.data["createdAt"] === "string" ? exception.data["createdAt"] : timestamp,
            updatedAt: timestamp,
          },
          precondition: exception ? { updateTime: exception.updateTime } : { exists: false },
        };
  const replay = await commitIdempotent(ctx, txPath, idem.id, idem, [
    { path: txPath, fields: tx, precondition: { exists: false } },
    balanceOp(ctx.uid, input.accountId, signedAmount("expense", amountCents), timestamp),
    link,
  ]);
  return replay ?? json(publicDoc<Transaction>(idem.id, tx), 201);
}
