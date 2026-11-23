import { describe, expect, it, vi } from "vitest";
import { DbClient } from "../src/db";
import { SystemAccessError, SystemDb, UserErasure, createSystemDb, createUserErasure } from "../src/system";
import { env } from "./helpers";

const UID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function recording() {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(String(input).endsWith("lf_count") || String(input).endsWith("lf_erase_user") ? "7" : String(input).endsWith("lf_query") ? "[]" : "null", { status: 200 });
  }) as unknown as typeof fetch;
  const db = new DbClient(env, { accessToken: "", apiKey: "sb_secret_t", privileged: true, fetchImpl });
  return { calls, db, fetchImpl };
}

describe("chave secreta (caminho privilegiado restrito)", () => {
  it("sem SUPABASE_SECRET_KEY o caminho privilegiado fica indisponível (503 billing_not_configured)", async () => {
    const { SUPABASE_SECRET_KEY: _drop, ...bare } = env;
    await expect(createSystemDb(bare)).rejects.toMatchObject({ status: 503, code: "billing_not_configured" });
    await expect(createUserErasure(bare, fetch, UID)).rejects.toMatchObject({ status: 503 });
  });

  it("com a chave, as chamadas levam só `apikey: sb_secret_…` (sem Authorization de usuário)", async () => {
    const calls: Headers[] = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return new Response("null", { status: 200 });
    }) as typeof fetch;
    const sys = await createSystemDb({ ...env, SUPABASE_SECRET_KEY: "sb_secret_prod" }, fetchImpl);
    await sys.get("plans/pro");
    expect(calls[0]?.get("apikey")).toBe("sb_secret_prod");
    expect(calls[0]?.get("Authorization")).toBeNull();
  });
});

describe("SystemDb: lista fechada de caminhos", () => {
  it("permite plans/subscriptions/webhookEvents/adminLogs e billingPayments de um usuário", async () => {
    const { db, calls } = recording();
    const sys = new SystemDb(db);
    await sys.get("plans/pro");
    await sys.commit([{ path: "subscriptions/x", fields: { status: "active" }, merge: true }, { path: `users/${UID}/billingPayments/p1`, fields: {} }]);
    await sys.query("", { collection: "subscriptions", limit: 10 });
    await sys.query(`users/${UID}`, { collection: "billingPayments", limit: 10 });
    await sys.group({ collection: "aiUsage", limit: 10 });
    expect(await sys.count("users")).toBe(7);
    expect(calls.length).toBeGreaterThan(4);
  });

  it("NEGA conteúdo pessoal (finanças, agenda, conversas) e coleções fora da lista, sem chamar o banco", async () => {
    const { db, fetchImpl } = recording();
    const sys = new SystemDb(db);
    expect(() => sys.get(`users/${UID}/accounts/a1`)).toThrow(SystemAccessError);
    expect(() => sys.get(`users/${UID}`)).toThrow(SystemAccessError);
    expect(() => sys.commit([{ path: `users/${UID}/transactions/t1`, delete: true }])).toThrow(SystemAccessError);
    expect(() => sys.query(`users/${UID}`, { collection: "transactions", limit: 5 })).toThrow(SystemAccessError);
    expect(() => sys.query("", { collection: "users", limit: 5 })).toThrow(SystemAccessError);
    expect(() => sys.group({ collection: "transactions", limit: 5 })).toThrow(SystemAccessError);
    expect(() => sys.count("transactions")).toThrow(SystemAccessError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("UserErasure", () => {
  it("só aceita uid no formato UUID e chama lf_erase_user uma vez", async () => {
    const { db, calls } = recording();
    for (const bad of ["", "../x", "a/b", "userA", `${UID}/accounts`]) expect(() => new UserErasure(db, bad), bad).toThrow(SystemAccessError);
    expect(await new UserErasure(db, UID).eraseAll()).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://lifeflow-test.supabase.co/rest/v1/rpc/lf_erase_user");
    expect(calls[0]?.body).toEqual({ p_uid: UID });
  });
});
