import { SignJWT, base64url } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ORIGIN,
  PROJECT_ID,
  fakeFirestore,
  makeApp,
  makeSigner,
  putJson,
  signToken,
  validPrefs,
  validProfile,
  type Signer,
} from "./helpers";

let signer: Signer;
let attacker: Signer;

beforeAll(async () => {
  signer = await makeSigner("k1");
  attacker = await makeSigner("k1"); // mesmo kid, chave diferente
});

afterEach(() => {
  vi.restoreAllMocks();
});

const setup = (initial = {}) => {
  const fs = fakeFirestore(initial);
  return { fs, call: makeApp(signer, fs.fetchImpl) };
};

describe("autenticação: ausência e invalidez do token", () => {
  it("sem token: 401 e o Firestore nunca é chamado", async () => {
    const { fs, call } = setup();
    const res = await call("/v1/profile");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(fs.calls).toHaveLength(0);
  });

  it("cabeçalho Authorization malformado: 401", async () => {
    const { fs, call } = setup();
    const res = await call("/v1/profile", { headers: { Authorization: "Basic abc" } });
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("texto aleatório como JWT: 401", async () => {
    const { fs, call } = setup();
    const res = await call("/v1/profile", {}, "isto.nao.e-um-jwt");
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("assinatura de outra chave: 401", async () => {
    const { fs, call } = setup();
    const forged = await signToken(attacker, { uid: "userB" });
    const res = await call("/v1/profile", {}, forged);
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("token expirado: 401 com invalid_token", async () => {
    const { fs, call } = setup();
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = await signToken(signer, { uid: "userA", issuedAt: past - 60, expiresAt: past });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
    expect(fs.calls).toHaveLength(0);
  });

  it("audiência errada: 401", async () => {
    const { fs, call } = setup();
    const token = await signToken(signer, { uid: "userA", audience: "outro-projeto" });
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("emissor errado: 401", async () => {
    const { fs, call } = setup();
    const token = await signToken(signer, { uid: "userA", issuer: "https://securetoken.google.com/outro" });
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("token sem sub: 401", async () => {
    const { fs, call } = setup();
    const token = await signToken(signer, {});
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("algoritmo HS256 (confusão de algoritmo): 401", async () => {
    const { fs, call } = setup();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject("userB")
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("segredo-qualquer-segredo-qualquer-123"));
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it('algoritmo "none": 401', async () => {
    const { fs, call } = setup();
    const header = base64url.encode(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = base64url.encode(
      JSON.stringify({
        sub: "userB",
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect((await call("/v1/profile", {}, `${header}.${payload}.`)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });
});

describe("identidade vem somente do token", () => {
  it("GET /v1/me devolve o uid do token", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA", email: "a@example.com" });
    const res = await call("/v1/me", {}, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: "userA", email: "a@example.com" });
  });

  it("repassa o token ORIGINAL do usuário ao Firestore, sem credencial de serviço", async () => {
    const { fs, call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    await call("/v1/profile", {}, token);
    expect(fs.calls).toHaveLength(1);
    expect(fs.calls[0]?.authorization).toBe(`Bearer ${token}`);
  });

  it("usuário A só acessa o caminho de A, mesmo com ?uid=userB na URL", async () => {
    const { fs, call } = setup({
      "users/userA": { uid: "userA", displayName: "A" },
      "users/userB": { uid: "userB", displayName: "B" },
    });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile?uid=userB&userId=userB", { headers: { "X-User-Id": "userB" } }, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { displayName: string }).displayName).toBe("A");
    expect(fs.calls.every((c) => c.url.includes("/documents/users/userA"))).toBe(true);
    expect(fs.calls.some((c) => c.url.includes("userB"))).toBe(false);
  });

  it("PUT com uid de outro usuário no corpo é rejeitado e nada é gravado", async () => {
    const { fs, call } = setup({ "users/userB": { uid: "userB", displayName: "B" } });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", putJson({ ...validProfile, uid: "userB" }), token);
    expect(res.status).toBe(400);
    expect(fs.calls).toHaveLength(0);
    expect(fs.docs.get("users/userB")).toEqual({ uid: "userB", displayName: "B" });
  });

  it("PUT válido grava somente em users/{uid do token} com uid do token", async () => {
    const { fs, call } = setup({ "users/userB": { uid: "userB", displayName: "B" } });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile?uid=userB", putJson(validProfile), token);
    expect(res.status).toBe(200);
    expect(fs.docs.get("users/userA")).toMatchObject({ uid: "userA", displayName: "Ana" });
    expect(fs.docs.get("users/userB")).toEqual({ uid: "userB", displayName: "B" });
    const writes = fs.calls.filter((c) => c.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain("/documents/users/userA?");
  });

  it("DELETE de preferências atinge só o documento de quem está autenticado", async () => {
    const { fs, call } = setup({
      "users/userA/preferences/app": { uid: "userA" },
      "users/userB/preferences/app": { uid: "userB" },
    });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/preferences?uid=userB", { method: "DELETE" }, token);
    expect(res.status).toBe(204);
    expect(fs.docs.has("users/userA/preferences/app")).toBe(false);
    expect(fs.docs.has("users/userB/preferences/app")).toBe(true);
  });

  it("preserva createdAt ao atualizar o perfil", async () => {
    const { fs, call } = setup({
      "users/userA": { ...validProfile, uid: "userA", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const token = await signToken(signer, { uid: "userA" });
    await call("/v1/profile", putJson({ ...validProfile, displayName: "Nova" }), token);
    expect(fs.docs.get("users/userA")).toMatchObject({
      displayName: "Nova",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-11-09T12:00:00.000Z",
    });
  });
});

describe("preferências e validação", () => {
  it("GET sem documento devolve os padrões com stored=false", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    const body = (await (await call("/v1/preferences", {}, token)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ theme: "system", confirmCreations: true, stored: false, uid: "userA" });
  });

  it("PUT válido e leitura seguinte", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    expect((await call("/v1/preferences", putJson(validPrefs), token)).status).toBe(200);
    const body = (await (await call("/v1/preferences", {}, token)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ theme: "dark", stored: true });
  });

  it("rejeita JSON inválido, dados inválidos e corpo grande", async () => {
    const { fs, call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    const bad = await call("/v1/preferences", { method: "PUT", body: "{nao-json" }, token);
    expect(bad.status).toBe(400);
    const invalid = await call("/v1/preferences", putJson({ ...validPrefs, theme: "neon" }), token);
    expect(invalid.status).toBe(400);
    const big = await call("/v1/profile", putJson({ ...validProfile, displayName: "x".repeat(40000) }), token);
    expect(big.status).toBe(413);
    expect(fs.calls).toHaveLength(0);
  });

  it("método não permitido e rota inexistente", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    expect((await call("/v1/me", { method: "POST" }, token)).status).toBe(405);
    expect((await call("/v1/inexistente", {}, token)).status).toBe(404);
  });

  it("perfil inexistente: 404", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    expect((await call("/v1/profile", {}, token)).status).toBe(404);
  });
});

describe("erros do Firestore e resiliência", () => {
  it("403 das regras de segurança vira 403", async () => {
    const { fs, call } = setup();
    fs.failNext(403);
    const token = await signToken(signer, { uid: "userA" });
    expect((await call("/v1/profile", {}, token)).status).toBe(403);
  });

  it("401 do Firestore vira 401 com invalid_token", async () => {
    const { fs, call } = setup();
    fs.failNext(401);
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("leitura repete uma vez em falha transitória", async () => {
    const { fs, call } = setup({ "users/userA": { uid: "userA", displayName: "A" } });
    fs.failNext(503);
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(200);
    expect(fs.calls).toHaveLength(2);
  });

  it("escrita NÃO é repetida automaticamente em falha", async () => {
    const fs = fakeFirestore();
    const token = await signToken(signer, { uid: "userA" });
    // A leitura do perfil passa; toda tentativa de escrita (PATCH) falha com 503.
    const originalFetch = fs.fetchImpl;
    let patchAttempts = 0;
    const failingPatch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patchAttempts++;
        return new Response("{}", { status: 503 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    const app = makeApp(signer, failingPatch);
    const res = await app("/v1/profile", putJson(validProfile), token);
    expect(res.status).toBe(502);
    expect(patchAttempts).toBe(1);
  });

  it("falha de rede vira 504 sem vazar detalhes", async () => {
    const { fs, call } = setup();
    fs.failNext("network", "network");
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(504);
    expect(JSON.stringify(await res.json())).not.toContain("network error");
  });
});

describe("cabeçalhos, CORS e logs", () => {
  it("respostas autenticadas usam cache privado e não compartilhado", async () => {
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/me", {}, token);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("CORS só libera a origem configurada", async () => {
    const { call } = setup();
    const allowed = await call("/healthz", { headers: { Origin: ORIGIN } });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const denied = await call("/healthz", { headers: { Origin: "https://evil.example" } });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await call("/v1/profile", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(preflight.status).toBe(204);
  });

  it("healthz não exige autenticação", async () => {
    const { call } = setup();
    const res = await call("/healthz");
    expect(res.status).toBe(200);
  });

  it("logs não contêm o token nem dados do corpo", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { call } = setup();
    const token = await signToken(signer, { uid: "userA" });
    await call("/v1/profile", putJson(validProfile), token);
    await call("/v1/profile", {}, "token-invalido-xyz");
    const output = spy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(token);
    expect(output).not.toContain("token-invalido-xyz");
    expect(output).not.toContain("Ana");
    expect(output).toContain("requestId");
  });
});
