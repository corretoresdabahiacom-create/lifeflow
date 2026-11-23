import type { Env } from "./env";
import { HttpError } from "./errors";

/**
 * Camada de dados sobre o Supabase (Postgres + PostgREST).
 *
 * O restante do Worker fala em "documentos" com caminho (`users/{uid}/accounts/{id}`) e campos camelCase.
 * Este módulo traduz isso para as funções `lf_get/lf_commit/lf_query/lf_count` (supabase/migrations), que operam
 * sobre tabelas relacionais em snake_case. Quem decide o que cada requisição pode fazer é a RLS do Postgres:
 * o token do usuário é repassado como `Authorization`, e nunca há credencial de serviço neste caminho.
 */

export type FieldValue = string | boolean | number | null;
export type DocData = Record<string, FieldValue>;

/** Uma gravação dentro de um `commit` atômico. */
export interface WriteOp {
  /** Caminho relativo do documento, ex.: `users/{uid}/accounts/{id}`. */
  path: string;
  /** Campos a gravar. Sem `merge`/`increments`, substitui o documento inteiro. */
  fields?: DocData;
  /** Altera apenas os campos informados em `fields` (cria o documento se não existir). */
  merge?: boolean;
  /** Incrementos atômicos feitos no servidor (valores inteiros, podem ser negativos). */
  increments?: Record<string, number>;
  /** `exists:false` = só cria; `exists:true` = só altera; `updateTime` = só se a `version` não mudou desde a leitura. */
  precondition?: { exists: boolean } | { updateTime: string };
  /** Exclui o documento (os demais campos são ignorados). */
  delete?: boolean;
}

/** Uma pré-condição do commit falhou: nada foi gravado. */
export class PreconditionFailedError extends Error {
  constructor() {
    super("Pré-condição de escrita não satisfeita");
  }
}

export interface StoredDoc {
  id: string;
  /** Caminho completo relativo (`users/{uid}/aiUsage/2026-11`). */
  path: string;
  data: DocData;
  updateTime: string;
}

export interface QueryFilter {
  field: string;
  op: "EQUAL" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN_OR_EQUAL";
  value: string | number | boolean;
}

export interface QuerySpec {
  /** Subcoleção direta do `parent`. */
  collection: string;
  filters?: QueryFilter[];
  /** Campo de ordenação (desempate por id do documento, na mesma direção). */
  orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" };
  limit: number;
  /** Consulta em TODAS as subcoleções com este nome (collection group). Sem `after`. */
  group?: boolean;
  /** Continua DEPOIS deste documento (valor do campo de ordenação + id). */
  after?: { value: string | number | null; id: string };
}


/** `createdAt` -> `created_at`; o campo de documento `uid` é a coluna `user_id`. */
export function toColumn(field: string): string {
  if (field === "uid") return "user_id";
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** `created_at` -> `createdAt`; a coluna `user_id` volta como `uid`. */
export function toField(column: string): string {
  if (column === "user_id") return "uid";
  return column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function encodeRecord<T>(data: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(data ?? {})) out[toColumn(key)] = value;
  return out;
}

export function decodeFields(row: Record<string, unknown> | undefined): DocData {
  const data: DocData = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (value === null || value === undefined) data[toField(key)] = null;
    else if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") data[toField(key)] = value;
  }
  return data;
}

export interface DbClientOptions {
  /** Token ORIGINAL do usuário (JWT do Supabase Auth). A RLS do Postgres decide o que ele pode ler e gravar. */
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Chave enviada em `apikey`. Padrão: a chave publicável do projeto. O caminho privilegiado restrito
   * (system.ts) passa a chave secreta, e então NÃO envia `Authorization` de usuário.
   */
  apiKey?: string;
  /** Chave secreta do backend (`sb_secret_…`): vai só em `apikey`, sem `Authorization`. */
  privileged?: boolean;
}

