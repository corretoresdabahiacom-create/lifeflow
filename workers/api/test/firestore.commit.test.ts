import { describe, expect, it } from "vitest";
import { FirestoreClient, PreconditionFailedError } from "../src/firestore";
import { env } from "./helpers";

/** Confere o formato das chamadas REST (documents:commit e runQuery) que o Worker envia ao Firestore. */
function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, db: new FirestoreClient(env, { idToken: "tok", fetchImpl }) };
}

describe("FirestoreClient.commit", () => {
  it("monta writes com nome do recurso, máscara, incremento e pré-condição", async () => {
    const { calls, db } = client(() => new Response("{}", { status: 200 }));
    await db.commit([
      { path: "users/u1/transactions/t1", fields: { amountCents: 100, note: null }, precondition: { exists: false } },
      {
        path: "users/u1/accounts/a1",
        fields: { updatedAt: "x" },
        merge: true,
        increments: { balanceCents: -100 },
        precondition: { updateTime: "2026-01-01T00:00:00Z" },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://firestore.test/v1/projects/demo-lifeflow/databases/(default)/documents:commit");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init.body)) as { writes: Array<Record<string, unknown>> };
    const base = "projects/demo-lifeflow/databases/(default)/documents";
    expect(body.writes[0]).toEqual({
      update: { name: `${base}/users/u1/transactions/t1`, fields: { amountCents: { integerValue: "100" }, note: { nullValue: null } } },
      currentDocument: { exists: false },
    });
    expect(body.writes[1]).toEqual({
      update: { name: `${base}/users/u1/accounts/a1`, fields: { updatedAt: { stringValue: "x" } } },
      updateMask: { fieldPaths: ["updatedAt"] },
      updateTransforms: [{ fieldPath: "balanceCents", increment: { integerValue: "-100" } }],
      currentDocument: { updateTime: "2026-01-01T00:00:00Z" },
    });
  });

  it.each([
    [409, "ALREADY_EXISTS"],
    [404, "NOT_FOUND"],
    [400, "FAILED_PRECONDITION"],
  ])("HTTP %i %s vira PreconditionFailedError", async (status, code) => {
    const { db } = client(() => new Response(JSON.stringify({ error: { status: code } }), { status }));
    await expect(db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it("não repete o commit em erro 500 nem em falha de rede", async () => {
    const failing = client(() => new Response("{}", { status: 500 }));
    await expect(failing.db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toMatchObject({ status: 502 });
    expect(failing.calls).toHaveLength(1);

    const calls: number[] = [];
    const db = new FirestoreClient(env, {
      idToken: "tok",
      fetchImpl: (async () => {
        calls.push(1);
        throw new TypeError("rede");
      }) as typeof fetch,
    });
    await expect(db.commit([{ path: "users/u1/a/b", fields: {} }])).rejects.toMatchObject({ status: 504 });
    expect(calls).toHaveLength(1);
  });

  it("repassa o token do usuário (nunca credencial de serviço)", async () => {
    const { calls, db } = client(() => new Response("{}", { status: 200 }));
    await db.commit([{ path: "users/u1/a/b", fields: {} }]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer tok");
  });
});

describe("FirestoreClient.query", () => {
  it("monta structuredQuery com filtros, ordem, limite e cursor", async () => {
    const { calls, db } = client(() => new Response(JSON.stringify([{ readTime: "t" }]), { status: 200 }));
    const docs = await db.query("users/u1", {
      collection: "transactions",
      filters: [
        { field: "date", op: "GREATER_THAN_OR_EQUAL", value: "2026-11-01" },
        { field: "date", op: "LESS_THAN_OR_EQUAL", value: "2026-11-30" },
      ],
      orderBy: { field: "date", direction: "DESCENDING" },
      limit: 50,
      after: { value: "2026-11-05", id: "abc" },
    });
    expect(docs).toEqual([]);
    expect(calls[0]?.url).toBe("https://firestore.test/v1/projects/demo-lifeflow/databases/(default)/documents/users/u1:runQuery");
    const { structuredQuery } = JSON.parse(String(calls[0]?.init.body)) as { structuredQuery: Record<string, unknown> };
    const base = "projects/demo-lifeflow/databases/(default)/documents/users/u1/transactions/abc";
    expect(structuredQuery).toEqual({
      from: [{ collectionId: "transactions" }],
      limit: 50,
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: "2026-11-01" } } },
            { fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: "2026-11-30" } } },
          ],
        },
      },
      orderBy: [
        { field: { fieldPath: "date" }, direction: "DESCENDING" },
        { field: { fieldPath: "__name__" }, direction: "DESCENDING" },
      ],
      startAt: { values: [{ stringValue: "2026-11-05" }, { referenceValue: base }], before: false },
    });
  });

  it("decodifica documentos e id", async () => {
    const { db } = client(
      () =>
        new Response(
          JSON.stringify([
            {
              document: {
                name: "projects/p/databases/(default)/documents/users/u1/accounts/a9",
                fields: { balanceCents: { integerValue: "-250" }, name: { stringValue: "X" } },
                updateTime: "2026-01-01T00:00:00Z",
              },
            },
          ]),
          { status: 200 },
        ),
    );
    const docs = await db.query("users/u1", { collection: "accounts", limit: 10 });
    expect(docs).toEqual([{ id: "a9", data: { balanceCents: -250, name: "X" }, updateTime: "2026-01-01T00:00:00Z" }]);
  });
});
