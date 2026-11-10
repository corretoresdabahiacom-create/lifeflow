import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskCategoryCreateSchema,
  TaskCategoryPatchSchema,
  TaskCreateSchema,
  TaskPatchSchema,
  isValidDate,
  utcMsToZoned,
  type Task,
  type TaskPriority,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import type { DocData } from "../firestore";
import { allow, json, parseBody } from "../http";
import {
  assertId,
  commitIdempotent,
  commitOrConflict,
  dateParam,
  enumParam,
  intParam,
  notFound,
  pathsFor,
  profileTimeZone,
  publicDoc,
  readAll,
  readIdempotency,
  replayResponse,
  type Ctx,
} from "../finance/common";

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Vencida: aberta e com prazo no passado (sem horário, vence ao fim do dia). */
export function isOverdue(task: Pick<Task, "status" | "dueDate" | "dueTime">, now: Date, timeZone: string): boolean {
  if (task.dueDate === null || task.status === "completed" || task.status === "canceled") return false;
  const local = utcMsToZoned(now.getTime(), timeZone);
  if (task.dueTime === null) return task.dueDate < local.date;
  return task.dueDate < local.date || (task.dueDate === local.date && task.dueTime < local.time);
}

const toTask = (id: string, data: DocData, now: Date, timeZone: string): Task => {
  const task = publicDoc<Task>(id, data);
  return { ...task, overdue: isOverdue(task, now, timeZone) };
};

async function checkTaskCategory(ctx: Ctx, categoryId: string | null | undefined): Promise<void> {
  if (categoryId === null || categoryId === undefined) return;
  const doc = await ctx.db.get(pathsFor(ctx.uid).taskCategory(categoryId));
  if (!doc) throw new HttpError(404, "category_not_found", "Categoria não encontrada");
  if (doc["archived"] === true) throw new HttpError(422, "category_archived", "Categoria arquivada não pode ser usada");
}

export async function tasksRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listTasks(ctx) : createTask(ctx);
  }
  assertId(id);
  if (action === "complete") {
    allow(method, ["POST"]);
    return completeTask(ctx, id);
  }
  if (action !== undefined) throw notFound("Rota");
  allow(method, ["GET", "PATCH", "DELETE"]);
  if (method === "GET") return getTask(ctx, id);
  return method === "PATCH" ? patchTask(ctx, id) : deleteTask(ctx, id);
}

async function listTasks(ctx: Ctx): Promise<Response> {
  const { url } = ctx;
  const timeZone = await profileTimeZone(ctx);
  const now = ctx.now();
  const status = enumParam(url, "status", TASK_STATUSES);
  const priority = enumParam(url, "priority", TASK_PRIORITIES);
  const categoryId = url.searchParams.get("categoryId");
  const overdueOnly = url.searchParams.get("overdue") === "true";
  const from = dateParam(url, "from", isValidDate);
  const to = dateParam(url, "to", isValidDate);
  const includeDone = url.searchParams.get("includeDone") === "true";
  const limit = intParam(url, "limit", 100, 1, 200);

  const { docs, truncated } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "tasks" }, 2000);
  const all = docs.map((doc) => toTask(doc.id, doc.data, now, timeZone));
  const filtered = all
    .filter((t) => (status !== null ? t.status === status : includeDone || (t.status !== "completed" && t.status !== "canceled")))
    .filter((t) => priority === null || t.priority === priority)
    .filter((t) => categoryId === null || t.categoryId === categoryId)
    .filter((t) => !overdueOnly || t.overdue === true)
    .filter((t) => from === null || (t.dueDate !== null && t.dueDate >= from))
    .filter((t) => to === null || (t.dueDate !== null && t.dueDate <= to))
    .sort((a, b) => {
      const dueA = a.dueDate === null ? "9999-99-99" : `${a.dueDate}T${a.dueTime ?? "23:59"}`;
      const dueB = b.dueDate === null ? "9999-99-99" : `${b.dueDate}T${b.dueTime ?? "23:59"}`;
      if (dueA !== dueB) return dueA < dueB ? -1 : 1;
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id);
    });
  return json({
    tasks: filtered.slice(0, limit),
    total: filtered.length,
    overdueCount: all.filter((t) => t.overdue === true).length,
    truncated,
  });
}

async function getTask(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).task(id));
  if (!doc) throw notFound("Tarefa");
  return json(toTask(id, doc, ctx.now(), await profileTimeZone(ctx)));
}