/** Cliente de dados criado POR REQUISIÇÃO com o token do usuário. Sem token válido o Postgres nega o acesso. */
export class DbClient {
  private readonly base: string;
  private readonly accessToken: string;
  private readonly apiKey: string;
  private readonly privileged: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(env: Env, options: DbClientOptions) {
    this.base = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc`;
    this.accessToken = options.accessToken;
    this.apiKey = options.apiKey ?? env.SUPABASE_PUBLISHABLE_KEY;
    this.privileged = options.privileged ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  async get(path: string): Promise<DocData | null> {
    return (await this.getDoc(path))?.data ?? null;
  }

  /** Cria ou altera os campos informados do documento (upsert). Sem retry automático. */
  async upsert(path: string, data: DocData): Promise<void> {
    await this.commit([{ path, fields: data, merge: true }]);
  }

  async delete(path: string): Promise<void> {
    await this.commit([{ path, delete: true }]);
  }

  /** Lê o documento com a `version`, usada como pré-condição de escrita otimista (devolvida como `updateTime`). */
  async getDoc(path: string): Promise<{ data: DocData; updateTime: string } | null> {
    // Leitura é segura para repetir uma vez em falhas transitórias.
    const response = await this.rpc("lf_get", { p_path: path }, 1);
    await this.assertOk(response);
    const body = (await response.json().catch(() => null)) as { data?: Record<string, unknown>; version?: string } | null;
    if (!body || typeof body !== "object" || !body.data) return null;
    return { data: decodeFields(body.data), updateTime: String(body.version ?? "") };
  }

  /**
   * Grava vários documentos de forma ATÔMICA (uma transação) em `lf_commit`.
   * Se alguma pré-condição falhar, lança `PreconditionFailedError` e nada é gravado.
   * Sem retry automático: quem chama decide (as operações financeiras são idempotentes por id).
   */
  async commit(ops: WriteOp[]): Promise<void> {
    const p_ops = ops.map((op) => {
      if (op.delete) {
        return { path: op.path, delete: true, ...(op.precondition ? { precondition: op.precondition } : {}) };
      }
      return {
        path: op.path,
        fields: encodeRecord(op.fields),
        // Sem `merge`/`increments` a escrita substitui o documento inteiro, como no modelo de documentos.
        ...(op.merge ? { merge: true } : {}),
        ...(op.increments ? { increments: encodeRecord(op.increments) } : {}),
        ...(op.precondition ? { precondition: op.precondition } : {}),
      };
    });
    const response = await this.rpc("lf_commit", { p_ops }, 0);
    if (response.ok) return;
    if (response.status === 409 && (await errorCode(response)) === "PT409") throw new PreconditionFailedError();
    await this.assertOk(response);
  }

  /** Consulta uma subcoleção direta de `parent` (ex.: `users/{uid}`). Leitura: repete 1 vez se transitório. */
  async query(parent: string, spec: QuerySpec): Promise<StoredDoc[]> {
    const p_spec = {
      filters: (spec.filters ?? []).map((f) => ({ field: toColumn(f.field), op: f.op, value: f.value })),
      limit: spec.limit,
      ...(spec.group ? { group: true } : {}),
      ...(spec.orderBy ? { orderBy: { field: toColumn(spec.orderBy.field), direction: spec.orderBy.direction } } : {}),
      ...(spec.after ? { after: spec.after } : {}),
    };
    const response = await this.rpc("lf_query", { p_parent: parent, p_collection: spec.collection, p_spec }, 1);
    await this.assertOk(response);
    const rows = (await response.json()) as Array<{ id: string; path: string; version: string; data: Record<string, unknown> }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      data: decodeFields(row.data),
      updateTime: String(row.version),
    }));
  }

  /** Conta documentos de uma coleção raiz, sem ler o conteúdo. */
  async count(collection: string, filters: QueryFilter[] = []): Promise<number> {
    const p_filters = filters.map((f) => ({ field: toColumn(f.field), op: f.op, value: f.value }));
    const response = await this.rpc("lf_count", { p_collection: collection, p_filters }, 1);
    await this.assertOk(response);
    return Number(await response.json());
  }

  /** Exclui o usuário e, por cascata, tudo o que é dele. Só funciona com a chave de serviço. */
  async eraseUser(uid: string): Promise<number> {
    const response = await this.rpc("lf_erase_user", { p_uid: uid }, 0);
    await this.assertOk(response);
    return Number(await response.json());
  }

  private async rpc(fn: string, args: Record<string, unknown>, retries: number): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (!this.privileged) headers["Authorization"] = `Bearer ${this.accessToken}`;
    // Chaves secretas novas (`sb_secret_…`) não são JWT: vão só em `apikey`. A chave legada (JWT `service_role`) também
    // é aceita como Bearer pelo gateway, e algumas instalações antigas exigem isso.
    else if (!this.apiKey.startsWith("sb_")) headers["Authorization"] = `Bearer ${this.apiKey}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(`${this.base}/${fn}`, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
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
    // 403: RLS/gatilho negou. 400/409: dado recusado pelas regras do banco (domínios, CHECK, chave estrangeira). Ambos são "regras de segurança".
    if (response.status === 403 || response.status === 400 || response.status === 409) {
      throw new HttpError(403, "forbidden", "Acesso negado pelas regras de segurança");
    }
    if (response.status === 429) {
      throw new HttpError(429, "upstream_rate_limited", "Limite do banco de dados atingido");
    }
    throw new HttpError(502, "upstream_error", "Falha ao acessar o banco de dados");
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json().catch(() => ({}))) as { code?: string };
  return body.code ?? "";
}
