import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Env } from "./env";
import { HttpError, unauthorized } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function authBase(env: Env): string {
  return `${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
}

export function jwksUrl(env: Env): string {
  return env.JWKS_URL ?? `${authBase(env)}/.well-known/jwks.json`;
}

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  /** Momento (epoch, s) do último login com credencial; usado para exigir login recente em ações sensíveis. */
  authTime?: number;
  /** `app_metadata.admin === true` do JWT (gravado só por quem administra o projeto; o usuário não altera `app_metadata`). */
  admin?: boolean;
}

export type KeyResolver = JWTVerifyGetKey;

const remoteSets = new Map<string, KeyResolver>();

/** Resolve as chaves públicas do Supabase Auth (cache em memória do isolate). */
export function defaultKeyResolver(env: Env): KeyResolver {
  const url = jwksUrl(env);
  let resolver = remoteSets.get(url);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 });
    remoteSets.set(url, resolver);
  }
  return resolver;
}

export function extractBearerToken(request: Request): string {
  const header = request.headers.get("Authorization");
  if (!header) throw unauthorized("Token de autenticação ausente", false);
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/.exec(header.trim());
  if (!match || !match[1]) throw unauthorized("Cabeçalho Authorization inválido");
  return match[1];
}

/**
 * Valida criptograficamente o JWT do Supabase Auth: assinatura assimétrica (ES256/RS256), emissor, audiência
 * `authenticated`, expiração e `sub` (UUID). Chaves simétricas (HS256) são recusadas: o Worker nunca vê o segredo.
 * A identidade vem exclusivamente do token validado.
 */
export async function verifySupabaseToken(
  token: string,
  env: Env,
  keys: KeyResolver,
): Promise<AuthenticatedUser> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["ES256", "RS256"],
      issuer: authBase(env),
      audience: "authenticated",
      clockTolerance: 5,
    });

    const uid = payload.sub;
    if (typeof uid !== "string" || !UUID.test(uid)) throw unauthorized("Token sem identificação de usuário");
    if (payload["role"] !== "authenticated") throw unauthorized("Token sem papel de usuário");

    // O Supabase não emite `auth_time`; o último método de autenticação fica em `amr[].timestamp`.
    const amr = Array.isArray(payload["amr"]) ? (payload["amr"] as unknown[]) : [];
    let authTime: number | undefined;
    for (const entry of amr) {
      const ts = (entry as { timestamp?: unknown } | null)?.timestamp;
      if (typeof ts === "number" && (authTime === undefined || ts > authTime)) authTime = ts;
    }
    if (authTime !== undefined && authTime > Math.floor(Date.now() / 1000) + 5) {
      throw unauthorized("Momento de autenticação no futuro");
    }

    const email = typeof payload["email"] === "string" ? payload["email"] : undefined;
    const meta = payload["app_metadata"] as { admin?: unknown } | undefined;
    const admin = meta?.admin === true;
    return {
      uid,
      ...(email ? { email } : {}),
      ...(admin ? { admin } : {}),
      ...(authTime !== undefined ? { authTime } : {}),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof joseErrors.JWTExpired) throw unauthorized("Token expirado");
    if (error instanceof joseErrors.JOSEError) throw unauthorized("Token inválido");
    // Falha ao obter as chaves públicas não deve virar acesso nem vazar detalhes.
    throw unauthorized("Não foi possível validar o token");
  }
}
