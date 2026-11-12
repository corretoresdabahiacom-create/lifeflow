import {
  MaterializeSchema,
  PayableCreateSchema,
  PayablePatchSchema,
  PayablePaySchema,
  RecurringCreateSchema,
  RecurringPatchSchema,
  addDays,
  isValidDate,
  occurrenceDates,
  type Payable,
  type RecurringRule,
  type TransactionType,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import { PreconditionFailedError, type DocData, type WriteOp } from "../firestore";
import { allow, json, parseBody } from "../http";
import {
  assertId,
  checkCategory,
  commitIdempotent,
  commitOrConflict,
  conflict,
  dateParam,
  decodeCursor,
  enumParam,
  intParam,
  loadAccount,
  notFound,
  originFields,
  pathsFor,
  publicDoc,
  readAll,
  readIdempotency,
  replayResponse,
  scanPage,
  todayFor,
  type Ctx,
} from "./common";
import { balanceOp, transactionDoc } from "./ledger";

const categoryKindFor = (kind: string): "income" | "expense" => (kind === "receivable" ? "income" : "expense");

function payableDoc(args: {
  uid: string;
  kind: string;
  description: string;
  amountCents: number;
  dueDate: string;
  accountId: string | null;
  categoryId: string | null;
  recurringId: string | null;
  timestamp: string;
  requestHash: string;
}): DocData {
  return {
    uid: args.uid,
    kind: args.kind,
    description: args.description,
    amountCents: args.amountCents,
    dueDate: args.dueDate,
    accountId: args.accountId,
    categoryId: args.categoryId,
    status: "open",
    paidDate: null,
    paidAmountCents: null,
    transactionId: null,
    payCount: 0,
    recurringId: args.recurringId,
    createdAt: args.timestamp,
    updatedAt: args.timestamp,
    requestHash: args.requestHash,
    payRequestHash: null,
  };
}

/** `overdue` é derivado na leitura (aberta e vencida antes de hoje); nunca é gravado. */
const withOverdue = (payable: Payable, today: string): Payable => ({
  ...payable,
  overdue: payable.status === "open" && payable.dueDate < today,
});

// ------------------------------------------------------ contas a pagar/receber

export async function payablesRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listPayables(ctx) : createPayable(ctx);
  }
  assertId(id);
  if (action === "pay") {
    allow(method, ["POST"]);
    return payPayable(ctx, id);
  }
  if (action === "cancel") {
    allow(method, ["POST"]);
    return cancelPayable(ctx, id);
  }
  if (action !== undefined) throw notFound("Rota");
  allow(method, ["GET", "PATCH"]);
  return method === "GET" ? getPayable(ctx, id) : patchPayable(ctx, id);
}

async function listPayables(ctx: Ctx): Promise<Response> {
  const { url } = ctx;
  const today = await todayFor(ctx);
  const from = dateParam(url, "from", isValidDate);
  const to = dateParam(url, "to", isValidDate);
  if (from && to && from > to) throw new HttpError(400, "invalid_query", "O período inicial não pode ser posterior ao final");
  const status = enumParam(url, "status", ["open", "paid", "canceled", "overdue"] as const);
  const kind = enumParam(url, "kind", ["payable", "receivable"] as const);
  const limit = intParam(url, "limit", 50, 1, 200);
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  const filters = [];
  if (from) filters.push({ field: "dueDate", op: "GREATER_THAN_OR_EQUAL" as const, value: from });
  if (to) filters.push({ field: "dueDate", op: "LESS_THAN_OR_EQUAL" as const, value: to });

  const { items, nextCursor } = await scanPage(
    ctx.db,
    pathsFor(ctx.uid).parent,
    { collection: "payables", filters, orderBy: { field: "dueDate", direction: "ASCENDING" } },
    (d) => {
      if (kind !== null && d["kind"] !== kind) return false;
      if (status === "overdue") return d["status"] === "open" && String(d["dueDate"]) < today;
      return status === null || d["status"] === status;
    },
    limit,
    cursor,
  );
  return json({
    today,
    items: items.map((doc) => withOverdue(publicDoc<Payable>(doc.id, doc.data), today)),
    nextCursor,
  });
}

