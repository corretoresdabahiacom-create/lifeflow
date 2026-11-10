import {
  ReminderCreateSchema,
  addDays,
  utcMsToZoned,
  zonedToUtcMs,
  type AppNotification,
  type NotificationType,
} from "@lifeflow/shared";
import { PreconditionFailedError, type DocData, type WriteOp } from "../firestore";
import { allow, json, parseBody } from "../http";
import {
  assertId,
  commitIdempotent,
  commitOrConflict,
  intParam,
  notFound,
  pathsFor,
  profileTimeZone,
  publicDoc,
  readAll,
  readIdempotency,
  replayResponse,
  sha256Hex,
  type Ctx,
} from "../finance/common";
import { occurrencesBetween } from "./events";

const MAX_CREATE_PER_CALL = 25;
const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

interface Candidate {
  type: NotificationType;
  sourceType: AppNotification["sourceType"];
  sourceId: string;
  /** Faz parte do id determinístico: mesma origem + mesma chave = mesma notificação. */
  occurrenceKey: string;
  triggerMs: number;
  title: string;
  body: string;
}

const formatOffset = (minutes: number): string => {
  if (minutes === 0) return "agora";
  if (minutes < 60) return `em ${minutes} min`;
  if (minutes < 1440) return `em ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / 1440);
  return `em ${days} ${days === 1 ? "dia" : "dias"}`;
};

const brDate = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Horário silencioso (pode cruzar a meia-noite). Início = fim desativa. */
export function isQuiet(time: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

async function notificationId(c: Pick<Candidate, "sourceType" | "sourceId" | "occurrenceKey">): Promise<string> {
  return `n${(await sha256Hex(`${c.sourceType}|${c.sourceId}|${c.occurrenceKey}`)).slice(0, 39)}`;
}

// --------------------------------------------------------------- geração

async function gatherCandidates(ctx: Ctx, timeZone: string, nowMs: number): Promise<Candidate[]> {
  const p = pathsFor(ctx.uid);
  const today = utcMsToZoned(nowMs, timeZone).date;
  const out: Candidate[] = [];

  // Eventos: lembretes ainda úteis (o evento não começou). Janela cobre o maior lembrete (28 dias).
  const occurrences = await occurrencesBetween(ctx, addDays(today, -1), addDays(today, 29));
  for (const o of occurrences) {
    const startMs = Date.parse(o.startUtc);
    // Só vale avisar enquanto o evento não terminou (lembrete "na hora" dispara com o evento em curso).
    if (Date.parse(o.endUtc) <= nowMs) continue;
    for (const offset of o.reminders) {
      out.push({
        type: "event_reminder",
        sourceType: "event",
        sourceId: o.eventId,
        occurrenceKey: `${o.originalDate}@${o.startDate}T${o.startTime ?? "-"}#${offset}`,
        triggerMs: startMs - offset * 60_000,
        title: o.title,
        body: o.allDay ? `Dia inteiro, ${brDate(o.startDate)}` : `Começa ${formatOffset(offset)} (${o.startTime}, ${brDate(o.startDate)})`,
      });
    }
  }

  // Tarefas abertas: lembrete antes do prazo e aviso (uma vez) de atraso.
  const tasks = await readAll(ctx.db, p.parent, { collection: "tasks" }, 2000);
  for (const doc of tasks.docs) {
    const d = doc.data;
    if (typeof d["dueDate"] !== "string" || d["status"] === "completed" || d["status"] === "canceled") continue;
    const dueDate = d["dueDate"];
    const dueTime = typeof d["dueTime"] === "string" ? d["dueTime"] : null;
    const title = String(d["title"] ?? "Tarefa");
    const dueMs = dueTime ? zonedToUtcMs(dueDate, dueTime, timeZone) : zonedToUtcMs(addDays(dueDate, 1), "00:00", timeZone);
    if (typeof d["reminderMinutes"] === "number" && dueMs > nowMs) {
      const baseMs = dueTime ? dueMs : zonedToUtcMs(dueDate, "09:00", timeZone);
      out.push({
        type: "task_reminder",
        sourceType: "task",
        sourceId: doc.id,
        occurrenceKey: `${dueDate}T${dueTime ?? "-"}#${d["reminderMinutes"]}`,
        triggerMs: baseMs - d["reminderMinutes"] * 60_000,
        title,
        body: `Prazo: ${brDate(dueDate)}${dueTime ? ` às ${dueTime}` : ""}`,
      });
    }
    if (dueMs <= nowMs && nowMs - dueMs <= 30 * 86_400_000) {
      out.push({
        type: "task_overdue",
        sourceType: "task",
        sourceId: doc.id,
        occurrenceKey: `${dueDate}T${dueTime ?? "-"}#overdue`,
        triggerMs: dueMs,
        title,
        body: `Tarefa atrasada desde ${brDate(dueDate)}`,
      });
    }
  }

  // Contas a pagar/receber (D6): só AVISA. Nenhuma operação financeira é criada ou alterada aqui.
  const payables = await ctx.db.query(p.parent, {
    collection: "payables",
    filters: [{ field: "status", op: "EQUAL", value: "open" }],
    limit: 500,
  });
  for (const doc of payables) {
    const dueDate = doc.data["dueDate"];
    if (typeof dueDate !== "string") continue;
    const receivable = doc.data["kind"] === "receivable";
    const description = String(doc.data["description"] ?? "Conta");
    if (dueDate >= today && dueDate <= addDays(today, 3)) {
      out.push({
        type: "payable_due",
        sourceType: "payable",
        sourceId: doc.id,
        occurrenceKey: `${dueDate}#due`,
        triggerMs: zonedToUtcMs(addDays(dueDate, -3), "08:00", timeZone),
        title: description,
        // Sem valores: o texto pode ser exibido em telas bloqueadas e notificações push.
        body: `${receivable ? "Recebimento" : "Vencimento"} em ${brDate(dueDate)}`,
      });
    } else if (dueDate < today && dueDate >= addDays(today, -30)) {
      out.push({
        type: "payable_due",
        sourceType: "payable",
        sourceId: doc.id,
        occurrenceKey: `${dueDate}#overdue`,
        triggerMs: zonedToUtcMs(addDays(dueDate, 1), "08:00", timeZone),
        title: description,
        body: `${receivable ? "Recebimento" : "Pagamento"} atrasado desde ${brDate(dueDate)}`,
      });
    }
  }

  // Lembretes avulsos.
  const reminders = await readAll(ctx.db, p.parent, { collection: "reminders" }, 500);
  for (const doc of reminders.docs) {
    const remindAt = doc.data["remindAt"];
    if (typeof remindAt !== "string") continue;
    out.push({
      type: "reminder",
      sourceType: "reminder",
      sourceId: doc.id,
      occurrenceKey: remindAt,
      triggerMs: Date.parse(remindAt),
      title: String(doc.data["title"] ?? "Lembrete"),
      body: "Lembrete",
    });
  }

  return out.filter((c) => c.triggerMs <= nowMs && nowMs - c.triggerMs <= 45 * 86_400_000).sort((a, b) => a.triggerMs - b.triggerMs);
}

