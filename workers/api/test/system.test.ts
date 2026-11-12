import { exportPKCS8, generateKeyPair, jwtVerify, importSPKI, exportSPKI } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/errors";
import { clearServiceAccountTokenCache, createSystemDb, parseServiceAccount, serviceAccountToken } from "../src/system";
import { env } from "./helpers";

async function account() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const raw = JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey), token_uri: "https://oauth.test/token" });
  return { raw, publicPem: await exportSPKI(publicKey) };
}

describe("conta de serviço (caminho privilegiado)", () => {
  beforeEach(() => clearServiceAccountTokenCache());

  it("troca um JWT assinado (RS256, escopo datastore) por token de acesso e o reaproveita em cache", async () => {
    const { raw, publicPem } = await account();
    let assertion = "";
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), { status: 200 });
    });
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(await serviceAccountToken(raw, fetchImpl as unknown as typeof fetch, now)).toBe("ya29.fake");
    const { payload } = await jwtVerify(assertion, await importSPKI(publicPem, "RS256"), { audience: "https://oauth.test/token", currentDate: new Date(now) });
    expect(payload).toMatchObject({ iss: "sa@proj.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/datastore" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://oauth.test/token");
    expect(new URLSearchParams(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    await serviceAccountToken(raw, fetchImpl as unknown as typeof fetch, now + 10 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await serviceAccountToken(raw, fetchImpl as unknown as typeof fetch, now + 3600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("credencial inválida ou falha no endpoint viram erros HTTP claros (sem vazar a chave)", async () => {
    const { raw } = await account();
    expect(() => parseServiceAccount("não json")).toThrow(HttpError);
    expect(() => parseServiceAccount("{}")).toThrow(HttpError);
    const bad = JSON.stringify({ client_email: "a@b", private_key: "lixo" });
    await expect(serviceAccountToken(bad, fetch)).rejects.toMatchObject({ status: 503 });
    await expect(serviceAccountToken(raw, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 });
    await expect(serviceAccountToken(raw, (async () => { throw new Error("rede"); }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 });
    await expect(serviceAccountToken(raw, (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 });
  });

  it("sem emulador e sem credencial, o caminho privilegiado fica indisponível (503 billing_not_configured)", async () => {
    const { FIRESTORE_BASE_URL: _drop, ...bare } = env;
    await expect(createSystemDb(bare)).rejects.toMatchObject({ status: 503, code: "billing_not_configured" });
  });

  it("em produção usa o token da conta de serviço contra o Firestore real", async () => {
    const { raw } = await account();
    const { FIRESTORE_BASE_URL: _drop, ...bare } = env;
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://oauth.test/token") return new Response(JSON.stringify({ access_token: "ya29.prod", expires_in: 3600 }));
      seen.push(String((init.headers as Record<string, string>)["Authorization"] ?? new Headers(init.headers).get("Authorization")));
      return new Response(JSON.stringify({ name: "x", fields: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const sys = await createSystemDb({ ...bare, GOOGLE_SERVICE_ACCOUNT_JSON: raw }, fetchImpl);
    await sys.get("plans/pro");
    expect(seen).toEqual(["Bearer ya29.prod"]);
  });
});