async function getPayable(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).payable(id));
  if (!doc) throw notFound("Conta");
  return json(withOverdue(publicDoc<Payable>(id, doc), await todayFor(ctx)));
}

async function createPayable(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, PayableCreateSchema);
  const idem = await readIdempotency(ctx.request, "payable", input);
  const path = pathsFor(ctx.uid).payable(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  if (input.accountId !== null) await loadAccount(ctx, input.accountId);
  await checkCategory(ctx, input.categoryId, categoryKindFor(input.kind));

  const doc = payableDoc({
    uid: ctx.uid,
    ...input,
    recurringId: null,
    timestamp: ctx.now().toISOString(),
    requestHash: idem.hash,
  });
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: doc, precondition: { exists: false } },
  ]);
  return replay ?? json(publicDoc<Payable>(idem.id, doc), 201);
}

async function patchPayable(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, PayablePatchSchema);
  const path = pathsFor(ctx.uid).payable(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Conta");
  if (doc.data["status"] !== "open") {
    throw new HttpError(409, "not_open", "Só contas em aberto podem ser editadas");
  }
  if (input.accountId !== undefined && input.accountId !== null) await loadAccount(ctx, input.accountId);
  if (input.categoryId !== undefined) {
    await checkCategory(ctx, input.categoryId, categoryKindFor(String(doc.data["kind"])));
  }
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  for (const key of ["description", "amountCents", "dueDate", "accountId", "categoryId"] as const) {
    if (input[key] !== undefined) changes[key] = input[key] as DocData[string];
  }
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(withOverdue(publicDoc<Payable>(id, { ...doc.data, ...changes }), await todayFor(ctx)));
}

