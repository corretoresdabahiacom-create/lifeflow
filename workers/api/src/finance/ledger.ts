import {
  TRANSACTION_TYPES,
  TransactionCreateSchema,
  TransactionPatchSchema,
  TransferCreateSchema,
  isValidDate,
  monthBounds,
  signedAmount,
  type Transaction,
  type TransactionType,
  type Transfer,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import type { DocData, WriteOp } from "../firestore";
import { allow, json, parseBody } from "../http";
import {
  assertId,
  checkCategory,
  commitIdempotent,
  commitOrConflict,
  dateParam,
  decodeCursor,
  enumParam,
  intParam,
  loadAccount,
  notFound,
  pathsFor,
  publicDoc,
  readIdempotency,
  replayResponse,
  scanPage,
  todayFor,
  type Ctx,
  type Idem,
} from "./common";

interface TxFields {
  uid: string;
  accountId: string;
  type: TransactionType;
  amountCents: number;
  date: string;
  categoryId: string | null;
  description: string;
  notes: string | null;
  transferId: string | null;
  payableId: string | null;
  timestamp: string;
  requestHash: string;
}

/** Documento de lançamento (livro-razão). Todos os campos existem sempre (nulos quando vazios). */
export function transactionDoc(f: TxFields): DocData {
  return {
    uid: f.uid,
    accountId: f.accountId,
    type: f.type,
    amountCents: f.amountCents,
    signedCents: signedAmount(f.type, f.amountCents),
    date: f.date,
    categoryId: f.categoryId,
    description: f.description,
    notes: f.notes,
    status: "posted",
    transferId: f.transferId,
    payableId: f.payableId,
    createdAt: f.timestamp,
    updatedAt: f.timestamp,
    voidedAt: null,
    requestHash: f.requestHash,
  };
}

/** Incremento atômico do saldo da conta, junto do lançamento, na mesma gravação. */
export function balanceOp(uid: string, accountId: string, deltaCents: number, timestamp: string): WriteOp {
  return {
    path: pathsFor(uid).account(accountId),
    fields: { updatedAt: timestamp },
    merge: true,
    increments: { balanceCents: deltaCents },
    precondition: { exists: true },
  };
}

const normalize = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

// ----------------------------------------------------------- lançamentos

export async function transactionsRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listTransactions(ctx) : createTransaction(ctx);
  }
  assertId(id);
  if (action === "void") {
    allow(method, ["POST"]);
    return voidTransaction(ctx, id);
  }
  if (action !== undefined) throw notFound("Rota");
  allow(method, ["GET", "PATCH"]);
  return method === "GET" ? getTransaction(ctx, id) : patchTransaction(ctx, id);
}

async function listTransactions(ctx: Ctx): Promise<Response> {
  const { url } = ctx;
  const today = await todayFor(ctx);
  const month = monthBounds(today);
  const from = dateParam(url, "from", isValidDate) ?? month.from;
  const to = dateParam(url, "to", isValidDate) ?? month.to;
  if (from > to) throw new HttpError(400, "invalid_query", "O período inicial não pode ser posterior ao final");
  const accountId = url.searchParams.get("accountId");
  const categoryId = url.searchParams.get("categoryId");
  const type = enumParam(url, "type", TRANSACTION_TYPES);
  const status = enumParam(url, "status", ["posted", "voided"] as const);
  const limit = intParam(url, "limit", 50, 1, 200);
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  const { items, nextCursor } = await scanPage(
    ctx.db,
    pathsFor(ctx.uid).parent,
    {
      collection: "transactions",
      filters: [
        { field: "date", op: "GREATER_THAN_OR_EQUAL", value: from },
        { field: "date", op: "LESS_THAN_OR_EQUAL", value: to },
      ],
      orderBy: { field: "date", direction: "DESCENDING" },
    },
    (d) =>
      (accountId === null || d["accountId"] === accountId) &&
      (categoryId === null || d["categoryId"] === categoryId) &&
      (type === null || d["type"] === type) &&
      (status === null || d["status"] === status),
    limit,
    cursor,
  );
  return json({
    from,
    to,
    items: items.map((doc) => publicDoc<Transaction>(doc.id, doc.data)),
    nextCursor,
  });
}

async function getTransaction(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).transaction(id));
  if (!doc) throw notFound("Lançamento");
  return json(publicDoc<Transaction>(id, doc));
}

