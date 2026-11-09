import type { Env } from "./env";
import { HttpError } from "./errors";

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
  /** `exists:false` = só cria; `exists:true` = só altera; `updateTime` = só se não mudou desde a leitura. */
  precondition?: { exists: boolean } | { updateTime: string };
}

/** Uma pré-condição do commit falhou: nada foi gravado. */
export class PreconditionFailedError extends Error {
  constructor() {
    super("Pré-condição de escrita não satisfeita");
  }
}

export interface StoredDoc {
  id: string;
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
  /** Continua DEPOIS deste documento (valor do campo de ordenação + id). */
  after?: { value: string | number | null; id: string };
}

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

function encodeValue(value: string | number | boolean): RestValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
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

  /** Lê o documento com o `updateTime`, usado como pré-condição de escrita otimista. */
  async getDoc(path: string): Promise<{ data: DocData; updateTime: string } | null> {
    const response = await this.request("GET", `${this.base}/${path}`, undefined, 1);
    if (response.status === 404) return null;
    await this.assertOk(response);
    const body = (await response.json()) as { fields?: Record<string, RestValue>; updateTime?: string };
    return { data: decodeFields(body.fields), updateTime: body.updateTime ?? "" };
  }

  /**
   * Grava vários documentos de forma ATÔMICA (tudo ou nada) no `documents:commit` do Firestore.
   * Se alguma pré-condição falhar, lança `PreconditionFailedError` e nada é gravado.
   * Sem retry automático: quem chama decide (as operações financeiras são idempotentes por id).
   */
  async commit(ops: WriteOp[]): Promise<void> {
    const writes = ops.map((op) => {
      const write: Record<string, unknown> = {
        update: { name: this.resourceName(op.path), fields: encodeFields(op.fields ?? {}) },
      };
      if (op.merge || op.increments) write["updateMask"] = { fieldPaths: Object.keys(op.fields ?? {}) };
      if (op.increments) {
        write["updateTransforms"] = Object.entries(op.increments).map(([fieldPath, amount]) => ({
          fieldPath,
          increment: { integerValue: String(amount) },
        }));
      }
      if (op.precondition) write["currentDocument"] = op.precondition;
      return write;
    });
    const response = await this.request("POST", `${this.base}:commit`, JSON.stringify({ writes }), 0);
    if (response.ok) return;
    if ([400, 404, 409].includes(response.status)) {
      const body = (await response.json().catch(() => ({}))) as { error?: { status?: string } };
      const status = body.error?.status ?? "";
      if (["ALREADY_EXISTS", "NOT_FOUND", "FAILED_PRECONDITION", "ABORTED"].includes(status)) {
        throw new PreconditionFailedError();
      }
    }
    await this.assertOk(response);
  }

  /** Consulta uma subcoleção direta de `parent` (ex.: `users/{uid}`). Leitura: repete 1 vez se transitório. */
  async query(parent: string, spec: QuerySpec): Promise<StoredDoc[]> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: spec.collection }],
      limit: spec.limit,
    };
    const filters = (spec.filters ?? []).map((f) => ({
      fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: encodeValue(f.value) },
    }));
    if (filters.length === 1) structuredQuery["where"] = filters[0];
    else if (filters.length > 1) structuredQuery["where"] = { compositeFilter: { op: "AND", filters } };

    const direction = spec.orderBy?.direction ?? "ASCENDING";
    const orderBy: Array<Record<string, unknown>> = [];
    if (spec.orderBy) orderBy.push({ field: { fieldPath: spec.orderBy.field }, direction });
    orderBy.push({ field: { fieldPath: "__name__" }, direction });
    structuredQuery["orderBy"] = orderBy;

    if (spec.after) {
      const reference = { referenceValue: `${this.resourceName(parent)}/${spec.collection}/${spec.after.id}` };
      const values = spec.orderBy
        ? [spec.after.value === null ? { nullValue: null } : encodeValue(spec.after.value), reference]
        : [reference];
      structuredQuery["startAt"] = { values, before: false };
    }

    const response = await this.request(
      "POST",
      `${this.base}/${parent}:runQuery`,
      JSON.stringify({ structuredQuery }),
      1,
    );
    await this.assertOk(response);
    const rows = (await response.json()) as Array<{
      document?: { name: string; fields?: Record<string, RestValue>; updateTime?: string };
    }>;
    const docs: StoredDoc[] = [];
    for (const row of rows) {
      if (!row.document) continue;
      docs.push({
        id: row.document.name.split("/").pop() ?? "",
        data: decodeFields(row.document.fields),
        updateTime: row.document.updateTime ?? "",
      });
    }
    return docs;
  }

  private resourceName(path: string): string {
    return `${this.base.slice(this.base.indexOf("projects/"))}/${path}`;
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
