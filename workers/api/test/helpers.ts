import type { LLMProvider, SpeechToTextProvider } from "../src/ai/providers";
import type { PaymentProvider } from "../src/billing/provider";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { KeyLike, JWK } from "jose";
import { createHandler } from "../src/app";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { createAuthUser, createDatabase, decodeJwtPayload, postgrestFetch, resetDatabase } from "@lifeflow/db";
import type { Env } from "../src/env";

export const SUPABASE_URL = "https://lifeflow-test.supabase.co";
export const ISSUER = `${SUPABASE_URL}/auth/v1`;
export const ORIGIN = "https://app.lifeflow.test";

export const env: Env = {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ALLOWED_ORIGIN: ORIGIN,
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
  /** `app_metadata.admin = true` (só quem administra o projeto Supabase consegue defini-la). */
  admin?: boolean;
  /** Momento do último login (epoch, s), gravado em `amr[].timestamp`. Padrão: agora - 10 s. */
  authTime?: number;
}

export async function signToken(signer: Signer, options: TokenOptions = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    email: options.email ?? "user@example.com",
    role: "authenticated",
    amr: [{ method: "password", timestamp: options.authTime ?? nowSec - 10 }],
    app_metadata: { provider: "email", ...(options.admin ? { admin: true } : {}) },
  })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt(options.issuedAt ?? nowSec - 10)
    .setExpirationTime(options.expiresAt ?? nowSec + 3600);
  if (options.uid !== undefined) jwt.setSubject(uuidFor(options.uid));
  return jwt.sign(signer.privateKey);
}

export interface RecordedCall {
  method: string;
  url: string;
  /** Cabeçalho `Authorization` (JWT do usuário). Ausente nas chamadas privilegiadas. */
  authorization: string | null;
  /** Cabeçalho `apikey`: chave publicável (rotas normais) ou secreta (caminho privilegiado restrito). */
  apikey: string | null;
  body: string | null;
}

let sharedDatabase: Promise<PGlite> | undefined;

