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
});