async function createTransaction(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, TransactionCreateSchema);
  const idem = await readIdempotency(ctx.request, "transaction", input);
  const p = pathsFor(ctx.uid);
  const path = p.transaction(idem.id);

  // 1) Repetição com a mesma chave: devolve o resultado original, sem gravar nada.
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  // 2) Referências válidas.
  await loadAccount(ctx, input.accountId);
  await checkCategory(ctx, input.categoryId, input.type);

  // 3) Duplicidade provável (chave diferente, mesmo conteúdo): exige confirmação explícita.
  if (!input.allowDuplicate) {
    const same = await ctx.db.query(p.parent, {
      collection: "transactions",
      filters: [{ field: "date", op: "EQUAL", value: input.date }],
      limit: 200,
    });
    const wanted = normalize(input.description);
    const duplicate = same.some(
      (doc) =>
        // O próprio lançamento (requisição simultânea com a mesma chave) cai no fluxo de repetição.
        doc.id !== idem.id &&
        doc.data["status"] === "posted" &&
        doc.data["accountId"] === input.accountId &&
        doc.data["type"] === input.type &&
        doc.data["amountCents"] === input.amountCents &&
        normalize(String(doc.data["description"] ?? "")) === wanted,
    );
    if (duplicate) {
      throw new HttpError(
        409,
        "possible_duplicate",
        "Já existe um lançamento igual nesta data (mesma conta, tipo, valor e descrição). Se for intencional, reenvie com allowDuplicate=true",
      );
    }
  }

  // 4) Lançamento + saldo, atômicos.
  const timestamp = ctx.now().toISOString();
  const doc = transactionDoc({
    uid: ctx.uid,
    accountId: input.accountId,
    type: input.type,
    amountCents: input.amountCents,
    date: input.date,
    categoryId: input.categoryId,
    description: input.description,
    notes: input.notes,
    transferId: null,
    payableId: null,
    timestamp,
    requestHash: idem.hash,
  });
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: doc, precondition: { exists: false } },
    balanceOp(ctx.uid, input.accountId, signedAmount(input.type, input.amountCents), timestamp),
  ]);
  return replay ?? json(publicDoc<Transaction>(idem.id, doc), 201);
}

async function patchTransaction(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, TransactionPatchSchema);
  const path = pathsFor(ctx.uid).transaction(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Lançamento");
  if (doc.data["status"] === "voided") {
    throw new HttpError(409, "voided_immutable", "Lançamento estornado não pode ser editado");
  }
  const type = doc.data["type"] as TransactionType;
  if (input.categoryId !== undefined && input.categoryId !== null) {
    if (type !== "income" && type !== "expense") {
      throw new HttpError(422, "invalid_category", "Transferências não têm categoria");
    }
    await checkCategory(ctx, input.categoryId, type);
  }
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  if (input.description !== undefined) changes["description"] = input.description;
  if (input.notes !== undefined) changes["notes"] = input.notes;
  if (input.categoryId !== undefined) changes["categoryId"] = input.categoryId;
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(publicDoc<Transaction>(id, { ...doc.data, ...changes }));
}

/** Estorno: o lançamento nunca é apagado; muda para `voided` e o saldo é revertido, atomicamente. */
async function voidTransaction(ctx: Ctx, id: string): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const path = p.transaction(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Lançamento");
  if (doc.data["status"] === "voided") return json(publicDoc<Transaction>(id, doc.data)); // já estornado
  if (doc.data["transferId"] !== null) {
    throw new HttpError(409, "part_of_transfer", "Este lançamento pertence a uma transferência; estorne a transferência");
  }
  const timestamp = ctx.now().toISOString();
  const changes: DocData = { status: "voided", voidedAt: timestamp, updatedAt: timestamp };
  const ops: WriteOp[] = [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
    balanceOp(ctx.uid, String(doc.data["accountId"]), -Number(doc.data["signedCents"]), timestamp),
  ];

  // Estornar a baixa de uma conta a pagar/receber reabre a conta.
  const payableId = doc.data["payableId"];
  if (typeof payableId === "string") {
    const payable = await ctx.db.getDoc(p.payable(payableId));
    if (payable && payable.data["status"] === "paid" && payable.data["transactionId"] === id) {
      ops.push({
        path: p.payable(payableId),
        fields: {
          status: "open",
          paidDate: null,
          paidAmountCents: null,
          transactionId: null,
          payRequestHash: null,
          updatedAt: timestamp,
        },
        merge: true,
        precondition: { updateTime: payable.updateTime },
      });
    }
  }
  await commitOrConflict(ctx, ops);
  return json(publicDoc<Transaction>(id, { ...doc.data, ...changes }));
}

