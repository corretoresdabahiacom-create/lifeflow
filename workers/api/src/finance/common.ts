import { DOC_ID_RE, isValidTimeZone, todayInTimeZone } from "@lifeflow/shared";
import { HttpError } from "../errors";
import {
  PreconditionFailedError,
  type DocData,
  type FirestoreClient,
  type QuerySpec,
  type StoredDoc,
  type WriteOp,
} from "../firestore";
import { json } from "../http";

export interface Ctx {
  request: Request;
  url: URL;
  /** Vem SOMENTE do token validado. Todo caminho do banco é derivado dele. */
  uid: string;
  db: FirestoreClient;
  now: () => Date;
}

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

export function pathsFor(uid: string) {
  const parent = `users/${uid}`;
  return {
    parent,
    profile: parent,
    account: (id: string) => `${parent}/accounts/${id}`,
    category: (id: string) => `${parent}/categories/${id}`,
    transaction: (id: string) => `${parent}/transactions/${id}`,
    transfer: (id: string) => `${parent}/transfers/${id}`,
    payable: (id: string) => `${parent}/payables/${id}`,
    recurring: (id: string) => `${parent}/recurring/${id}`,
    event: (id: string) => `${parent}/events/${id}`,
    eventException: (id: string) => `${parent}/eventExceptions/${id}`,
    task: (id: string) => `${parent}/tasks/${id}`,
    taskCategory: (id: string) => `${parent}/taskCategories/${id}`,
    reminder: (id: string) => `${parent}/reminders/${id}`,
    notification: (id: string) => `${parent}/notifications/${id}`,
    preferences: `${parent}/preferences/app`,
  };
}

export const notFound = (what = "Recurso"): HttpError => new HttpError(404, "not_found", `${what} não encontrado`);

export const conflict = (): HttpError =>
  new HttpError(409, "conflict", "O registro foi alterado por outra operação; recarregue e tente novamente");

/** Identificadores que vêm da URL entram em caminhos do banco: só o formato seguro passa. */
export function assertId(id: string): string {
  if (!DOC_ID_RE.test(id)) throw notFound();
  return id;
}

// ---- Idempotência ----

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Idem {
  /** Id determinístico do documento principal, derivado da chave. */
  id: string;
  /** Hash do conteúdo: mesma chave + conteúdo diferente = erro 422. */
  hash: string;
  /** Identifica esta requisição exata (escopo + chave + conteúdo). */
  fingerprint: string;
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export async function readIdempotency(request: Request, scope: string, input: unknown): Promise<Idem> {
  const key = request.headers.get("Idempotency-Key");
  if (!key) {
    throw new HttpError(400, "idempotency_key_required", "O cabeçalho Idempotency-Key é obrigatório nesta operação");
  }
  if (!KEY_RE.test(key)) {
    throw new HttpError(400, "idempotency_key_invalid", "Idempotency-Key inválida (8 a 128 caracteres: letras, números, _ - : .)");
  }
  const hash = await sha256Hex(canonicalJson(input));
  return {
    id: (await sha256Hex(`${scope}:${key}`)).slice(0, 40),
    hash,
    fingerprint: await sha256Hex(`${scope}|${key}|${hash}`),
  };
}

const INTERNAL_FIELDS = new Set(["requestHash", "payRequestHash"]);

/** Documento no formato da API: com `id` e sem campos internos de idempotência. */
export function publicDoc<T>(id: string, data: DocData): T {
  const out: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(data)) if (!INTERNAL_FIELDS.has(key)) out[key] = value;
  return out as T;
}

export function replayResponse(id: string, existing: DocData, idem: Idem): Response {
  if (existing["requestHash"] !== idem.hash) {
    throw new HttpError(
      422,
      "idempotency_key_reuse",
      "Esta Idempotency-Key já foi usada com um conteúdo diferente; gere uma nova chave",
    );
  }
  return json(publicDoc(id, existing), 200, { "Idempotent-Replay": "true" });
}

/**
 * Grava de forma atômica uma operação idempotente. Se o documento principal já existe
 * (repetição ou requisições simultâneas com a mesma chave), devolve a resposta original
 * e NADA é gravado de novo. Retorna `null` quando a gravação foi feita agora.
 */
export async function commitIdempotent(
  ctx: Ctx,
  mainPath: string,
  mainId: string,
  idem: Idem,
  ops: WriteOp[],
): Promise<Response | null> {
  try {
    await ctx.db.commit(ops);
    return null;
  } catch (error) {
    if (!(error instanceof PreconditionFailedError)) throw error;
    const existing = await ctx.db.get(mainPath);
    if (existing) return replayResponse(mainId, existing, idem);
    throw conflict();
  }
}

/** Commit atômico sem idempotência própria: pré-condição falha vira 409. */
export async function commitOrConflict(ctx: Ctx, ops: WriteOp[]): Promise<void> {
  try {
    await ctx.db.commit(ops);
  } catch (error) {
    if (error instanceof PreconditionFailedError) throw conflict();
    throw error;
  }
}

// ---- Leitura ----

