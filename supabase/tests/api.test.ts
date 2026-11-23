import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, resetDatabase } from "../harness";
import { A, B, T0, account, commit, get, now, rpc, seedUsers } from "./helpers";

let db: PGlite;
beforeAll(async () => {
  db = await createDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDatabase(db);
  await seedUsers(db);
});

const acc = (id: string) => `users/${A}/accounts/${id}`;

describe("lf_commit / lf_get", () => {
  it("cria, lê e devolve os campos em snake_case com a versão", async () => {
    expect((await commit(db, A, [{ path: acc("a1"), fields: account(A), precondition: { exists: false } }])).ok).toBe(true);
    const doc = (await get(db, A, acc("a1"))).value;
    expect(doc?.version).toBe("1");
    expect(doc?.data).toMatchObject({ user_id: A, name: "Conta", balance_cents: 1000, archived: false });
    expect(doc?.data).not.toHaveProperty("version");
    expect(doc?.data).not.toHaveProperty("id");
  });

  it("documento inexistente devolve null", async () => {
    expect((await get(db, A, acc("nada"))).value).toBeNull();
  });

  it("exists:false falha (PT409) se já existe, e nada é gravado (atomicidade)", async () => {
    await commit(db, A, [{ path: acc("a1"), fields: account(A), precondition: { exists: false } }]);
    const r = await commit(db, A, [
      { path: acc("a2"), fields: account(A), precondition: { exists: false } },
      { path: acc("a1"), fields: account(A), precondition: { exists: false } },
    ]);
    expect(r).toMatchObject({ ok: false, code: "PT409" });
    expect((await get(db, A, acc("a2"))).value).toBeNull();
  });

  it("exists:true falha se não existe", async () => {
    const r = await commit(db, A, [{ path: acc("x"), fields: { name: "Z" }, merge: true, precondition: { exists: true } }]);
    expect(r).toMatchObject({ ok: false, code: "PT409" });
  });

  it("merge altera só os campos informados; incremento é atômico e soma ao valor atual", async () => {
    await commit(db, A, [{ path: acc("a1"), fields: account(A), precondition: { exists: false } }]);
    await commit(db, A, [{ path: acc("a1"), fields: { updated_at: now(5) }, increments: { balance_cents: -250 }, precondition: { exists: true } }]);
    await commit(db, A, [{ path: acc("a1"), fields: { updated_at: now(6) }, increments: { balance_cents: -250 } }]);
    const doc = (await get(db, A, acc("a1"))).value;
    expect(doc?.data).toMatchObject({ balance_cents: 500, name: "Conta", updated_at: now(6) });
    expect(doc?.version).toBe("3");
  });

  it("updateTime protege contra escrita concorrente", async () => {
    await commit(db, A, [{ path: acc("a1"), fields: account(A), precondition: { exists: false } }]);
    const v = (await get(db, A, acc("a1"))).value?.version as string;
    expect((await commit(db, A, [{ path: acc("a1"), fields: { name: "Nova" }, merge: true, precondition: { updateTime: v } }])).ok).toBe(true);
    expect(await commit(db, A, [{ path: acc("a1"), fields: { name: "Velha" }, merge: true, precondition: { updateTime: v } }])).toMatchObject({ ok: false, code: "PT409" });
  });

  it("incremento em documento ausente cria com o valor do incremento (contadores de uso da IA)", async () => {
    const path = `users/${A}/aiUsage/2026-11`;
    await commit(db, A, [{ path, fields: { updated_at: T0 }, increments: { messages: 1, input_tokens: 40 } }]);
    await commit(db, A, [{ path, fields: { updated_at: now(1) }, increments: { messages: 1, voice_seconds: 9 } }]);
    expect((await get(db, A, path)).value?.data).toMatchObject({ messages: 2, input_tokens: 40, voice_seconds: 9, output_tokens: 0 });
  });

  it("campo desconhecido, uid divergente e caminho inválido são rejeitados", async () => {
    expect(await commit(db, A, [{ path: acc("a1"), fields: { ...account(A), hack: 1 } }])).toMatchObject({ ok: false, code: "22023" });
    expect(await commit(db, A, [{ path: acc("a1"), fields: account(B) }])).toMatchObject({ ok: false, code: "PT403" });
    expect(await commit(db, A, [{ path: `users/${A}/segredos/x`, fields: {} }])).toMatchObject({ ok: false, code: "22023" });
    expect(await commit(db, A, [{ path: "users/nao-e-uuid", fields: {} }])).toMatchObject({ ok: false, code: "22023" });
    expect(await commit(db, A, [{ path: acc("a1"), fields: { ...account(A), present_fields: ["x"] } }])).toMatchObject({ ok: false, code: "22023" });
  });

  it("não escreve no espaço de outro usuário (RLS) nem lê dele", async () => {
    expect((await commit(db, B, [{ path: acc("a1"), fields: account(A) }])).ok).toBe(false);
    await commit(db, A, [{ path: acc("a1"), fields: account(A), precondition: { exists: false } }]);
    expect((await get(db, B, acc("a1"))).value).toBeNull();
    expect((await commit(db, B, [{ path: acc("a1"), fields: { name: "X" }, merge: true, precondition: { exists: true } }]))).toMatchObject({ ok: false, code: "PT409" });
  });

  it("exclui; com pré-condição falha se não existe", async () => {
    const path = `users/${A}/tasks/t1`;
    await commit(db, A, [{ path, fields: { title: "T", priority: "low", status: "pending", created_at: T0, updated_at: T0, request_hash: "h" } }]);
    expect((await commit(db, A, [{ path, delete: true, precondition: { exists: true } }])).ok).toBe(true);
    expect(await commit(db, A, [{ path, delete: true, precondition: { exists: true } }])).toMatchObject({ ok: false, code: "PT409" });
    expect((await commit(db, A, [{ path, delete: true }])).ok).toBe(true);
  });

  it("mensagens usam a conversa do caminho", async () => {
    await commit(db, A, [{ path: `users/${A}/aiConversations/c1`, fields: { title: "Oi", created_at: T0, updated_at: T0 } }]);
    const mp = `users/${A}/aiConversations/c1/messages/m1`;
    expect((await commit(db, A, [{ path: mp, fields: { conversation_id: "c1", role: "user", content: "olá", created_at: T0 } }])).ok).toBe(true);
    expect(await commit(db, A, [{ path: `users/${A}/aiConversations/c1/messages/m2`, fields: { conversation_id: "outra", role: "user", content: "x", created_at: T0 } }])).toMatchObject({ ok: false, code: "PT403" });
    expect((await get(db, A, mp)).value?.data).toMatchObject({ conversation_id: "c1", content: "olá" });
  });

  it("exceções de evento são esparsas: ausente herda, presente (mesmo nulo) sobrescreve", async () => {
    const p = `users/${A}/eventExceptions/e1`;
    const base = { series_id: "s1", original_date: "2026-11-10", canceled: false, created_at: T0, updated_at: T0 };
    await commit(db, A, [{ path: p, fields: { ...base, title: "Novo", location: null } }]);
    const data = (await get(db, A, p)).value?.data as Record<string, unknown>;
    expect(data).toMatchObject({ title: "Novo", location: null, series_id: "s1" });
    expect(data).not.toHaveProperty("start_time");
    expect(data).not.toHaveProperty("present_fields");
    await commit(db, A, [{ path: p, fields: { start_time: "09:30", updated_at: now(1) }, merge: true }]);
    const merged = (await get(db, A, p)).value?.data as Record<string, unknown>;
    expect(merged).toMatchObject({ title: "Novo", location: null, start_time: "09:30" });
    expect(merged).not.toHaveProperty("notes");
  });

  it("substituição integral devolve ao padrão as colunas não informadas (plano)", async () => {
    await commit(db, "service", [{ path: "plans/pro", fields: { name: "Pro", price_cents: 1490, active: true } }]);
    await commit(db, "service", [{ path: "plans/pro", fields: { name: "Pro 2" } }]);
    expect((await get(db, "service", "plans/pro")).value?.data).toMatchObject({ name: "Pro 2", price_cents: null, active: null });
  });
});

