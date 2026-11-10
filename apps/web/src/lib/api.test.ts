import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./api";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createApiClient", () => {
  it("envia o token no cabeçalho Authorization", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ uid: "userA" }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "tok-1", fetchImpl });
    await api.me();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/me");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok-1");
  });

  it("em 401 pede renovação da sessão ao SDK e repete uma única vez", async () => {
    const getToken = vi.fn(async (force: boolean) => (force ? "novo" : "velho"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unauthorized" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ uid: "userA" }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken, fetchImpl });
    await expect(api.me()).resolves.toEqual({ uid: "userA" });
    expect(getToken.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("não entra em laço quando o 401 persiste", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: "unauthorized", message: "x" } }, 401));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("getProfile devolve null em 404", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: "not_found" } }, 404));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await expect(api.getProfile()).resolves.toBeNull();
  });

  it("converte erros em ApiError com código e requestId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "forbidden", message: "Acesso negado", requestId: "r-1" } }, 403),
    );
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    const error = await api.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", requestId: "r-1", message: "Acesso negado" });
  });

  it("PUT envia JSON e DELETE 204 resolve sem corpo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await api.putProfile({ displayName: "Ana", locale: "pt-BR", timezone: "UTC", currency: "BRL" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    await expect(api.deletePreferences()).resolves.toBeUndefined();
  });

  it("criações enviam POST com Idempotency-Key e o corpo em JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "t1" }, 201));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await api.createTransaction({ accountId: "a1", type: "expense", amountCents: 1000, date: "2026-11-09", description: "x" }, "web-key-123456");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/transactions");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Idempotency-Key")).toBe("web-key-123456");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toMatchObject({ amountCents: 1000 });
  });

  it("repetir após 401 reenvia a mesma Idempotency-Key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "unauthorized" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ id: "t1" }, 201));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await api.createAccount({ name: "X", type: "cash", initialBalanceCents: 0 }, "web-key-abcdef");
    const keys = fetchImpl.mock.calls.map((c) => new Headers((c as unknown as [string, RequestInit])[1].headers).get("Idempotency-Key"));
    expect(keys).toEqual(["web-key-abcdef", "web-key-abcdef"]);
  });

  it("filtros vazios não entram na URL e valores são codificados", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], nextCursor: null, from: "", to: "" }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await api.listTransactions({ from: "2026-11-01", to: "2026-11-30", accountId: "", cursor: null, limit: 50 });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/transactions?from=2026-11-01&to=2026-11-30&limit=50");
  });

  it("PATCH e estorno usam o método correto", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "x" }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "t", fetchImpl });
    await api.patchAccount("a1", { archived: true });
    await api.voidTransaction("t1");
    const calls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect([calls[0]?.[0], calls[0]?.[1].method]).toEqual(["https://api.test/v1/accounts/a1", "PATCH"]);
    expect([calls[1]?.[0], calls[1]?.[1].method]).toEqual(["https://api.test/v1/transactions/t1/void", "POST"]);
  });

  it("exportação envia o token no cabeçalho, nunca na URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("a,b", { status: 200, headers: { "Content-Type": "text/csv" } }));
    const api = createApiClient({ baseUrl: "https://api.test", getToken: async () => "segredo-123", fetchImpl });
    const blob = await api.exportCsv("2026-11-01", "2026-11-30");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("segredo");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer segredo-123");
    expect(await blob.text()).toBe("a,b");
  });
});
