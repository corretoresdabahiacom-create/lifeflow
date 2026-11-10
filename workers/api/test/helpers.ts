import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { KeyLike, JWK } from "jose";
import { createHandler } from "../src/app";
import { decodeFields, encodeFields, type DocData } from "../src/firestore";
import type { Env } from "../src/env";

export const PROJECT_ID = "demo-lifeflow";
export const ORIGIN = "https://app.lifeflow.test";

export const env: Env = {
  FIREBASE_PROJECT_ID: PROJECT_ID,
  ALLOWED_ORIGIN: ORIGIN,
  FIRESTORE_BASE_URL: "https://firestore.test",
};

export interface Signer {
  jwk: JWK;
  privateKey: KeyLike;
}

export async function makeSigner(kid = "k1"): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { jwk, privateKey };
}

export interface TokenOptions {
  uid?: string;
  email?: string;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
  kid?: string;
}

export async function signToken(signer: Signer, options: TokenOptions = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: options.email ?? "user@example.com", auth_time: nowSec - 10 })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.issuer ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(options.audience ?? PROJECT_ID)
    .setIssuedAt(options.issuedAt ?? nowSec - 10)
    .setExpirationTime(options.expiresAt ?? nowSec + 3600);
  if (options.uid !== undefined) jwt.setSubject(options.uid);
  return jwt.sign(signer.privateKey);
}

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

type RestFields = Parameters<typeof decodeFields>[0];

interface RestValueIn {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  referenceValue?: string;
}

const decodeValue = (v: RestValueIn): string | number | boolean | null => {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.referenceValue !== undefined) return v.referenceValue.split("/").pop() ?? "";
  return null;
};

interface FakeRow {
  id: string;
  data: DocData;
}

/**
 * Firestore falso em memória. Registra todas as chamadas para que os testes inspecionem o que o
 * Worker enviou. Implementa o que o Worker usa: GET/PATCH/DELETE de documento, `:commit` atômico
 * (pré-condições exists/updateTime e incremento) e `:runQuery` (filtros, ordem, cursor, limite).
 * NÃO aplica Security Rules nem índices: isso é provado no emulador (CI).
 */