/** Um PostgreSQL por arquivo de teste (criar com as migrações custa ~1 s); os dados são zerados a cada mundo. */
function database(): Promise<PGlite> {
  sharedDatabase ??= createDatabase();
  return sharedDatabase;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids de usuário do Supabase são UUIDs. Rótulos legíveis dos testes (`userA`) viram UUIDs determinísticos. */
export function uuidFor(label: string): string {
  if (UUID.test(label)) return label.toLowerCase();
  const h = createHash("sha1").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Supabase falso para os testes: PostgreSQL REAL (PGlite) com as MESMAS migrações de `supabase/migrations`
 * (esquema, gatilhos, RLS e funções `lf_*`) atrás de um PostgREST emulado. Registra todas as chamadas para os
 * testes inspecionarem o que o Worker enviou. A RLS e os gatilhos valem de verdade; o que não é coberto é a
 * verificação do JWT pelo PostgREST e o GoTrue (isso fica na suíte de integração, com `supabase start`).
 */
export async function fakeSupabase() {
  const db = await database();
  await resetDatabase(db);
  const calls: RecordedCall[] = [];
  const known = new Set<string>();
  let failures: Array<number | "network"> = [];
  let commitFailures: Array<number | "network"> = [];
  const inner = postgrestFetch(db);

  /** No Supabase real quem cria o usuário é o GoTrue no cadastro; aqui ele passa a existir no primeiro uso. */
  const ensureUser = async (uid: string): Promise<void> => {
    if (known.has(uid)) return;
    known.add(uid);
    await createAuthUser(db, uid);
  };

  const self = {
    db,
    calls,
    ensureUser,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({
        method: init?.method ?? "GET",
        url: url.toString(),
        authorization: headers.get("Authorization"),
        apikey: headers.get("apikey"),
        body,
      });

      const next = failures.shift();
      if (next === "network") throw new TypeError("network error");
      if (typeof next === "number") return new Response("{}", { status: next });
      if (url.pathname.endsWith("/rpc/lf_commit")) {
        const failure = commitFailures.shift();
        if (failure === "network") throw new TypeError("network error");
        if (typeof failure === "number") return new Response("{}", { status: failure });
      }

      // Usuários citados em caminhos de escrita (`users/{uid}`, `subscriptions/{uid}`) existem no GoTrue.
      const bearer = /^Bearer\s+(.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
      if (bearer) {
        try {
          const sub = decodeJwtPayload(bearer).sub;
          if (typeof sub === "string" && UUID.test(sub)) await ensureUser(sub);
        } catch {
          /* token malformado: o PostgREST emulado responde 401 */
        }
      }
      if (body && (headers.get("apikey") ?? "").startsWith("sb_secret_") && url.pathname.endsWith("/rpc/lf_commit")) {
        for (const m of body.matchAll(/"path":"(?:users|subscriptions)\/([0-9a-f-]{36})/g)) await ensureUser(m[1] as string);
      }

      const response = await inner(input, init);
      if (url.pathname.endsWith("/rpc/lf_erase_user") && body) {
        const uid = (JSON.parse(body) as { p_uid?: string }).p_uid;
        if (uid) known.delete(uid);
      }
      return response;
    }) as typeof fetch,
    /** Os próximos pedidos (de qualquer tipo) falham com este status (ou erro de rede). */
    failNext(...statuses: Array<number | "network">) {
      failures = statuses;
    },
    /** Faz o(s) próximo(s) `lf_commit` falharem (os demais pedidos seguem normais). */
    failCommit(...statuses: Array<number | "network">) {
      commitFailures = statuses;
    },
    /** SQL direto como superusuário (ignora a RLS): só para preparar ou inspecionar o estado nos testes. */
    async sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await db.query<T>(text, params)).rows;
    },
    /** Todas as linhas de todas as tabelas públicas, como objetos JSON. */
    async allRows(): Promise<Array<{ table: string; row: Record<string, unknown> }>> {
      const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
      const out: Array<{ table: string; row: Record<string, unknown> }> = [];
      for (const { tablename } of tables.rows) {
        const rows = await db.query<{ r: Record<string, unknown> }>(`select to_jsonb(t) as r from public."${tablename}" t`);
        for (const { r } of rows.rows) out.push({ table: tablename, row: r });
      }
      return out;
    },
  };
  return self;
}

export type FakeSupabase = Awaited<ReturnType<typeof fakeSupabase>>;

/** Relógio ajustável dos testes: `clock.now` pode ser alterado entre as requisições. */
export interface Clock {
  now: Date;
}

/** `signer = null` usa o resolvedor REAL de chaves (JWKS do Supabase), para a suíte de integração. */
export function makeApp(
  signer: Signer | null,
  fetchImpl: typeof fetch,
  envOverride: Partial<Env> = {},
  clock?: Clock,
  providers: { llm?: LLMProvider; stt?: SpeechToTextProvider; payments?: PaymentProvider } = {},
) {
  const handle = createHandler({
    fetchImpl,
    ...(providers.llm ? { llm: providers.llm } : {}),
    ...(providers.stt ? { stt: providers.stt } : {}),
    ...(providers.payments ? { payments: providers.payments } : {}),
    ...(signer ? { keyResolver: () => createLocalJWKSet({ keys: [signer.jwk] }) } : {}),
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

/**
 * Concede um plano a um usuário gravando `subscriptions/{uid}` pelo MESMO caminho privilegiado do Worker
 * (a chave secreta equivale ao papel `service_role`, que ignora a RLS). Só para preparar testes.
 */
export async function grantPlan(
  fetchImpl: typeof fetch,
  baseUrl: string,
  uid: string,
  plan: "free" | "pro" | "premium_ai",
  over: Record<string, string | number | boolean | null> = {},
  secretKey: string | undefined = env.SUPABASE_SECRET_KEY,
): Promise<void> {
  if (plan === "free") return;
  const { createSystemDb } = await import("../src/system");
  const sys = await createSystemDb({ ...env, SUPABASE_URL: baseUrl, ...(secretKey ? { SUPABASE_SECRET_KEY: secretKey } : {}) }, fetchImpl);
  await sys.commit([
    {
      path: `subscriptions/${uid}`,
      fields: {
        uid,
        planId: plan,
        pendingPlanId: null,
        status: "active",
        providerSubscriptionId: `sub_${uid}`,
        priceCents: plan === "pro" ? 1490 : 2990,
        currentPeriodEnd: "2027-12-31T00:00:00.000Z",
        graceUntil: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        checkoutUrl: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        ...over,
      },
    },
  ]);
}

/** `sub` de um ID token (só para testes). */
export function uidOfToken(token: string): string {
  return (JSON.parse(atob((token.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/"))) as { sub: string }).sub;
}
