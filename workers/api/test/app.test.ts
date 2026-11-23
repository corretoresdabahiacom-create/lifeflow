import { SignJWT, base64url } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ISSUER,
  ORIGIN,
  fakeSupabase,
  makeApp,
  makeSigner,
  putJson,
  signToken,
  uuidFor,
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

/** Perfis prontos no banco: `{ userA: "A" }` cria o usuário (auth.users) e o perfil dele. */
const setup = async (profiles: Record<string, string> = {}) => {
  const fs = await fakeSupabase();
  for (const [label, name] of Object.entries(profiles)) {
    const uid = uuidFor(label);
    await fs.ensureUser(uid);
    await fs.sql(
      "insert into profiles (user_id, display_name, locale, timezone, currency, created_at, updated_at) values ($1, $2, 'pt-BR', 'America/Sao_Paulo', 'BRL', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z')",
      [uid, name],
    );
  }
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => fs.fetchImpl(input, init)) as typeof fetch;
  return { fs, call: makeApp(signer, wrapped) };
};

describe("autenticação: ausência e invalidez do token", () => {
  it("sem token: 401 e o banco nunca é chamado", async () => {
    const { fs, call } = await setup();
    const res = await call("/v1/profile");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(fs.calls).toHaveLength(0);
  });

  it("cabeçalho Authorization malformado: 401", async () => {
    const { fs, call } = await setup();
    const res = await call("/v1/profile", { headers: { Authorization: "Basic abc" } });
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("texto aleatório como JWT: 401", async () => {
    const { fs, call } = await setup();
    const res = await call("/v1/profile", {}, "isto.nao.e-um-jwt");
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("assinatura de outra chave: 401", async () => {
    const { fs, call } = await setup();
    const forged = await signToken(attacker, { uid: "userB" });
    const res = await call("/v1/profile", {}, forged);
    expect(res.status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("token expirado: 401 com invalid_token", async () => {
    const { fs, call } = await setup();
    const past = Math.floor(Date.now() / 1000) - 7200;
    const token = await signToken(signer, { uid: "userA", issuedAt: past - 60, expiresAt: past });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
    expect(fs.calls).toHaveLength(0);
  });

  it("audiência errada: 401", async () => {
    const { fs, call } = await setup();
    const token = await signToken(signer, { uid: "userA", audience: "outro-projeto" });
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("emissor errado: 401", async () => {
    const { fs, call } = await setup();
    const token = await signToken(signer, { uid: "userA", issuer: "https://outro.supabase.co/auth/v1" });
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("token sem sub: 401", async () => {
    const { fs, call } = await setup();
    const token = await signToken(signer, {});
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("token sem papel `authenticated` (chave anônima) ou com sub fora do formato UUID: 401", async () => {
    const { fs, call } = await setup();
    const anon = await new SignJWT({ role: "anon" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setSubject(uuidFor("userA"))
      .setExpirationTime("1h")
      .sign(signer.privateKey);
    expect((await call("/v1/profile", {}, anon)).status).toBe(401);
    const notUuid = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setSubject("userA; drop table profiles")
      .setExpirationTime("1h")
      .sign(signer.privateKey);
    expect((await call("/v1/profile", {}, notUuid)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it("algoritmo HS256 (confusão de algoritmo): 401", async () => {
    const { fs, call } = await setup();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject(uuidFor("userB"))
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("segredo-qualquer-segredo-qualquer-123"));
    expect((await call("/v1/profile", {}, token)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });

  it('algoritmo "none": 401', async () => {
    const { fs, call } = await setup();
    const header = base64url.encode(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = base64url.encode(
      JSON.stringify({
        sub: uuidFor("userB"),
        iss: ISSUER,
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect((await call("/v1/profile", {}, `${header}.${payload}.`)).status).toBe(401);
    expect(fs.calls).toHaveLength(0);
  });
});

describe("identidade vem somente do token", () => {
  it("GET /v1/me devolve o uid do token", async () => {
    const { call } = await setup();
    const token = await signToken(signer, { uid: "userA", email: "a@example.com" });
    const res = await call("/v1/me", {}, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: uuidFor("userA"), email: "a@example.com" });
  });

  it("repassa o token ORIGINAL do usuário ao banco, sem chave de serviço", async () => {
    const { fs, call } = await setup();
    const token = await signToken(signer, { uid: "userA" });
    await call("/v1/profile", {}, token);
    expect(fs.calls).toHaveLength(1);
    expect(fs.calls[0]?.authorization).toBe(`Bearer ${token}`);
    expect(fs.calls[0]?.apikey).toBe("sb_publishable_test");
  });

  it("usuário A só acessa o caminho de A, mesmo com ?uid=userB na URL", async () => {
    const { fs, call } = await setup({ userA: "A", userB: "B" });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile?uid=userB&userId=userB", { headers: { "X-User-Id": "userB" } }, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { displayName: string }).displayName).toBe("A");
    const others = fs.calls.filter((c) => !(c.url.endsWith("/rpc/lf_get") || c.url.endsWith("/rpc/lf_query") || c.url.endsWith("/rpc/lf_commit")));
    expect(others).toHaveLength(0);
    expect(fs.calls.every((c) => (c.body ?? "").includes(uuidFor("userA")))).toBe(true);
    expect(fs.calls.some((c) => (c.body ?? "").includes(uuidFor("userB")))).toBe(false);
  });

  it("PUT com uid de outro usuário no corpo é rejeitado e nada é gravado", async () => {
    const { fs, call } = await setup({ userB: "B" });
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", putJson({ ...validProfile, uid: uuidFor("userB") }), token);
    expect(res.status).toBe(400);
    expect(fs.calls).toHaveLength(0);
    expect(await fs.sql("select display_name from profiles")).toEqual([{ display_name: "B" }]);
  });
});

describe("erros do banco e resiliência", () => {
  it("403 das regras de segurança vira 403", async () => {
    const { fs, call } = await setup();
    fs.failNext(403);
    const token = await signToken(signer, { uid: "userA" });
    expect((await call("/v1/profile", {}, token)).status).toBe(403);
  });

  it("401 do banco vira 401 com invalid_token", async () => {
    const { fs, call } = await setup();
    fs.failNext(401);
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });

  it("leitura repete uma vez em falha transitória", async () => {
    const { fs, call } = await setup({ userA: "A" });
    fs.failNext(503);
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(200);
    expect(fs.calls).toHaveLength(2);
  });

  it("escrita NÃO é repetida automaticamente em falha", async () => {
    const fs = await fakeSupabase();
    const token = await signToken(signer, { uid: "userA" });
    // A leitura passa; toda tentativa de escrita (lf_commit) falha com 503.
    let writeAttempts = 0;
    const failingWrite = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/rpc/lf_commit")) {
        writeAttempts++;
        return new Response("{}", { status: 503 });
      }
      return fs.fetchImpl(input, init);
    }) as typeof fetch;
    const app = makeApp(signer, failingWrite);
    const res = await app("/v1/profile", putJson(validProfile), token);
    expect(res.status).toBe(502);
    expect(writeAttempts).toBe(1);
  });

  it("falha de rede vira 504 sem vazar detalhes", async () => {
    const { fs, call } = await setup();
    fs.failNext("network", "network");
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/profile", {}, token);
    expect(res.status).toBe(504);
    expect(JSON.stringify(await res.json())).not.toContain("network error");
  });
});

describe("cabeçalhos, CORS e logs", () => {
  it("respostas autenticadas usam cache privado e não compartilhado", async () => {
    const { call } = await setup();
    const token = await signToken(signer, { uid: "userA" });
    const res = await call("/v1/me", {}, token);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("CORS só libera a origem configurada", async () => {
    const { call } = await setup();
    const allowed = await call("/healthz", { headers: { Origin: ORIGIN } });
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const denied = await call("/healthz", { headers: { Origin: "https://evil.example" } });
    expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await call("/v1/profile", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(preflight.status).toBe(204);
  });

  it("healthz não exige autenticação", async () => {
    const { call } = await setup();
    const res = await call("/healthz");
    expect(res.status).toBe(200);
  });

  it("logs não contêm o token nem dados do corpo", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { call } = await setup();
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
