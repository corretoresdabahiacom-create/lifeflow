import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * PostgreSQL local para testes (PGlite = PostgreSQL real compilado para WebAssembly) com as MESMAS migrações
 * de `supabase/migrations`. Emula o que o Supabase fornece (papéis, `auth.users`, `auth.uid()`) e o PostgREST
 * (papel + claims do JWT por requisição, chamada de função, mapeamento de erro SQL -> HTTP).
 *
 * O que NÃO é coberto aqui (só no Supabase real / `supabase start` na CI): a verificação criptográfica do JWT
 * pelo PostgREST, o GoTrue (login) e o formato exato dos cabeçalhos HTTP.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(join(here, "bootstrap.sql"), "utf8"));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

export type Role = "anon" | "authenticated" | "service_role";

export interface Claims {
  sub?: string;
  role?: Role;
  [key: string]: unknown;
}

/** Executa `fn` numa transação com o papel e os claims informados (como o PostgREST faz por requisição). */
export async function withRole<T>(
  db: PGlite,
  role: Role,
  claims: Claims,
  fn: (tx: Pick<PGlite, "query" | "exec">) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...claims, role })]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

/** Cria o usuário em auth.users (no Supabase real, quem cria é o GoTrue no cadastro). */
export async function createAuthUser(db: PGlite, uid: string, email = `${uid}@example.com`): Promise<void> {
  await db.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [uid, email]);
}

/** Apaga todos os dados (mantém o esquema). Mais rápido que recriar o banco entre testes. */
export async function resetDatabase(db: PGlite): Promise<void> {
  await db.exec("truncate table auth.users cascade; truncate table public.plans, public.webhook_events, public.admin_logs;");
}

// ---- Emulação do PostgREST (somente `/rest/v1/rpc/<função>`) ----

const FUNCTIONS: Record<string, { args: string[]; casts: string[] }> = {
  lf_get: { args: ["p_path"], casts: ["text"] },
  lf_commit: { args: ["p_ops"], casts: ["jsonb"] },
  lf_query: { args: ["p_parent", "p_collection", "p_spec"], casts: ["text", "text", "jsonb"] },
  lf_count: { args: ["p_collection", "p_filters"], casts: ["text", "jsonb"] },
  lf_erase_user: { args: ["p_uid"], casts: ["uuid"] },
};

export function decodeJwtPayload(token: string): Claims {
  const part = token.split(".")[1];
  if (!part) throw new Error("jwt");
  return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Claims;
}

const SERVICE_KEY_PREFIX = "sb_secret_";

/** Status HTTP que o PostgREST usa para cada SQLSTATE (https://docs.postgrest.org/en/stable/references/errors.html). */
export function statusForSqlState(code: string | undefined): number {
  if (!code) return 500;
  if (/^PT\d{3}$/.test(code)) return Number(code.slice(2));
  if (code === "42501") return 403;
  if (code === "23505" || code === "23503") return 409;
  if (code.startsWith("23") || code.startsWith("22") || code === "P0001") return 400;
  return 500;
}

/**
 * `fetch` que se comporta como o PostgREST do Supabase para as funções `lf_*`.
 * Papel: chave `sb_secret_...` no cabeçalho `apikey` => service_role; senão o claim `role` do JWT
 * (padrão `authenticated`); sem JWT => `anon`.
 */
export function postgrestFetch(db: PGlite): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const match = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (!match || init?.method !== "POST") return new Response("{}", { status: 404 });
    const fn = FUNCTIONS[match[1] as string];
    if (!fn) return json(404, { code: "PGRST202", message: "função desconhecida" });

    let role: Role = "anon";
    let claims: Claims = {};
    const apikey = headers.get("apikey") ?? "";
    const bearer = /^Bearer\s+(.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    if (apikey.startsWith(SERVICE_KEY_PREFIX)) {
      role = "service_role";
    } else if (bearer) {
      try {
        claims = decodeJwtPayload(bearer);
      } catch {
        return json(401, { code: "PGRST301", message: "JWT inválido" });
      }
      if (typeof claims.exp === "number" && claims.exp < Date.now() / 1000) {
        return json(401, { code: "PGRST303", message: "JWT expirado" });
      }
      role = claims.role === "service_role" ? "service_role" : "authenticated";
    }

    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const params = fn.args.map((_, i) => `${fn.args[i]} := $${i + 1}::${fn.casts[i]}`).join(", ");
    const values = fn.args.map((name) => {
      const v = body[name];
      return fn.casts[fn.args.indexOf(name)] === "jsonb" ? (v === undefined ? null : JSON.stringify(v)) : (v ?? null);
    });
    try {
      const rows = await withRole(db, role, claims, async (tx) => {
        const res = await tx.query<{ r: unknown }>(`select to_jsonb(public.${match[1]}(${params})) as r`, values);
        return res.rows;
      });
      const value = rows[0]?.r ?? null;
      return json(200, value);
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const status = role === "anon" && e.code === "42501" ? 401 : statusForSqlState(e.code);
      return json(status, { code: e.code ?? "XX000", message: e.message ?? "erro", details: null, hint: null });
    }
  }) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
