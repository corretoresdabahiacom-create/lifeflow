import { describe, expect, it } from "vitest";
import { DbClient, PreconditionFailedError, decodeFields, toColumn, toField } from "../src/db";
import { env } from "./helpers";

/** Confere o formato das chamadas ao PostgREST (`/rest/v1/rpc/lf_*`) que o Worker envia ao Supabase. */
function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, db: new DbClient(env, { accessToken: "tok", fetchImpl }) };
}

const ok = (body: unknown = null, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status });
const pg = (status: number, code: string) => new Response(JSON.stringify({ code, message: "x", details: null, hint: null }), { status });

describe("tradução de nomes", () => {
  it("camelCase <-> snake_case e uid <-> user_id", () => {
    expect(toColumn("initialBalanceCents")).toBe("initial_balance_cents");
    expect(toColumn("uid")).toBe("user_id");
    expect(toColumn("id")).toBe("id");
    expect(toField("created_at")).toBe("createdAt");
    expect(toField("user_id")).toBe("uid");
    for (const f of ["amountCents", "requestHash", "aiActionId", "recWeekdays", "quietHoursStart", "providerSubscriptionId", "conversationId"]) {
      expect(toField(toColumn(f))).toBe(f);
    }
  });

  it("decodeFields preserva texto, número, booleano e nulo; ignora estruturas", () => {
    expect(decodeFields({ created_at: "x", amount_cents: -5, archived: false, notes: null, junk: { a: 1 } })).toEqual({
      createdAt: "x",
      amountCents: -5,
      archived: false,
      notes: null,
    });
    expect(decodeFields(undefined)).toEqual({});
  });
});

describe("DbClient.commit", () => {
  it("envia p_ops em snake_case com merge, incremento e pré-condição", async () => {
    const { calls, db } = client(() => ok(null, 204));
    await db.commit([
      { path: "users/u1/transactions/t1", fields: { amountCents: 100, note: null, uid: "u1" }, precondition: { exists: false } },
      { path: "users/u1/accounts/a1", fields: { updatedAt: "x" }, merge: true, increments: { balanceCents: -100 }, precondition: { updateTime: "42" } },
      { path: "users/u1/tasks/k1", delete: true },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://lifeflow-test.supabase.co/rest/v1/rpc/lf_commit");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      p_ops: [
        { path: "users/u1/transactions/t1", fields: { amount_cents: 100, note: null, user_id: "u1" }, precondition: { exists: false } },
        { path: "users/u1/accounts/a1", fields: { updated_at: "x" }, merge: true, increments: { balance_cents: -100 }, precondition: { updateTime: "42" } },
        { path: "users/u1/tasks/k1", delete: true },
      ],
    });
  });

  it("409 PT409 vira PreconditionFailedError; outros 409/400 viram 403 (regras do banco)", async () => {
    await expect(client(() => pg(409, "PT409")).db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toBeInstanceOf(PreconditionFailedError);
    for (const [status, code] of [[409, "23503"], [409, "23505"], [400, "23514"], [400, "22023"], [403, "42501"], [403, "PT403"]] as const) {
      await expect(client(() => pg(status, code)).db.commit([{ path: "users/u1/a/b", fields: {} }]), `${status} ${code}`).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
  });

  it("não repete o commit em erro 500 nem em falha de rede", async () => {
    const failing = client(() => new Response("{}", { status: 500 }));
    await expect(failing.db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toMatchObject({ status: 502 });
    expect(failing.calls).toHaveLength(1);

    const calls: number[] = [];
    const db = new DbClient(env, {
      accessToken: "tok",
      fetchImpl: (async () => {
        calls.push(1);
        throw new TypeError("rede");
      }) as typeof fetch,
    });
    await expect(db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toMatchObject({ status: 504 });
    expect(calls).toHaveLength(1);
  });

  it("repassa o JWT do usuário em Authorization e a chave publicável em apikey (nunca a secreta)", async () => {
    const { calls, db } = client(() => ok(null, 204));
    await db.commit([{ path: "users/u1/a/b", fields: {} }]);
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("apikey")).toBe("sb_publishable_test");
  });

  it("o cliente privilegiado envia só a chave secreta em apikey, sem Authorization", async () => {
    const calls: Headers[] = [];
    const db = new DbClient(env, {
      accessToken: "",
      apiKey: "sb_secret_abc",
      privileged: true,
      fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Headers(init?.headers));
        return ok(null, 204);
      }) as typeof fetch,
    });
    await db.commit([{ path: "plans/pro", fields: { name: "Pro" } }]);
    expect(calls[0]?.get("apikey")).toBe("sb_secret_abc");
    expect(calls[0]?.get("Authorization")).toBeNull();
  });
});

