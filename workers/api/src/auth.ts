import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Env } from "./env";
import { HttpError, unauthorized } from "./errors";

export const DEFAULT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface AuthenticatedUser {
  uid: string;
  email?: string;
}

export type KeyResolver = JWTVerifyGetKey;

const remoteSets = new Map<string, KeyResolver>();

/** Resolve as chaves públicas do Firebase Auth (cache em memória do isolate). */
export function defaultKeyResolver(env: Env): KeyResolver {
  const url = env.JWKS_URL ?? DEFAULT_JWKS_URL;
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
 * Valida criptograficamente o ID token do Firebase: assinatura RS256, emissor, audiência,
 * expiração e `sub`. A identidade vem exclusivamente do token validado.
 */
export async function verifyFirebaseToken(
  token: string,
  env: Env,
  keys: KeyResolver,
): Promise<AuthenticatedUser> {
  const projectId = env.FIREBASE_PROJECT_ID;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      clockTolerance: 5,
    });

    const uid = payload.sub;
    if (typeof uid !== "string" || uid.length === 0 || uid.length > 128) {
      throw unauthorized("Token sem identificação de usuário");
    }
    const authTime = payload["auth_time"];
    if (typeof authTime === "number" && authTime > Math.floor(Date.now() / 1000) + 5) {
      throw unauthorized("auth_time no futuro");
    }

    const email = typeof payload["email"] === "string" ? payload["email"] : undefined;
    return email ? { uid, email } : { uid };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof joseErrors.JWTExpired) throw unauthorized("Token expirado");
    if (error instanceof joseErrors.JOSEError) throw unauthorized("Token inválido");
    // Falha ao obter as chaves públicas não deve virar acesso nem vazar detalhes.
    throw unauthorized("Não foi possível validar o token");
  }
}
