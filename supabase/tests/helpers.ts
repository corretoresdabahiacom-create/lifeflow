import type { PGlite } from "@electric-sql/pglite";
import { createAuthUser, withRole } from "../harness";

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const T0 = "2026-11-09T12:00:00.000Z";

export async function seedUsers(db: PGlite): Promise<void> {
  await createAuthUser(db, A);
  await createAuthUser(db, B);
}

export interface Op {
  path: string;
  fields?: Record<string, unknown>;
  merge?: boolean;
  increments?: Record<string, number>;
  precondition?: { exists: boolean } | { updateTime: string };
  delete?: boolean;
}

export interface Outcome<T = unknown> {
  ok: boolean;
  value?: T;
  code?: string;
  message?: string;
}

/** Chama uma função `lf_*` como o usuário `uid` (ou como service_role quando `uid` é "service"). */
export async function rpc<T = unknown>(db: PGlite, uid: string | "service" | null, fn: string, args: unknown[]): Promise<Outcome<T>> {
  const role = uid === "service" ? "service_role" : uid === null ? "anon" : "authenticated";
  const claims = uid && uid !== "service" ? { sub: uid } : {};
  const names: Record<string, string[]> = {
    lf_get: ["p_path"],
    lf_commit: ["p_ops"],
    lf_query: ["p_parent", "p_collection", "p_spec"],
    lf_count: ["p_collection", "p_filters"],
    lf_erase_user: ["p_uid"],
  };
  const casts: Record<string, string[]> = {
    lf_get: ["text"],
    lf_commit: ["jsonb"],
    lf_query: ["text", "text", "jsonb"],
    lf_count: ["text", "jsonb"],
    lf_erase_user: ["uuid"],
  };
  const list = names[fn] as string[];
  const types = casts[fn] as string[];
  const params = list.map((n, i) => `${n} := $${i + 1}::${types[i]}`).join(", ");
  const values = args.map((a, i) => (types[i] === "jsonb" ? JSON.stringify(a) : a));
  try {
    const rows = await withRole(db, role, claims, async (tx) => (await tx.query<{ r: T }>(`select to_jsonb(public.${fn}(${params})) as r`, values)).rows);
    return { ok: true, value: rows[0]?.r as T };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { ok: false, ...(e.code ? { code: e.code } : {}), ...(e.message ? { message: e.message } : {}) };
  }
}

export const commit = (db: PGlite, uid: string | "service", ops: Op[]) => rpc(db, uid, "lf_commit", [ops]);
export const get = <T = { data: Record<string, unknown>; version: string } | null>(db: PGlite, uid: string | "service", path: string) =>
  rpc<T>(db, uid, "lf_get", [path]);

export const now = (n = 0): string => new Date(Date.parse(T0) + n * 1000).toISOString();

export const account = (uid: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  user_id: uid,
  name: "Conta",
  type: "checking",
  initial_balance_cents: 1000,
  balance_cents: 1000,
  archived: false,
  created_at: T0,
  updated_at: T0,
  request_hash: "h1",
  ...over,
});