describe("DbClient.query / get / count", () => {
  it("monta p_spec com filtros, ordem, limite e cursor em snake_case", async () => {
    const { calls, db } = client(() => ok([]));
    const docs = await db.query("users/u1", {
      collection: "transactions",
      filters: [
        { field: "date", op: "GREATER_THAN_OR_EQUAL", value: "2026-11-01" },
        { field: "accountId", op: "EQUAL", value: "a1" },
      ],
      orderBy: { field: "createdAt", direction: "DESCENDING" },
      limit: 50,
      after: { value: "2026-11-05", id: "abc" },
    });
    expect(docs).toEqual([]);
    expect(calls[0]?.url).toBe("https://lifeflow-test.supabase.co/rest/v1/rpc/lf_query");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      p_parent: "users/u1",
      p_collection: "transactions",
      p_spec: {
        filters: [
          { field: "date", op: "GREATER_THAN_OR_EQUAL", value: "2026-11-01" },
          { field: "account_id", op: "EQUAL", value: "a1" },
        ],
        limit: 50,
        orderBy: { field: "created_at", direction: "DESCENDING" },
        after: { value: "2026-11-05", id: "abc" },
      },
    });
  });

  it("decodifica documentos, id e versão (updateTime)", async () => {
    const { db } = client(() => ok([{ id: "a9", path: "users/u1/accounts/a9", version: "7", data: { balance_cents: -250, name: "X", user_id: "u1" } }]));
    const docs = await db.query("users/u1", { collection: "accounts", limit: 10 });
    expect(docs).toEqual([{ id: "a9", path: "users/u1/accounts/a9", data: { balanceCents: -250, name: "X", uid: "u1" }, updateTime: "7" }]);
  });

  it("getDoc devolve dados e versão; documento ausente (null) vira null; leitura repete 1 vez em 503", async () => {
    const seq = [new Response("{}", { status: 503 }), ok({ data: { created_at: "t" }, version: "3" })];
    const { calls, db } = client(() => seq.shift() as Response);
    expect(await db.getDoc("users/u1")).toEqual({ data: { createdAt: "t" }, updateTime: "3" });
    expect(calls).toHaveLength(2);
    expect(await client(() => ok(null)).db.get("users/u1")).toBeNull();
  });

  it("count e erasure", async () => {
    const count = client(() => ok(12));
    expect(await count.db.count("users", [{ field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: "2026" }])).toBe(12);
    expect(JSON.parse(String(count.calls[0]?.init.body))).toEqual({ p_collection: "users", p_filters: [{ field: "created_at", op: "GREATER_THAN_OR_EQUAL", value: "2026" }] });
    expect(await client(() => ok(25)).db.eraseUser("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(25);
  });

  it("401 vira 401 com invalid_token; 429 vira 429; 5xx vira 502", async () => {
    await expect(client(() => pg(401, "PGRST301")).db.get("users/u1")).rejects.toMatchObject({ status: 401, headers: { "WWW-Authenticate": expect.stringContaining("invalid_token") } });
    await expect(client(() => new Response("{}", { status: 429 })).db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toMatchObject({ status: 429 });
    await expect(client(() => new Response("{}", { status: 500 })).db.count("users")).rejects.toMatchObject({ status: 502 });
  });
});
