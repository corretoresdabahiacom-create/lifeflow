import { beforeAll, describe, expect, it, vi } from "vitest";
import { readinessProblems } from "../src/app";
import type { Env } from "../src/env";
import { env, fakeFirestore, makeApp, makeSigner, type Signer } from "./helpers";

/** Operação: saúde, prontidão para produção e formato dos logs. */

const PROD: Env = {
  FIREBASE_PROJECT_ID: "lifeflow-prod",
  ALLOWED_ORIGIN: "https://app.lifeflow.example",
  GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
  MERCADOPAGO_ACCESS_TOKEN: "x",
  MERCADOPAGO_WEBHOOK_SECRET: "y",
  WEB_BASE_URL: "https://app.lifeflow.example",
  API_PUBLIC_URL: "https://api.lifeflow.example",
  DEEPSEEK_API_KEY: "z",
};

describe("saúde e prontidão", () => {
  let signer: Signer;
  beforeAll(async () => {
    signer = await makeSigner("k1");
  });
  const app = (override: Partial<Env>) => makeApp(signer, fakeFirestore().fetchImpl, override);

  it("/healthz responde 200 sem autenticação e só aceita GET", async () => {
    const a = app({});
    const r = await a("/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
    expect((await a("/healthz", { method: "POST" })).status).toBe(405);
  });

  it("/readyz: configuração de desenvolvimento NÃO é pronta para produção (503)", async () => {
    const r = await app({})("/readyz");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: "not_ready" }); // nenhum detalhe público
  });

  it("/readyz: configuração completa de produção → 200", async () => {
    const full = { ...PROD } as Partial<Env>;
    // makeApp mescla com o env de teste, que traz FIRESTORE_BASE_URL; em produção ele não existe.
    const r = await app({ ...full, FIRESTORE_BASE_URL: undefined })("/readyz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ready" });
    expect((await app({})("/readyz", { method: "POST" })).status).toBe(405);
  });

  it("readinessProblems aponta cada item que falta, sem expor valores", () => {
    expect(readinessProblems(PROD)).toEqual([]);
    expect(readinessProblems({ ...PROD, FIREBASE_PROJECT_ID: "demo-lifeflow" })).toContain("firebase_project");
    expect(readinessProblems({ ...PROD, ALLOWED_ORIGIN: "http://localhost:5173" })).toContain("allowed_origin_https");
    expect(readinessProblems({ ...PROD, FIRESTORE_BASE_URL: "http://127.0.0.1:8080" })).toContain("firestore_base_url_override");
    const { GOOGLE_SERVICE_ACCOUNT_JSON: _s, MERCADOPAGO_WEBHOOK_SECRET: _w, DEEPSEEK_API_KEY: _d, API_PUBLIC_URL: _u, ...partial } = PROD;
    expect(readinessProblems(partial as Env)).toEqual(["service_account", "payments", "public_urls", "llm"]);
    for (const problem of readinessProblems({ ...env })) expect(problem).not.toMatch(/=|secret_value|sk-/);
  });

  it("cada requisição gera UMA linha de log JSON com metadados e nunca o token", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      await app({})("/healthz");
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: "info", message: "request", method: "GET", path: "/healthz", status: 200 });
    expect(typeof entry["durationMs"]).toBe("number");
    expect(typeof entry["requestId"]).toBe("string");
  });
});