async function cancelPayable(ctx: Ctx, id: string): Promise<Response> {
  const path = pathsFor(ctx.uid).payable(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Conta");
  if (doc.data["status"] === "canceled") return json(publicDoc<Payable>(id, doc.data));
  if (doc.data["status"] === "paid") {
    throw new HttpError(409, "already_paid", "Conta já baixada; estorne o lançamento para reabri-la");
  }
  const changes: DocData = { status: "canceled", updatedAt: ctx.now().toISOString() };
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(publicDoc<Payable>(id, { ...doc.data, ...changes }));
}

/**
 * Baixa atômica e idempotente. UM commit: marca a conta como paga (com pré-condição do
 * `updateTime` lido), cria o lançamento (id determinístico, só se não existir) e ajusta o saldo.
 * Repetir a mesma requisição (mesma Idempotency-Key e conteúdo) devolve o resultado original;
 * outra tentativa de baixar uma conta já paga recebe 409 e nada é gravado.
 */
async function payPayable(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, PayablePaySchema);
  const idem = await readIdempotency(ctx.request, `pay:${id}`, input);
  const p = pathsFor(ctx.uid);
  const payablePath = p.payable(id);

  const alreadyPaidResponse = (data: DocData): Response => {
    if (data["payRequestHash"] === idem.fingerprint) {
      return json(
        { payable: publicDoc<Payable>(id, data), transactionId: data["transactionId"] },
        200,
        { "Idempotent-Replay": "true" },
      );
    }
    throw new HttpError(409, "already_paid", "Esta conta já foi baixada");
  };

  const doc = await ctx.db.getDoc(payablePath);
  if (!doc) throw notFound("Conta");
  if (doc.data["status"] === "paid") return alreadyPaidResponse(doc.data);
  if (doc.data["status"] !== "open") throw new HttpError(409, "not_open", "Só contas em aberto podem ser baixadas");

  await loadAccount(ctx, input.accountId);

  const kind = String(doc.data["kind"]);
  const type: TransactionType = kind === "receivable" ? "income" : "expense";
  const paidDate = input.date ?? (await todayFor(ctx));
  const amount = input.amountCents ?? Number(doc.data["amountCents"]);
  const sequence = Number(doc.data["payCount"] ?? 0) + 1;
  const transactionId = `pay_${id}_${sequence}`;
  const timestamp = ctx.now().toISOString();

  const payableChanges: DocData = {
    status: "paid",
    paidDate,
    paidAmountCents: amount,
    transactionId,
    payCount: sequence,
    accountId: input.accountId,
    payRequestHash: idem.fingerprint,
    updatedAt: timestamp,
  };
  const ops: WriteOp[] = [
    { path: payablePath, fields: payableChanges, merge: true, precondition: { updateTime: doc.updateTime } },
    {
      path: p.transaction(transactionId),
      fields: transactionDoc({
        uid: ctx.uid,
        accountId: input.accountId,
        type,
        amountCents: amount,
        date: paidDate,
        categoryId: typeof doc.data["categoryId"] === "string" ? doc.data["categoryId"] : null,
        description: String(doc.data["description"]),
        notes: null,
        transferId: null,
        payableId: id,
        timestamp,
        requestHash: idem.fingerprint,
        ...originFields(ctx),
      }),
      precondition: { exists: false },
    },
    balanceOp(ctx.uid, input.accountId, type === "income" ? amount : -amount, timestamp),
  ];

  try {
    await ctx.db.commit(ops);
  } catch (error) {
    if (!(error instanceof PreconditionFailedError)) throw error;
    // Outra requisição baixou antes (ou a mesma, simultânea): nada foi gravado por esta.
    const fresh = await ctx.db.get(payablePath);
    if (fresh && fresh["status"] === "paid") return alreadyPaidResponse(fresh);
    throw conflict();
  }
  return json({ payable: publicDoc<Payable>(id, { ...doc.data, ...payableChanges }), transactionId });
}

// ----------------------------------------------------------- recorrências

export async function recurringRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === "materialize" && action === undefined) {
    allow(method, ["POST"]);
    return materialize(ctx);
  }
  if (action !== undefined) throw notFound("Rota");
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listRecurring(ctx) : createRecurring(ctx);
  }
  assertId(id);
  allow(method, ["PATCH"]);
  return patchRecurring(ctx, id);
}

async function listRecurring(ctx: Ctx): Promise<Response> {
  const { docs } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "recurring" }, 500);
  const rules = docs
    .map((doc) => publicDoc<RecurringRule>(doc.id, doc.data))
    .sort((a, b) => a.description.localeCompare(b.description, "pt-BR"));
  return json({ rules });
}

async function createRecurring(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, RecurringCreateSchema);
  const idem = await readIdempotency(ctx.request, "recurring", input);
  const path = pathsFor(ctx.uid).recurring(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  if (input.accountId !== null) await loadAccount(ctx, input.accountId);
  await checkCategory(ctx, input.categoryId, categoryKindFor(input.kind));

  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    kind: input.kind,
    description: input.description,
    amountCents: input.amountCents,
    frequency: input.frequency,
    startDate: input.startDate,
    endDate: input.endDate,
    accountId: input.accountId,
    categoryId: input.categoryId,
    active: true,
    lastMaterializedThrough: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: doc, precondition: { exists: false } },
  ]);
  return replay ?? json(publicDoc<RecurringRule>(idem.id, doc), 201);
}