// --------------------------------------------------------- transferências

export async function transfersRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listTransfers(ctx) : createTransfer(ctx);
  }
  assertId(id);
  if (action === "void") {
    allow(method, ["POST"]);
    return voidTransfer(ctx, id);
  }
  if (action !== undefined) throw notFound("Rota");
  allow(method, ["GET"]);
  const doc = await ctx.db.get(pathsFor(ctx.uid).transfer(id));
  if (!doc) throw notFound("Transferência");
  return json(publicDoc<Transfer>(id, doc));
}

async function listTransfers(ctx: Ctx): Promise<Response> {
  const limit = intParam(ctx.url, "limit", 50, 1, 200);
  const docs = await ctx.db.query(pathsFor(ctx.uid).parent, {
    collection: "transfers",
    orderBy: { field: "date", direction: "DESCENDING" },
    limit,
  });
  return json({ items: docs.map((doc) => publicDoc<Transfer>(doc.id, doc.data)) });
}

/**
 * Transferência atômica: UM commit grava a transferência, as duas pernas no livro-razão e os dois
 * saldos. Ou tudo é gravado, ou nada. Não existe estado "saiu de uma conta e não entrou na outra".
 */
async function createTransfer(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, TransferCreateSchema);
  const idem: Idem = await readIdempotency(ctx.request, "transfer", input);
  const p = pathsFor(ctx.uid);
  const path = p.transfer(idem.id);

  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  await loadAccount(ctx, input.fromAccountId);
  await loadAccount(ctx, input.toAccountId);

  const timestamp = ctx.now().toISOString();
  const outId = `${idem.id}_out`;
  const inId = `${idem.id}_in`;
  const description = input.description ?? "Transferência";
  const common = {
    uid: ctx.uid,
    amountCents: input.amountCents,
    date: input.date,
    categoryId: null,
    description,
    notes: null,
    transferId: idem.id,
    payableId: null,
    timestamp,
    requestHash: idem.hash,
  };
  const transfer: DocData = {
    uid: ctx.uid,
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountCents: input.amountCents,
    date: input.date,
    description: input.description,
    status: "posted",
    outTransactionId: outId,
    inTransactionId: inId,
    createdAt: timestamp,
    updatedAt: timestamp,
    voidedAt: null,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: transfer, precondition: { exists: false } },
    {
      path: p.transaction(outId),
      fields: transactionDoc({ ...common, accountId: input.fromAccountId, type: "transfer_out" }),
      precondition: { exists: false },
    },
    {
      path: p.transaction(inId),
      fields: transactionDoc({ ...common, accountId: input.toAccountId, type: "transfer_in" }),
      precondition: { exists: false },
    },
    balanceOp(ctx.uid, input.fromAccountId, -input.amountCents, timestamp),
    balanceOp(ctx.uid, input.toAccountId, input.amountCents, timestamp),
  ]);
  return replay ?? json(publicDoc<Transfer>(idem.id, transfer), 201);
}

async function voidTransfer(ctx: Ctx, id: string): Promise<Response> {
  const p = pathsFor(ctx.uid);
  const doc = await ctx.db.getDoc(p.transfer(id));
  if (!doc) throw notFound("Transferência");
  if (doc.data["status"] === "voided") return json(publicDoc<Transfer>(id, doc.data));

  const timestamp = ctx.now().toISOString();
  const amount = Number(doc.data["amountCents"]);
  const voided: DocData = { status: "voided", voidedAt: timestamp, updatedAt: timestamp };
  await commitOrConflict(ctx, [
    { path: p.transfer(id), fields: voided, merge: true, precondition: { updateTime: doc.updateTime } },
    {
      path: p.transaction(String(doc.data["outTransactionId"])),
      fields: voided,
      merge: true,
      precondition: { exists: true },
    },
    {
      path: p.transaction(String(doc.data["inTransactionId"])),
      fields: voided,
      merge: true,
      precondition: { exists: true },
    },
    balanceOp(ctx.uid, String(doc.data["fromAccountId"]), amount, timestamp),
    balanceOp(ctx.uid, String(doc.data["toAccountId"]), -amount, timestamp),
  ]);
  return json(publicDoc<Transfer>(id, { ...doc.data, ...voided }));
}