async function createTask(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, TaskCreateSchema);
  const idem = await readIdempotency(ctx.request, "task", input);
  const path = pathsFor(ctx.uid).task(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);
  await checkTaskCategory(ctx, input.categoryId);

  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    title: input.title,
    description: input.description,
    priority: input.priority,
    categoryId: input.categoryId,
    dueDate: input.dueDate,
    dueTime: input.dueTime,
    status: input.status,
    reminderMinutes: input.reminderMinutes,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [{ path, fields: doc, precondition: { exists: false } }]);
  return replay ?? json(toTask(idem.id, doc, ctx.now(), await profileTimeZone(ctx)), 201);
}

async function patchTask(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, TaskPatchSchema);
  const path = pathsFor(ctx.uid).task(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Tarefa");
  await checkTaskCategory(ctx, input.categoryId);

  const timestamp = ctx.now().toISOString();
  const changes: DocData = { updatedAt: timestamp };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) changes[key] = value as DocData[string];
  const merged = { ...stored.data, ...changes };
  if (merged["dueTime"] !== null && merged["dueDate"] === null) {
    throw new HttpError(422, "invalid_task", "Informe a data do prazo");
  }
  if (merged["reminderMinutes"] !== null && merged["dueDate"] === null) {
    throw new HttpError(422, "invalid_task", "O lembrete exige um prazo");
  }
  if (input.status !== undefined) {
    changes["completedAt"] = input.status === "completed" ? (typeof stored.data["completedAt"] === "string" ? stored.data["completedAt"] : timestamp) : null;
  }
  await commitOrConflict(ctx, [{ path, fields: changes, merge: true, precondition: { updateTime: stored.updateTime } }]);
  return json(toTask(id, { ...stored.data, ...changes }, ctx.now(), await profileTimeZone(ctx)));
}

/** Idempotente: concluir uma tarefa já concluída devolve o estado atual sem regravar. */
async function completeTask(ctx: Ctx, id: string): Promise<Response> {
  const path = pathsFor(ctx.uid).task(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Tarefa");
  const timeZone = await profileTimeZone(ctx);
  if (stored.data["status"] === "completed") return json(toTask(id, stored.data, ctx.now(), timeZone));
  if (stored.data["status"] === "canceled") {
    throw new HttpError(422, "task_canceled", "Tarefa cancelada não pode ser concluída; reabra-a antes");
  }
  const timestamp = ctx.now().toISOString();
  const changes: DocData = { status: "completed", completedAt: timestamp, updatedAt: timestamp };
  await commitOrConflict(ctx, [{ path, fields: changes, merge: true, precondition: { updateTime: stored.updateTime } }]);
  return json(toTask(id, { ...stored.data, ...changes }, ctx.now(), timeZone));
}

async function deleteTask(ctx: Ctx, id: string): Promise<Response> {
  const path = pathsFor(ctx.uid).task(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Tarefa");
  await commitOrConflict(ctx, [{ path, delete: true, precondition: { updateTime: stored.updateTime } }]);
  return json({ deleted: true });
}

// ------------------------------------------------------- categorias de tarefa

export async function taskCategoriesRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (action !== undefined) throw notFound("Rota");
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listCategories(ctx) : createCategory(ctx);
  }
  assertId(id);
  allow(method, ["PATCH"]);
  return patchCategory(ctx, id);
}

async function listCategories(ctx: Ctx): Promise<Response> {
  const includeArchived = ctx.url.searchParams.get("archived") === "true";
  const { docs } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "taskCategories" }, 500);
  const categories = docs
    .map((doc) => publicDoc<{ id: string; name: string; archived: boolean }>(doc.id, doc.data))
    .filter((c) => includeArchived || !c.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return json({ categories });
}

async function createCategory(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, TaskCategoryCreateSchema);
  const idem = await readIdempotency(ctx.request, "task-category", input);
  const path = pathsFor(ctx.uid).taskCategory(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);
  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    name: input.name,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [{ path, fields: doc, precondition: { exists: false } }]);
  return replay ?? json(publicDoc(idem.id, doc), 201);
}

async function patchCategory(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, TaskCategoryPatchSchema);
  const path = pathsFor(ctx.uid).taskCategory(id);
  const stored = await ctx.db.getDoc(path);
  if (!stored) throw notFound("Categoria");
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  if (input.name !== undefined) changes["name"] = input.name;
  if (input.archived !== undefined) changes["archived"] = input.archived;
  await commitOrConflict(ctx, [{ path, fields: changes, merge: true, precondition: { updateTime: stored.updateTime } }]);
  return json(publicDoc(id, { ...stored.data, ...changes }));
}