describe("lf_query / lf_count", () => {
  const tx = (id: string, date: string, over: Record<string, unknown> = {}) => ({
    path: `users/${A}/transactions/${id}`,
    fields: {
      account_id: "a1", type: "income", amount_cents: 100, signed_cents: 100, date, category_id: null,
      description: id, notes: null, status: "posted", transfer_id: null, payable_id: null,
      created_at: T0, updated_at: T0, voided_at: null, request_hash: "h", ...over,
    },
  });

  beforeEach(async () => {
    await commit(db, A, [{ path: acc("a1"), fields: account(A) }]);
    await commit(db, A, [tx("t1", "2026-11-01"), tx("t2", "2026-11-05"), tx("t3", "2026-11-05"), tx("t4", "2026-11-09")]);
  });

  const q = (spec: Record<string, unknown>, parent = `users/${A}`, coll = "transactions") =>
    rpc<Array<{ id: string; path: string; data: Record<string, unknown> }>>(db, A, "lf_query", [parent, coll, spec]).then((r) => r.value ?? []);

  it("ordena por id por padrão e devolve o caminho completo", async () => {
    const rows = await q({ limit: 10 });
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(rows[0]?.path).toBe(`users/${A}/transactions/t1`);
  });

  it("filtros de faixa, ordem decrescente e cursor", async () => {
    const f = [{ field: "date", op: "GREATER_THAN_OR_EQUAL", value: "2026-11-05" }];
    expect((await q({ filters: f, limit: 10 })).map((r) => r.id)).toEqual(["t2", "t3", "t4"]);
    const desc = await q({ filters: f, orderBy: { field: "date", direction: "DESCENDING" }, limit: 2 });
    expect(desc.map((r) => r.id)).toEqual(["t4", "t3"]);
    const next = await q({ filters: f, orderBy: { field: "date", direction: "DESCENDING" }, limit: 2, after: { value: "2026-11-05", id: "t3" } });
    expect(next.map((r) => r.id)).toEqual(["t2"]);
    const asc = await q({ orderBy: { field: "date", direction: "ASCENDING" }, limit: 2, after: { value: "2026-11-01", id: "t1" } });
    expect(asc.map((r) => r.id)).toEqual(["t2", "t3"]);
  });

  it("nulos vêm primeiro na ordem crescente e o cursor atravessa nulos", async () => {
    await commit(db, A, [tx("t5", "2026-11-09", { category_id: "c1" })]);
    const all = await q({ orderBy: { field: "category_id", direction: "ASCENDING" }, limit: 10 });
    expect(all.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    const rest = await q({ orderBy: { field: "category_id", direction: "ASCENDING" }, limit: 10, after: { value: null, id: "t2" } });
    expect(rest.map((r) => r.id)).toEqual(["t3", "t4", "t5"]);
  });

  it("limite, parent de outro usuário e coluna desconhecida", async () => {
    expect(await q({ limit: 2 })).toHaveLength(2);
    expect(await q({ limit: 10 }, `users/${B}`)).toHaveLength(0);
    expect((await rpc(db, A, "lf_query", [`users/${A}`, "transactions", { filters: [{ field: "x; drop table accounts", op: "EQUAL", value: 1 }] }]))).toMatchObject({ ok: false, code: "22023" });
    expect((await rpc(db, A, "lf_query", [`users/${A}`, "transactions", { orderBy: { field: "nope" } }]))).toMatchObject({ ok: false, code: "22023" });
  });

  it("consulta de grupo (service_role) agrega todos os usuários; o usuário só enxerga os próprios", async () => {
    await commit(db, B, [{ path: `users/${B}/aiUsage/2026-11`, fields: { updated_at: T0 }, increments: { messages: 5 } }]);
    await commit(db, A, [{ path: `users/${A}/aiUsage/2026-11`, fields: { updated_at: T0 }, increments: { messages: 2 } }]);
    const spec = { group: true, limit: 100, filters: [{ field: "updated_at", op: "GREATER_THAN_OR_EQUAL", value: "2026-11-01" }] };
    const all = (await rpc<Array<{ path: string }>>(db, "service", "lf_query", ["", "aiUsage", spec])).value ?? [];
    expect(all.map((r) => r.path).sort()).toEqual([`users/${A}/aiUsage/2026-11`, `users/${B}/aiUsage/2026-11`].sort());
    const mine = (await rpc<Array<{ path: string }>>(db, A, "lf_query", ["", "aiUsage", spec])).value ?? [];
    expect(mine.map((r) => r.path)).toEqual([`users/${A}/aiUsage/2026-11`]);
  });

  it("lf_count conta com filtros; coleção raiz", async () => {
    expect((await rpc<number>(db, "service", "lf_count", ["users", []])).value).toBe(0);
    await commit(db, A, [{ path: `users/${A}`, fields: { display_name: "Ana", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL", created_at: T0, updated_at: T0 } }]);
    expect((await rpc<number>(db, "service", "lf_count", ["users", []])).value).toBe(1);
  });
});

describe("lf_erase_user", () => {
  it("apaga TUDO do usuário em cascata e devolve a contagem; só o service_role executa; idempotente", async () => {
    await commit(db, A, [
      { path: `users/${A}`, fields: { display_name: "Ana", locale: "pt-BR", timezone: "America/Sao_Paulo", currency: "BRL", created_at: T0, updated_at: T0 } },
      { path: acc("a1"), fields: account(A) },
      { path: `users/${A}/aiConversations/c1`, fields: { title: "Oi", created_at: T0, updated_at: T0 } },
      { path: `users/${A}/aiConversations/c1/messages/m1`, fields: { conversation_id: "c1", role: "user", content: "oi", created_at: T0 } },
    ]);
    await commit(db, B, [{ path: `users/${B}/accounts/b1`, fields: account(B) }]);
    await commit(db, "service", [{ path: `subscriptions/${A}`, fields: { plan_id: "pro", status: "active" } }]);
    expect((await rpc(db, A, "lf_erase_user", [A])).ok).toBe(false); // o próprio usuário NÃO executa
    expect((await rpc(db, null, "lf_erase_user", [A])).ok).toBe(false);
    const done = await rpc<number>(db, "service", "lf_erase_user", [A]);
    expect(done.value).toBe(6); // perfil, conta, conversa, mensagem, assinatura + o usuário
    expect((await db.query("select count(*)::int n from accounts where user_id = $1", [A])).rows[0]).toEqual({ n: 0 });
    expect((await db.query("select count(*)::int n from accounts where user_id = $1", [B])).rows[0]).toEqual({ n: 1 });
    expect((await rpc<number>(db, "service", "lf_erase_user", [A])).value).toBe(0);
  });
});

describe("leitura de id de usuário malformado", () => {
  it("lf_get devolve null (não encontrado) para um id que não é UUID; escrita continua recusada", async () => {
    const r = await rpc(db, "service", "lf_get", ["subscriptions/nao-e-uuid"]);
    expect(r).toMatchObject({ ok: true, value: null });
    const w = await rpc(db, "service", "lf_commit", [[{ path: "subscriptions/nao-e-uuid", fields: { plan_id: "pro" } }]]);
    expect(w.ok).toBe(false);
  });
});