async function existingIds(ctx: Ctx, nowMs: number): Promise<Set<string>> {
  const since = new Date(nowMs - 60 * 86_400_000).toISOString();
  const { docs } = await readAll(
    ctx.db,
    pathsFor(ctx.uid).parent,
    {
      collection: "notifications",
      filters: [{ field: "triggerAt", op: "GREATER_THAN_OR_EQUAL", value: since }],
      orderBy: { field: "triggerAt", direction: "ASCENDING" },
    },
    3000,
  );
  return new Set(docs.map((d) => d.id));
}

/**
 * Gera as notificações devidas. Idempotente por construção: o id da notificação é derivado de
 * (origem, ocorrência, antecedência) e a gravação só cria (`exists:false`). Repetir a chamada,
 * ou duas chamadas simultâneas, nunca duplica.
 */
async function generate(ctx: Ctx): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const nowMs = ctx.now().getTime();
  const timeZone = await profileTimeZone(ctx);
  const prefs = await ctx.db.get(p.preferences);
  const quietStart = typeof prefs?.["quietHoursStart"] === "string" ? prefs["quietHoursStart"] : DEFAULT_QUIET.start;
  const quietEnd = typeof prefs?.["quietHoursEnd"] === "string" ? prefs["quietHoursEnd"] : DEFAULT_QUIET.end;

  const candidates = await gatherCandidates(ctx, timeZone, nowMs);
  const withIds = await Promise.all(candidates.map(async (c) => ({ c, id: await notificationId(c) })));

  const attempt = async (): Promise<{ created: AppNotification[]; hasMore: boolean }> => {
    const known = await existingIds(ctx, nowMs);
    const missing = withIds.filter(({ id }) => !known.has(id));
    const batch = missing.slice(0, MAX_CREATE_PER_CALL);
    const timestamp = new Date(nowMs).toISOString();
    const docs = batch.map(({ c, id }): { id: string; doc: DocData } => ({
      id,
      doc: {
        uid: ctx.uid,
        type: c.type,
        title: c.title,
        body: c.body,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        occurrenceKey: c.occurrenceKey,
        triggerAt: new Date(c.triggerMs).toISOString(),
        silent: isQuiet(utcMsToZoned(c.triggerMs, timeZone).time, quietStart, quietEnd),
        read: false,
        readAt: null,
        dismissed: false,
        createdAt: timestamp,
      },
    }));
    if (docs.length > 0) {
      const ops: WriteOp[] = docs.map(({ id, doc }) => ({ path: p.notification(id), fields: doc, precondition: { exists: false } }));
      await ctx.db.commit(ops);
    }
    return {
      created: docs.map(({ id, doc }) => publicDoc<AppNotification>(id, doc)),
      hasMore: missing.length > batch.length,
    };
  };

  let result: { created: AppNotification[]; hasMore: boolean };
  try {
    result = await attempt();
  } catch (error) {
    if (!(error instanceof PreconditionFailedError)) throw error;
    // Outra requisição criou algumas ao mesmo tempo (nada foi gravado aqui): recalcula o que falta.
    try {
      result = await attempt();
    } catch (second) {
      if (!(second instanceof PreconditionFailedError)) throw second;
      result = { created: [], hasMore: true };
    }
  }
  return json({ created: result.created.length, hasMore: result.hasMore, notifications: result.created });
}

