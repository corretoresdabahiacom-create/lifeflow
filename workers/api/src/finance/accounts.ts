import {
  AccountCreateSchema,
  AccountPatchSchema,
  CategoryCreateSchema,
  CategoryPatchSchema,
  type Account,
  type Category,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import type { DocData } from "../firestore";
import { allow, json, parseBody } from "../http";
import {
  assertId,
  commitIdempotent,
  commitOrConflict,
  notFound,
  pathsFor,
  publicDoc,
  readAll,
  readIdempotency,
  replayResponse,
  type Ctx,
} from "./common";

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, "pt-BR");

// ---------------------------------------------------------------- contas

export async function accountsRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (action !== undefined) throw notFound("Rota");
  const method = ctx.request.method;
  if (id === undefined) {
    allow(method, ["GET", "POST"]);
    return method === "GET" ? listAccounts(ctx) : createAccount(ctx);
  }
  assertId(id);
  allow(method, ["GET", "PATCH"]);
  return method === "GET" ? getAccount(ctx, id) : patchAccount(ctx, id);
}

async function listAccounts(ctx: Ctx): Promise<Response> {
  const includeArchived = ctx.url.searchParams.get("archived") === "true";
  const { docs } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "accounts" }, 500);
  const accounts = docs
    .map((doc) => publicDoc<Account>(doc.id, doc.data))
    .filter((account) => includeArchived || !account.archived)
    .sort(byName);
  const totalBalanceCents = accounts.filter((a) => !a.archived).reduce((sum, a) => sum + a.balanceCents, 0);
  return json({ accounts, totalBalanceCents });
}

async function getAccount(ctx: Ctx, id: string): Promise<Response> {
  const doc = await ctx.db.get(pathsFor(ctx.uid).account(id));
  if (!doc) throw notFound("Conta");
  return json(publicDoc<Account>(id, doc));
}

async function createAccount(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, AccountCreateSchema);
  const idem = await readIdempotency(ctx.request, "account", input);
  const path = pathsFor(ctx.uid).account(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    name: input.name,
    type: input.type,
    initialBalanceCents: input.initialBalanceCents,
    // O saldo atual é mantido por incrementos atômicos junto de cada lançamento.
    balanceCents: input.initialBalanceCents,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: doc, precondition: { exists: false } },
  ]);
  return replay ?? json(publicDoc<Account>(idem.id, doc), 201);
}

async function patchAccount(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, AccountPatchSchema);
  const path = pathsFor(ctx.uid).account(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw notFound("Conta");
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  if (input.name !== undefined) changes["name"] = input.name;
  if (input.archived !== undefined) changes["archived"] = input.archived;
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(publicDoc<Account>(id, { ...doc.data, ...changes }));
}

// ------------------------------------------------------------ categorias

export async function categoriesRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
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
  const { docs } = await readAll(ctx.db, pathsFor(ctx.uid).parent, { collection: "categories" }, 500);
  const categories = docs
    .map((doc) => publicDoc<Category>(doc.id, doc.data))
    .filter((category) => includeArchived || !category.archived)
    .sort(byName);
  return json({ categories });
}

async function createCategory(ctx: Ctx): Promise<Response> {
  const input = await parseBody(ctx.request, CategoryCreateSchema);
  const idem = await readIdempotency(ctx.request, "category", input);
  const path = pathsFor(ctx.uid).category(idem.id);
  const existing = await ctx.db.get(path);
  if (existing) return replayResponse(idem.id, existing, idem);

  const timestamp = ctx.now().toISOString();
  const doc: DocData = {
    uid: ctx.uid,
    name: input.name,
    kind: input.kind,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    requestHash: idem.hash,
  };
  const replay = await commitIdempotent(ctx, path, idem.id, idem, [
    { path, fields: doc, precondition: { exists: false } },
  ]);
  return replay ?? json(publicDoc<Category>(idem.id, doc), 201);
}

async function patchCategory(ctx: Ctx, id: string): Promise<Response> {
  const input = await parseBody(ctx.request, CategoryPatchSchema);
  const path = pathsFor(ctx.uid).category(id);
  const doc = await ctx.db.getDoc(path);
  if (!doc) throw new HttpError(404, "not_found", "Categoria não encontrada");
  const changes: DocData = { updatedAt: ctx.now().toISOString() };
  if (input.name !== undefined) changes["name"] = input.name;
  if (input.archived !== undefined) changes["archived"] = input.archived;
  await commitOrConflict(ctx, [
    { path, fields: changes, merge: true, precondition: { updateTime: doc.updateTime } },
  ]);
  return json(publicDoc<Category>(id, { ...doc.data, ...changes }));
}
