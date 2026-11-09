import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { KeyLike, JWK } from "jose";
import { createHandler } from "../src/app";
import { decodeFields, encodeFields, type DocData } from "../src/firestore";
import type { Env } from "../src/env";

export const PROJECT_ID = "demo-lifeflow";
export const ORIGIN = "https://app.lifeflow.test";

export const env: Env = {
  FIREBASE_PROJECT_ID: PROJECT_ID,
  ALLOWED_ORIGIN: ORIGIN,
  FIRESTORE_BASE_URL: "https://firestore.test",
};

export interface Signer {
  jwk: JWK;
  privateKey: KeyLike;
}

export async function makeSigner(kid = "k1"): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { jwk, privateKey };
}

export interface TokenOptions {
  uid?: string;
  email?: string;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
  kid?: string;
}

export async function signToken(signer: Signer, options: TokenOptions = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: options.email ?? "user@example.com", auth_time: nowSec - 10 })
    .setProtectedHeader({ alg: "RS256", kid: options.kid ?? "k1" })
    .setIssuer(options.issuer ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(options.audience ?? PROJECT_ID)
    .setIssuedAt(options.issuedAt ?? nowSec - 10)
    .setExpirationTime(options.expiresAt ?? nowSec + 3600);
  if (options.uid !== undefined) jwt.setSubject(options.uid);
  return jwt.sign(signer.privateKey);
}

export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

/** Firestore falso em memória. Registra todas as chamadas para que os testes inspecionem o que o Worker enviou. */
export function fakeFirestore(initial: Record<string, DocData> = {}) {
  const docs = new Map<string, DocData>(Object.entries(initial));
  const calls: RecordedCall[] = [];
  let failures: Array<number | "network"> = [];

  const docPathOf = (url: URL): string => {
    const marker = "/documents/";
    return decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length));
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.toString(), authorization: headers.get("Authorization"), body });

    const next = failures.shift();
    if (next === "network") throw new TypeError("network error");
    if (typeof next === "number") return new Response("{}", { status: next });

    const path = docPathOf(url);
    if (method === "GET") {
      const doc = docs.get(path);
      if (!doc) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ name: path, fields: encodeFields(doc) }), { status: 200 });
    }
    if (method === "PATCH") {
      const parsed = JSON.parse(body ?? "{}") as { fields?: Parameters<typeof decodeFields>[0] };
      docs.set(path, { ...(docs.get(path) ?? {}), ...decodeFields(parsed.fields) });
      return new Response("{}", { status: 200 });
    }
    if (method === "DELETE") {
      docs.delete(path);
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 405 });
  }) as typeof fetch;

  return {
    docs,
    calls,
    fetchImpl,
    failNext(...statuses: Array<number | "network">) {
      failures = statuses;
    },
  };
}

export function makeApp(signer: Signer, fetchImpl: typeof fetch) {
  const handle = createHandler({
    fetchImpl,
    keyResolver: () => createLocalJWKSet({ keys: [signer.jwk] }),
    now: () => new Date("2026-11-09T12:00:00.000Z"),
  });
  return (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return handle(new Request(`https://api.test${path}`, { ...init, headers }), env);
  };
}

export const validProfile = {
  displayName: "Ana",
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
};

export const validPrefs = {
  theme: "dark",
  confirmCreations: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
};

export const putJson = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