export interface Cursor {
  value: string;
  id: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})~([A-Za-z0-9_-]{1,80})$/;

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.value}~${cursor.id}`;
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (raw === null || raw === "") return null;
  const match = CURSOR_RE.exec(raw);
  if (!match) throw new HttpError(400, "invalid_cursor", "Cursor inválido");
  return { value: match[1] ?? "", id: match[2] ?? "" };
}

const sortValue = (value: DocData[string] | undefined): string | number | null =>
  typeof value === "string" || typeof value === "number" ? value : null;

/** Lê todas as páginas de uma consulta até `maxDocs`; informa se o limite cortou resultados. */
export async function readAll(
  db: FirestoreClient,
  parent: string,
  spec: Omit<QuerySpec, "limit" | "after">,
  maxDocs = 5000,
  pageSize = 500,
): Promise<{ docs: StoredDoc[]; truncated: boolean }> {
  const docs: StoredDoc[] = [];
  let after: QuerySpec["after"];
  while (docs.length < maxDocs) {
    const want = Math.min(pageSize, maxDocs - docs.length);
    const page = await db.query(parent, { ...spec, limit: want, ...(after ? { after } : {}) });
    docs.push(...page);
    if (page.length < want) return { docs, truncated: false };
    const last = page[page.length - 1] as StoredDoc;
    after = { value: spec.orderBy ? sortValue(last.data[spec.orderBy.field]) : null, id: last.id };
  }
  const probe = await db.query(parent, { ...spec, limit: 1, ...(after ? { after } : {}) });
  return { docs, truncated: probe.length > 0 };
}

const SCAN_PAGE = 200;
const MAX_SCAN = 2000;

/**
 * Página de resultados com filtros extras aplicados em memória (evita índices compostos).
 * Varre no máximo `MAX_SCAN` documentos por chamada; o cursor permite continuar.
 */
export async function scanPage(
  db: FirestoreClient,
  parent: string,
  spec: Omit<QuerySpec, "limit" | "after"> & { orderBy: NonNullable<QuerySpec["orderBy"]> },
  match: (data: DocData) => boolean,
  limit: number,
  cursor: Cursor | null,
): Promise<{ items: StoredDoc[]; nextCursor: string | null }> {
  const items: StoredDoc[] = [];
  let scanned = 0;
  let last: Cursor | null = cursor;
  let more = true;
  while (more && items.length < limit && scanned < MAX_SCAN) {
    const page = await db.query(parent, {
      ...spec,
      limit: SCAN_PAGE,
      ...(last ? { after: { value: last.value, id: last.id } } : {}),
    });
    more = page.length === SCAN_PAGE;
    for (let i = 0; i < page.length; i++) {
      const doc = page[i] as StoredDoc;
      scanned++;
      last = { value: String(doc.data[spec.orderBy.field] ?? ""), id: doc.id };
      if (match(doc.data)) items.push(doc);
      if (items.length >= limit) {
        more = more || i < page.length - 1;
        break;
      }
    }
    if (page.length === 0) more = false;
  }
  return { items, nextCursor: more && last ? encodeCursor(last) : null };
}

// ---- Validações de referência ----

export async function todayFor(ctx: Ctx): Promise<string> {
  const profile = await ctx.db.get(pathsFor(ctx.uid).profile);
  const timezone = typeof profile?.["timezone"] === "string" ? profile["timezone"] : DEFAULT_TIMEZONE;
  return todayInTimeZone(ctx.now(), timezone);
}

/** Fuso do perfil (padrão America/Sao_Paulo); fuso inválido cai no padrão. */
export async function profileTimeZone(ctx: Ctx): Promise<string> {
  const profile = await ctx.db.get(pathsFor(ctx.uid).profile);
  const tz = typeof profile?.["timezone"] === "string" ? profile["timezone"] : DEFAULT_TIMEZONE;
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

export async function loadAccount(
  ctx: Ctx,
  id: string,
  options: { allowArchived?: boolean } = {},
): Promise<{ data: DocData; updateTime: string }> {
  const doc = await ctx.db.getDoc(pathsFor(ctx.uid).account(id));
  if (!doc) throw new HttpError(404, "account_not_found", "Conta não encontrada");
  if (doc.data["archived"] === true && !options.allowArchived) {
    throw new HttpError(422, "account_archived", "Conta arquivada não aceita novos lançamentos");
  }
  return doc;
}

export async function checkCategory(
  ctx: Ctx,
  categoryId: string | null,
  kind: "income" | "expense",
): Promise<void> {
  if (categoryId === null) return;
  const doc = await ctx.db.get(pathsFor(ctx.uid).category(categoryId));
  if (!doc) throw new HttpError(404, "category_not_found", "Categoria não encontrada");
  if (doc["kind"] !== kind) {
    throw new HttpError(422, "invalid_category", `A categoria deve ser de ${kind === "income" ? "receita" : "despesa"}`);
  }
  if (doc["archived"] === true) {
    throw new HttpError(422, "category_archived", "Categoria arquivada não pode ser usada");
  }
}

export function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new HttpError(400, "invalid_query", `Parâmetro ${name} inválido`);
  const value = Number(raw);
  if (value < min || value > max) throw new HttpError(400, "invalid_query", `Parâmetro ${name} fora do intervalo`);
  return value;
}

export function dateParam(url: URL, name: string, isValid: (value: string) => boolean): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  if (!isValid(raw)) throw new HttpError(400, "invalid_query", `Parâmetro ${name} inválido (use AAAA-MM-DD)`);
  return raw;
}

export function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new HttpError(400, "invalid_query", `Parâmetro ${name} inválido`);
  }
  return raw as T;
}
