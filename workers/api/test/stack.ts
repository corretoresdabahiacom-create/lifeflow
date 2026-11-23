import type { Env } from "../src/env";
import { DbClient } from "../src/db";
import { createSystemDb } from "../src/system";

/**
 * Suíte de INTEGRAÇÃO: roda contra uma pilha Supabase REAL (`supabase start` na CI): GoTrue emite os tokens,
 * o PostgREST verifica a assinatura e aplica a RLS, e o Postgres executa as migrações de `supabase/migrations`.
 *
 * Variáveis (valores de `supabase status -o env`):
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (ANON_KEY), SUPABASE_SECRET_KEY (SERVICE_ROLE_KEY)
 * Execução: `pnpm test:integration`. Nunca aponte isto para um projeto de produção: os testes criam e apagam usuários.
 */
const url = process.env["SUPABASE_URL"];
const publishable = process.env["SUPABASE_PUBLISHABLE_KEY"];
const secret = process.env["SUPABASE_SECRET_KEY"];

if (!url || !publishable || !secret) {
  throw new Error("SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY/SUPABASE_SECRET_KEY ausentes: rode `pnpm test:integration` (ele inicia `supabase start`).");
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
  throw new Error("Os testes de integração só rodam contra uma pilha LOCAL (127.0.0.1/localhost): eles criam e apagam usuários.");
}

export const stackEnv: Partial<Env> = {
  SUPABASE_URL: url,
  SUPABASE_PUBLISHABLE_KEY: publishable,
  SUPABASE_SECRET_KEY: secret,
};

export interface StackUser {
  uid: string;
  email: string;
  token: string;
}

const PASSWORD = "senha-de-teste-123456";

async function json(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Supabase local respondeu ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** Cadastra (via API de administração do GoTrue) e autentica um usuário novo; devolve o JWT REAL. */
export async function createStackUser(
  label: string,
  options: { admin?: boolean; email?: string; /** Usuário anônimo: o JWT não traz `email`. */ noEmail?: boolean } = {},
): Promise<StackUser> {
  const email = options.email ?? `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  if (options.noEmail) return createAnonymousStackUser();
  const identity = { email };
  const created = await json(
    await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: secret as string, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...identity,
        password: PASSWORD,
        email_confirm: true,
        ...(options.admin ? { app_metadata: { admin: true } } : {}),
      }),
    }),
  );
  const session = await json(
    await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: publishable as string, "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity, password: PASSWORD }),
    }),
  );
  return { uid: String(created["id"]), email, token: String(session["access_token"]) };
}

/** Usuário ANÔNIMO do GoTrue: o JWT real não traz `email` (cobre o caso "sem e-mail" sem depender de provedor de SMS). */
async function createAnonymousStackUser(): Promise<StackUser> {
  const session = await json(
    await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: publishable as string, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  const user = session["user"] as { id: string };
  return { uid: user.id, email: "", token: String(session["access_token"]) };
}

/** Cliente com a chave secreta (preparação/inspeção dos testes), como o caminho privilegiado do Worker. */
export function stackRaw(env: Partial<Env> = {}): DbClient {
  return new DbClient({ ...(stackEnv as Env), ...env }, { accessToken: "", apiKey: secret as string, privileged: true });
}

export const stackSystemDb = (env: Partial<Env> = {}) => createSystemDb({ ...(stackEnv as Env), ...env } as Env, fetch);