export function fakeFirestore(initial: Record<string, DocData> = {}) {
  const docs = new Map<string, DocData>(Object.entries(initial));
  const times = new Map<string, string>();
  const calls: RecordedCall[] = [];
  let failures: Array<number | "network"> = [];
  let commitFailures: Array<number | "network"> = [];
  let tick = 0;
  const touch = (path: string): void => {
    times.set(path, new Date(1_800_000_000_000 + ++tick * 1000).toISOString());
  };
  for (const key of docs.keys()) touch(key);

  const marker = "/documents/";
  const pathAfterDocuments = (url: URL): string =>
    decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  const nameToPath = (name: string): string => name.slice(name.indexOf(marker) + marker.length);
  const errorResponse = (status: number, code: string): Response =>
    new Response(JSON.stringify({ error: { code: status, status: code, message: code } }), { status });

  const commit = (body: string): Response => {
    type Write = {
      update?: { name: string; fields?: RestFields };
      delete?: string;
      updateMask?: { fieldPaths: string[] };
      updateTransforms?: Array<{ fieldPath: string; increment: { integerValue: string } }>;
      currentDocument?: { exists?: boolean; updateTime?: string };
    };
    const { writes } = JSON.parse(body) as { writes: Write[] };
    // 1) Todas as pré-condições antes de gravar qualquer coisa (atomicidade).
    for (const write of writes) {
      const path = nameToPath((write.update?.name ?? write.delete) as string);
      const current = docs.get(path);
      const condition = write.currentDocument;
      if (!condition) continue;
      if (condition.exists === false && current) return errorResponse(409, "ALREADY_EXISTS");
      if (condition.exists === true && !current) return errorResponse(404, "NOT_FOUND");
      if (condition.updateTime !== undefined && (!current || times.get(path) !== condition.updateTime)) {
        return errorResponse(400, "FAILED_PRECONDITION");
      }
    }
    // 2) Aplica tudo.
    for (const write of writes) {
      if (write.delete !== undefined) {
        const gone = nameToPath(write.delete);
        docs.delete(gone);
        times.delete(gone);
        continue;
      }
      const update = write.update as NonNullable<Write["update"]>;
      const path = nameToPath(update.name);
      const fields = decodeFields(update.fields);
      const mask = write.updateMask?.fieldPaths;
      const next: DocData = mask ? { ...(docs.get(path) ?? {}) } : {};
      if (mask) for (const field of mask) next[field] = fields[field] ?? null;
      else Object.assign(next, fields);
      for (const transform of write.updateTransforms ?? []) {
        next[transform.fieldPath] = Number(next[transform.fieldPath] ?? 0) + Number(transform.increment.integerValue);
      }
      docs.set(path, next);
      touch(path);
    }
    return new Response(JSON.stringify({ writeResults: writes.map(() => ({})) }), { status: 200 });
  };

  const runQuery = (parent: string, body: string): Response => {
    type Filter = { fieldFilter: { field: { fieldPath: string }; op: string; value: RestValueIn } };
    type Order = { field: { fieldPath: string }; direction?: string };
    const { structuredQuery: sq } = JSON.parse(body) as {
      structuredQuery: {
        from: Array<{ collectionId: string }>;
        where?: Filter | { compositeFilter: { filters: Filter[] } };
        orderBy?: Order[];
        limit?: number;
        startAt?: { values: RestValueIn[]; before?: boolean };
      };
    };
    const prefix = `${parent}/${sq.from[0]?.collectionId}/`;
    let rows: FakeRow[] = [...docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({ id: path.slice(prefix.length), data }));

    const filters: Filter[] = !sq.where ? [] : "compositeFilter" in sq.where ? sq.where.compositeFilter.filters : [sq.where];
    for (const { fieldFilter } of filters) {
      const field = fieldFilter.field.fieldPath;
      const wanted = decodeValue(fieldFilter.value);
      rows = rows.filter((row) => {
        const value = row.data[field];
        if (value === undefined || value === null || wanted === null) return false;
        if (fieldFilter.op === "EQUAL") return value === wanted;
        if (fieldFilter.op === "GREATER_THAN_OR_EQUAL") return value >= wanted;
        if (fieldFilter.op === "LESS_THAN_OR_EQUAL") return value <= wanted;
        throw new Error(`Operador não suportado no fake: ${fieldFilter.op}`);
      });
    }

    const orders: Order[] = sq.orderBy ?? [{ field: { fieldPath: "__name__" } }];
    const compare = (a: FakeRow, b: FakeRow): number => {
      for (const order of orders) {
        const field = order.field.fieldPath;
        const av = field === "__name__" ? a.id : (a.data[field] ?? null);
        const bv = field === "__name__" ? b.id : (b.data[field] ?? null);
        if (av === bv) continue;
        const sign = av === null ? -1 : bv === null ? 1 : av < bv ? -1 : 1;
        return order.direction === "DESCENDING" ? -sign : sign;
      }
      return 0;
    };
    rows.sort(compare);

    if (sq.startAt) {
      const cursor: FakeRow = { id: "", data: {} };
      orders.forEach((order, index) => {
        const value = decodeValue(sq.startAt?.values[index] ?? { nullValue: null });
        if (order.field.fieldPath === "__name__") cursor.id = String(value);
        else cursor.data[order.field.fieldPath] = value;
      });
      rows = rows.filter((row) => (sq.startAt?.before ? compare(row, cursor) >= 0 : compare(row, cursor) > 0));
    }
    if (sq.limit !== undefined) rows = rows.slice(0, sq.limit);

    const readTime = "2026-01-01T00:00:00Z";
    const result =
      rows.length === 0
        ? [{ readTime }]
        : rows.map((row) => {
            const path = `${prefix}${row.id}`;
            return {
              document: {
                name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
                fields: encodeFields(row.data),
                updateTime: times.get(path),
              },
              readTime,
            };
          });
    return new Response(JSON.stringify(result), { status: 200 });
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.toString(), authorization: headers.get("Authorization"), body });

    const next = failures.shift();
    if (next === "network") throw new TypeError("network error");
    if (typeof next === "number") return new Response("{}", { status: next });

    if (method === "POST" && url.pathname.endsWith(":commit")) {
      const failure = commitFailures.shift();
      if (failure === "network") throw new TypeError("network error");
      if (typeof failure === "number") return new Response("{}", { status: failure });
      return commit(body ?? "{}");
    }
    if (method === "POST" && url.pathname.endsWith(":runQuery")) {
      return runQuery(pathAfterDocuments(url).replace(/:runQuery$/, ""), body ?? "{}");
    }

    const path = pathAfterDocuments(url);
    if (method === "GET") {
      const doc = docs.get(path);
      if (!doc) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ name: path, fields: encodeFields(doc), updateTime: times.get(path) }),
        { status: 200 },
      );
    }
    if (method === "PATCH") {
      const parsed = JSON.parse(body ?? "{}") as { fields?: RestFields };
      docs.set(path, { ...(docs.get(path) ?? {}), ...decodeFields(parsed.fields) });
      touch(path);
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") {
      docs.delete(path);
      times.delete(path);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 405 });
  }) as typeof fetch;

  return {
    docs,
    calls,
    fetchImpl,
    failNext(...statuses: Array<number | "network">) {
      failures = statuses;
    },
    /** Faz o(s) próximo(s) `commit` falharem (os demais pedidos seguem normais). */
    failCommit(...statuses: Array<number | "network">) {
      commitFailures = statuses;
    },
  };
}

/** Relógio ajustável dos testes: `clock.now` pode ser alterado entre as requisições. */
export interface Clock {
  now: Date;
}

export function makeApp(signer: Signer, fetchImpl: typeof fetch, envOverride: Partial<Env> = {}, clock?: Clock) {
  const handle = createHandler({
    fetchImpl,
    keyResolver: () => createLocalJWKSet({ keys: [signer.jwk] }),
    now: () => clock?.now ?? new Date("2026-11-09T12:00:00.000Z"),
  });
  return (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return handle(new Request(`https://api.test${path}`, { ...init, headers }), { ...env, ...envOverride });
  };
}

export const validProfile = {
  displayName: "Ana",
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
};

export const validPrefs = {
  theme: "dark",
  confirmCreations: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};

export const putJson = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