// --------------------------------------------------------------- leitura / estado

export async function notificationsRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET"]);
    return list(ctx);
  }
  if (id === "generate") {
    if (action !== undefined) throw notFound("Rota");
    allow(method, ["POST"]);
    return generate(ctx);
  }
  if (id === "read-all") {
    if (action !== undefined) throw notFound("Rota");
    allow(method, ["POST"]);
    return readAllNotifications(ctx);
  }
  assertId(id);
  if (action === "read" || action === "dismiss") {
    allow(method, ["POST"]);
    return mark(ctx, id, action);
  }
  throw notFound("Rota");
}

async function list(ctx: Ctx): Promise<Response> {
  const unreadOnly = ctx.url.searchParams.get("unread") === "true";
  const limit = intParam(ctx.url, "limit", 50, 1, 200);
  const { docs } = await readAll(
    ctx.db,
    pathsFor(ctx.uid).parent,
    { collection: "notifications", orderBy: { field: "triggerAt", direction: "DESCENDING" } },
    1000,
  );
  const visible = docs.map((d) => publicDoc<AppNotification>(d.id, d.data)).filter((n) => !n.dismissed);
  const unreadCount = visible.filter((n) => !n.read).length;
  return json({
    notifications: visible.filter((n) => !unreadOnly || !n.read).slice(0, limit),
    unreadCount,
  });
}

async function mark(ctx: Ctx, id: string, action: "read" | "dismiss"): Promise<Response> {
  const path = pathsFor(ctx.uid).notification(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Notificação");
  const timestamp = ctx.now().toISOString();
  const changes: DocData =
    action === "read"
      ? stored.data["read"] === true
        ? {}
        : { read: true, readAt: timestamp }
      : stored.data["dismissed"] === true
        ? {}
        : { dismissed: true, read: true, readAt: typeof stored.data["readAt"] === "string" ? stored.data["readAt"] : timestamp };
  if (Object.keys(changes).length > 0) {
    await commitOrConflict(ctx, [{ path, fields: changes, merge: true, precondition: { updateTime: stored.updateTime } }]);
  }
  return json(publicDoc<AppNotification>(id, { ...stored.data, ...changes }));
}

async function readAllNotifications(ctx: Ctx): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const unread = await ctx.db.query(p.parent, {
    collection: "notifications",
    filters: [{ field: "read", op: "EQUAL", value: false }],
    limit: MAX_CREATE_PER_CALL + 1,
  });
  const batch = unread.slice(0, MAX_CREATE_PER_CALL);
  const readAt = ctx.now().toISOString();
  if (batch.length > 0) {
    await commitOrConflict(
      ctx,
      batch.map((doc) => ({ path: p.notification(doc.id), fields: { read: true, readAt }, merge: true, precondition: { updateTime: doc.updateTime } })),
    );
  }
  return json({ updated: batch.length, hasMore: unread.length > batch.length });
}

// --------------------------------------------------------------- lembretes avulsos

export async function remindersRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (action !== undefined) throw notFound("Rota");
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listReminders(ctx) : createReminder(ctx);
  }
  assertId(id);
  allow(method, ["DELETE"]);
  const path = pathsFor(ctx.uid).reminder(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Lembrete");
  await commitOrConflict(ctx, [{ path, delete: true, precondition: { updateTime: stored.updateTime } }]);
  return json({ deleted: true });
}

async function listReminders(ctx: Ctx): Promise<Response> {
  const { docs } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "reminders" }, 500);
  const reminders = docs
    .map((d) => publicDoc<{ id: string; title: string; remindAt: string }>(d.id, d.data))
    .sort((a, b) => (a.remindAt < b.remindAt ? -1 : 1));
  return json({ reminders });
}

async function createReminder(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, ReminderCreateSchema);
  const idem = await readIdempotency(ctx.request, "reminder", input);
  const path = pathsFor(ctx.uid).reminder(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);
  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    title: input.title,
    remindAt: new Date(input.remindAt).toISOString(),
    createdAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [{ path, fields: doc, precondition: { exists: false } }]);
  return replay ?? json(publicDoc(idem.id, doc), 201);
}
