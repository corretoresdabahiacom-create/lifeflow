import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "./env";
import { HttpError } from "./errors";
import {
  FirestoreClient,
  type DocData,
  type QueryFilter,
  type QuerySpec,
  type StoredDoc,
  type WriteOp,
} from "./firestore";

/**
 * Caminho PRIVILEGIADO e RESTRITO do Worker.
 *
 * Quase tudo no Worker usa o token do usuário (as Security Rules valem). Webhooks de pagamento e o painel
 * administrativo não têm token de usuário e precisam gravar assinaturas, que o cliente não pode forjar.
 * Para isso existe a conta de serviço — mas aqui ela só alcança uma LISTA FECHADA de caminhos. Não há
 * acesso ao conteúdo financeiro, de agenda ou de conversas dos usuários: tentar lê-lo lança erro.
 */

const WRITABLE_ROOT = /^(plans|subscriptions|webhookEvents|adminLogs)\/[^/]+$/;
const USER_BILLING = /^users\/[^/]+\/billingPayments\/[^/]+$/;
const ROOT_QUERY = new Set(["plans", "subscriptions", "webhookEvents", "adminLogs"]);
/** Consultas de grupo só para AGREGAR consumo/erros da IA (somas e contagens, nunca o conteúdo). */
const GROUP_QUERY = new Set(["aiUsage", "aiLogs"]);
const COUNTABLE = new Set(["users"]);

export class SystemAccessError extends Error {
  constructor(what: string) {
    super(`Acesso privilegiado negado: ${what}`);
  }
}

function assertPath(path: string): void {
  if (!WRITABLE_ROOT.test(path) && !USER_BILLING.test(path)) throw new SystemAccessError(path);
}

export class SystemDb {
  constructor(private readonly client: FirestoreClient) {}

  get(path: string): Promise<DocData | null> {
    assertPath(path);
    return this.client.get(path);
  }

  getDoc(path: string): Promise<{ data: DocData; updateTime: string } | null> {
    assertPath(path);
    return this.client.getDoc(path);
  }

  commit(ops: WriteOp[]): Promise<void> {
    for (const op of ops) assertPath(op.path);
    return this.client.commit(ops);
  }

  /** Consulta uma coleção RAIZ permitida (`parent` = "") ou os pagamentos de UM usuário (`users/{uid}`). */
  query(parent: string, spec: QuerySpec): Promise<StoredDoc[]> {
    if (parent === "") {
      if (!ROOT_QUERY.has(spec.collection)) throw new SystemAccessError(spec.collection);
    } else if (!(/^users\/[^/]+$/.test(parent) && spec.collection === "billingPayments")) {
      throw new SystemAccessError(`${parent}/${spec.collection}`);
    }
    return this.client.query(parent, { ...spec, group: false });
  }

  group(spec: Omit<QuerySpec, "group" | "after">): Promise<StoredDoc[]> {
    if (!GROUP_QUERY.has(spec.collection)) throw new SystemAccessError(spec.collection);
    return this.client.query("", { ...spec, group: true });
  }

  count(collection: string, filters: QueryFilter[] = []): Promise<number> {
    if (!COUNTABLE.has(collection) && !ROOT_QUERY.has(collection)) throw new SystemAccessError(collection);
    return this.client.count(collection, filters);
  }
}

// ---- Token da conta de serviço (OAuth2 jwt-bearer) ----

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(503, "billing_not_configured", "Credencial de serviço inválida");
  }
  const sa = parsed as Partial<ServiceAccount>;
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new HttpError(503, "billing_not_configured", "Credencial de serviço inválida");
  }
  return sa as ServiceAccount;
}

export async function serviceAccountToken(
  raw: string,
  fetchImpl: typeof fetch,
  nowMs: number = Date.now(),
): Promise<string> {
  const sa = parseServiceAccount(raw);
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt - 60_000 > nowMs) return cached.token;

  const audience = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const key = await importPKCS8(sa.private_key, "RS256").catch(() => {
    throw new HttpError(503, "billing_not_configured", "Credencial de serviço inválida");
  });
  const iat = Math.floor(nowMs / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 3600)
    .sign(key);

  let response: Response;
  try {
    response = await fetchImpl(audience, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, "upstream_error", "Falha ao obter credencial de serviço");
  }
  if (!response.ok) throw new HttpError(502, "upstream_error", "Falha ao obter credencial de serviço");
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (typeof body.access_token !== "string") throw new HttpError(502, "upstream_error", "Falha ao obter credencial de serviço");
  tokenCache.set(sa.client_email, { token: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export function clearServiceAccountTokenCache(): void {
  tokenCache.clear();
}

/**
 * Cria o cliente privilegiado restrito. Com `FIRESTORE_BASE_URL` (emulador/testes) usa o token "owner" do
 * emulador, que ignora as regras; em produção exige `GOOGLE_SERVICE_ACCOUNT_JSON`.
 */
export async function createSystemDb(env: Env, fetchImpl: typeof fetch = fetch): Promise<SystemDb> {
  let token: string;
  if (env.FIRESTORE_BASE_URL) {
    token = "owner";
  } else {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw new HttpError(503, "billing_not_configured", "Cobrança ainda não está configurada");
    }
    token = await serviceAccountToken(env.GOOGLE_SERVICE_ACCOUNT_JSON, fetchImpl);
  }
  return new SystemDb(new FirestoreClient(env, { idToken: token, fetchImpl }));
}
