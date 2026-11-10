import {
  DEFAULT_PREFERENCES,
  PreferencesInputSchema,
  ProfileInputSchema,
  type Preferences,
  type Profile,
} from "@lifeflow/shared";
import {
  defaultKeyResolver,
  extractBearerToken,
  verifyFirebaseToken,
  type AuthenticatedUser,
  type KeyResolver,
} from "./auth";
import type { Env } from "./env";
import { HttpError } from "./errors";
import { FirestoreClient, type DocData } from "./firestore";
import { handleAgenda } from "./agenda";
import { handleFinance } from "./finance";
import { allow, json, parseBody } from "./http";
import { log } from "./logger";

export interface AppDeps {
  fetchImpl?: typeof fetch;
  keyResolver?: (env: Env) => KeyResolver;
  now?: () => Date;
}

export function createHandler(deps: AppDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const resolveKeys = deps.keyResolver ?? defaultKeyResolver;

  return async function handle(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const url = new URL(request.url);
    const base = { requestId, method: request.method, path: url.pathname };
    let uid: string | undefined;

    const finish = (response: Response, errorCode?: string): Response => {
      const headers = new Headers(response.headers);
      headers.set("X-Request-Id", requestId);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "private, no-store");
      applyCors(headers, request, env);
      const final = new Response(response.body, { status: response.status, headers });
      log(final.status >= 500 ? "error" : "info", "request", {
        ...base,
        status: final.status,
        durationMs: Date.now() - started,
        ...(uid ? { uid } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
      return final;
    };

    try {
      if (request.method === "OPTIONS") return finish(new Response(null, { status: 204 }));
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Método não permitido");
        return finish(json({ status: "ok" }));
      }
      if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "Rota não encontrada");

      // Autenticação: a identidade vem somente do token validado, nunca do cliente.
      const token = extractBearerToken(request);
      const user: AuthenticatedUser = await verifyFirebaseToken(token, env, resolveKeys(env));
      uid = user.uid;

      const db = new FirestoreClient(env, {
        idToken: token,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });

      const response = await route(request, url, user, db, now);
      return finish(response);
    } catch (error) {
      if (error instanceof HttpError) {
        return finish(
          json({ error: { code: error.code, message: error.message, requestId } }, error.status, error.headers),
          error.code,
        );
      }
      log("error", "unhandled_error", { ...base, errorCode: "internal_error" });
      return finish(
        json({ error: { code: "internal_error", message: "Erro interno", requestId } }, 500),
        "internal_error",
      );
    }
  };
}

async function route(
  request: Request,
  url: URL,
  user: AuthenticatedUser,
  db: FirestoreClient,
  now: () => Date,
): Promise<Response> {
  const method = request.method;
  // Todos os caminhos do Firestore são derivados do uid do token.
  const profilePath = `users/${user.uid}`;
  const prefsPath = `users/${user.uid}/preferences/app`;

  const finance = await handleFinance({ request, url, uid: user.uid, db, now });
  if (finance) return finance;
  const agenda = await handleAgenda({ request, url, uid: user.uid, db, now });
  if (agenda) return agenda;

  switch (url.pathname) {
    case "/v1/me": {
      allow(method, ["GET"]);
      return json({ uid: user.uid, ...(user.email ? { email: user.email } : {}) });
    }
    case "/v1/profile": {
      allow(method, ["GET", "PUT"]);
      if (method === "GET") {
        const stored = await db.get(profilePath);
        if (!stored) throw new HttpError(404, "not_found", "Perfil ainda não criado");
        return json(stored as unknown as Profile);
      }
      const input = await parseBody(request, ProfileInputSchema);
      const existing = await db.get(profilePath);
      const timestamp = now().toISOString();
      const createdAt = typeof existing?.["createdAt"] === "string" ? existing["createdAt"] : timestamp;
      const doc: DocData = { ...input, uid: user.uid, createdAt, updatedAt: timestamp };
      await db.upsert(profilePath, doc);
      return json(doc as unknown as Profile);
    }
    case "/v1/preferences": {
      allow(method, ["GET", "PUT", "DELETE"]);
      if (method === "GET") {
        const stored = await db.get(prefsPath);
        if (!stored) {
          const defaults: Preferences = { ...DEFAULT_PREFERENCES, uid: user.uid, updatedAt: now().toISOString() };
          return json({ ...defaults, stored: false });
        }
        return json({ ...(stored as unknown as Preferences), stored: true });
      }
      if (method === "DELETE") {
        await db.delete(prefsPath);
        return new Response(null, { status: 204 });
      }
      const input = await parseBody(request, PreferencesInputSchema);
      const doc: DocData = { ...input, uid: user.uid, updatedAt: now().toISOString() };
      await db.upsert(prefsPath, doc);
      return json({ ...(doc as unknown as Preferences), stored: true });
    }
    default:
      throw new HttpError(404, "not_found", "Rota não encontrada");
  }
}

function applyCors(headers: Headers, request: Request, env: Env): void {
  headers.append("Vary", "Origin");
  const origin = request.headers.get("Origin");
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    headers.set("Access-Control-Expose-Headers", "Idempotent-Replay, X-Request-Id, Content-Disposition");
    headers.set("Access-Control-Max-Age", "600");
  }
}
