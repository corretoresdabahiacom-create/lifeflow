import type { Env } from "./env";
import { HttpError } from "./errors";
import {
  DbClient,
  type DocData,
  type QueryFilter,
  type QuerySpec,
  type StoredDoc,
  type WriteOp,
} from "./db";

/**
 * Caminho PRIVILEGIADO e RESTRITO do Worker.
 *
 * Quase tudo no Worker usa o token do usuário (a RLS do Postgres vale). Webhooks de pagamento e o painel
 * administrativo não têm token de usuário e precisam gravar assinaturas, que o cliente não pode forjar.
 * Para isso existe a chave secreta do Supabase — mas aqui ela só alcança uma LISTA FECHADA de caminhos. Não há
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
  constructor(private readonly client: DbClient) {}

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

/**
 * Cliente privilegiado restrito: usa a chave secreta (`SUPABASE_SECRET_KEY`), que o PostgREST traduz para o papel
 * `service_role`. Sem a chave, as operações que dependem dela ficam indisponíveis (503), nunca abertas.
 */
function privilegedClient(env: Env, fetchImpl: typeof fetch): DbClient {
  if (!env.SUPABASE_SECRET_KEY) {
    throw new HttpError(503, "billing_not_configured", "Cobrança ainda não está configurada");
  }
  return new DbClient(env, { accessToken: "", apiKey: env.SUPABASE_SECRET_KEY, privileged: true, fetchImpl });
}

export async function createSystemDb(env: Env, fetchImpl: typeof fetch = fetch): Promise<SystemDb> {
  return new SystemDb(privilegedClient(env, fetchImpl));
}

// ---- Exclusão de conta (LGPD) ----

/**
 * Apaga TUDO de UM usuário. É o único trecho privilegiado que alcança conteúdo de usuário, e só o do próprio
 * solicitante: está preso ao uid do token. Remove a linha de `auth.users`; as chaves estrangeiras
 * `ON DELETE CASCADE` apagam perfil, finanças, agenda, conversas, trilha de auditoria e consentimentos — itens que
 * as políticas RLS proíbem o próprio cliente de excluir.
 */
export class UserErasure {
  constructor(
    private readonly client: DbClient,
    private readonly uid: string,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) throw new SystemAccessError("uid inválido");
  }

  /** Devolve quantos registros foram apagados (inclui o usuário). Idempotente: usuário inexistente => 0. */
  eraseAll(): Promise<number> {
    return this.client.eraseUser(this.uid);
  }
}

export async function createUserErasure(env: Env, fetchImpl: typeof fetch, uid: string): Promise<UserErasure> {
  return new UserErasure(privilegedClient(env, fetchImpl), uid);
}
