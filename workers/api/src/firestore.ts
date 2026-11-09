import type { Env } from "./env";
import { HttpError } from "./errors";

export type FieldValue = string | boolean | number | null;
export type DocData = Record<string, FieldValue>;

interface RestValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  nullValue?: null;
  timestampValue?: string;
}

export function encodeFields(data: DocData): Record<string, RestValue> {
  const fields: Record<string, RestValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") fields[key] = { stringValue: value };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
    else if (typeof value === "number") {
      fields[key] = Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    } else fields[key] = { nullValue: null };
  }
  return fields;
}

export function decodeFields(fields: Record<string, RestValue> | undefined): DocData {
  const data: DocData = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value.stringValue !== undefined) data[key] = value.stringValue;
    else if (value.booleanValue !== undefined) data[key] = value.booleanValue;
    else if (value.integerValue !== undefined) data[key] = Number(value.integerValue);
    else if (value.doubleValue !== undefined) data[key] = value.doubleValue;
    else if (value.timestampValue !== undefined) data[key] = value.timestampValue;
    else data[key] = null;
  }
  return data;
}

export interface FirestoreClientOptions {
  /** Token ORIGINAL do usuário. É repassado ao Firestore, que aplica as Security Rules. */
  idToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Cliente do Firestore criado POR REQUISIÇÃO com o token do usuário.
 * Não existe credencial de serviço: sem token válido o Firestore nega o acesso.
 */
export class FirestoreClient {
  private readonly base: string;
  private readonly idToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(env: Env, options: FirestoreClientOptions) {
    const root = (env.FIRESTORE_BASE_URL ?? "https://firestore.googleapis.com").replace(/\/+$/, "");
    this.base = `${root}/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
    this.idToken = options.idToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  async get(path: string): Promise<DocData | null> {
    // Leitura é segura para repetir uma vez em falhas transitórias.
    const response = await this.request("GET", `${this.base}/${path}`, undefined, 1);
    if (response.status === 404) return null;
    await this.assertOk(response);
    const body = (await response.json()) as { fields?: Record<string, RestValue> };
    return decodeFields(body.fields);
  }

  /** Cria ou substitui os campos informados do documento (upsert). Sem retry automático. */
  async upsert(path: string, data: DocData): Promise<void> {
    const mask = Object.keys(data)
      .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
      .join("&");
    const response = await this.request(
      "PATCH",
      `${this.base}/${path}?${mask}`,
      JSON.stringify({ fields: encodeFields(data) }),
      0,
    );
    await this.assertOk(response);
  }

  async delete(path: string): Promise<void> {
    const response = await this.request("DELETE", `${this.base}/${path}`, undefined, 0);
    if (response.status === 404) return;
    await this.assertOk(response);
  }

  private async request(
    method: string,
    url: string,
    body: string | undefined,
    retries: number,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${this.idToken}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        };
        if (body !== undefined) init.body = body;
        response = await this.fetchImpl(url, init);
      } catch {
        if (attempt >= retries) {
          throw new HttpError(504, "upstream_timeout", "O banco de dados não respondeu a tempo");
        }
        continue;
      }
      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < retries) continue;
      return response;
    }
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 401) {
      throw new HttpError(401, "unauthorized", "Token rejeitado pelo banco de dados", {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      });
    }
    if (response.status === 403) {
      throw new HttpError(403, "forbidden", "Acesso negado pelas regras de segurança");
    }
    if (response.status === 429) {
      throw new HttpError(429, "upstream_rate_limited", "Limite do banco de dados atingido");
    }
    throw new HttpError(502, "upstream_error", "Falha ao acessar o banco de dados");
  }
}