async function patchRecurring(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, RecurringPatchSchema);
  const path = pathsFor(ctx.uid).recurring(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Recorrência");
  const endDate = input.endDate === undefined ? doc.data["endDate"] : input.endDate;
  if (typeof endDate === "string" && endDate < String(doc.data["startDate"])) {
    throw new HttpError(400, "validation_error", "Dados inválidos: endDate");
  }
  if (input.accountId !== undefined && input.accountId !== null) await loadAccount(ctx, input.accountId);
  if (input.categoryId !== undefined) {
    await checkCategory(ctx, input.categoryId, categoryKindFor(String(doc.data["kind"])));
  }
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  for (const key of ["active", "description", "amountCents", "endDate", "accountId", "categoryId"] as const) {
    if (input[key] !== undefined) changes[key] = input[key] as DocData[string];
  }
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(publicDoc<RecurringRule>(id, { ...doc.data, ...changes }));
}

/** Máximo de contas geradas por chamada (limite de subrequisições do Worker). */
const MATERIALIZE_BUDGET = 20;
const DEFAULT_HORIZON_DAYS = 60;
const MAX_HORIZON_DAYS = 366;

/**
 * Gera as contas a pagar/receber das recorrências ativas até a data limite. Roda somente quando o
 * usuário pede (não há agendador). Os ids são determinísticos (`rec_<regra>_<data>`) e criados com
 * `exists:false`, então repetir a chamada nunca duplica contas.
 */
async function materialize(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, MaterializeSchema);
  const today = await todayFor(ctx);
  const through = input.through ?? addDays(today, DEFAULT_HORIZON_DAYS);
  if (through > addDays(today, MAX_HORIZON_DAYS)) {
    throw new HttpError(422, "through_too_far", `A data limite pode ir até ${MAX_HORIZON_DAYS} dias à frente`);
  }

  const p = pathsFor(ctx.uid);
  const { docs } = await readAll(ctx.db, p.parent, { collection: "recurring" }, 500);
  let budget = MATERIALIZE_BUDGET;
  let created = 0;

  for (const doc of docs) {
    if (budget <= 0) break;
    if (doc.data["active"] !== true) continue;
    const dates = occurrenceDates(
      {
        frequency: doc.data["frequency"] as "weekly" | "monthly" | "yearly",
        startDate: String(doc.data["startDate"]),
        endDate: typeof doc.data["endDate"] === "string" ? doc.data["endDate"] : null,
      },
      {
        after: typeof doc.data["lastMaterializedThrough"] === "string" ? doc.data["lastMaterializedThrough"] : null,
        through,
        limit: budget,
      },
    );
    if (dates.length === 0) continue;

    const timestamp = ctx.now().toISOString();
    const creates: WriteOp[] = dates.map((date) => ({
      path: p.payable(`rec_${doc.id}_${date}`),
      fields: payableDoc({
        uid: ctx.uid,
        kind: String(doc.data["kind"]),
        description: String(doc.data["description"]),
        amountCents: Number(doc.data["amountCents"]),
        dueDate: date,
        accountId: typeof doc.data["accountId"] === "string" ? doc.data["accountId"] : null,
        categoryId: typeof doc.data["categoryId"] === "string" ? doc.data["categoryId"] : null,
        recurringId: doc.id,
        timestamp,
        requestHash: "recurring",
      }),
      precondition: { exists: false },
    }));
    const advance: WriteOp = {
      path: p.recurring(doc.id),
      fields: { lastMaterializedThrough: dates[dates.length - 1] ?? null, updatedAt: timestamp },
      merge: true,
      precondition: { exists: true },
    };

    try {
      await ctx.db.commit([...creates, advance]);
      created += dates.length;
    } catch (error) {
      if (!(error instanceof PreconditionFailedError)) throw error;
      // Alguma conta já existia (execução anterior interrompida): cria uma a uma, ignorando as existentes.
      for (const create of creates) {
        try {
          await ctx.db.commit([create]);
          created++;
        } catch (inner) {
          if (!(inner instanceof PreconditionFailedError)) throw inner;
        }
      }
      await ctx.db.commit([advance]);
    }
    budget -= dates.length;
  }
  return json({ created, through, hasMore: budget <= 0 });
}
