import { Client, defineFinanceSuite, type World } from "./finance.suite";
import { makeApp, type Signer } from "./helpers";
import { createStackUser, stackEnv } from "./stack";

/**
 * Mesma suíte financeira, agora contra o Supabase REAL (`supabase start`): GoTrue, PostgREST, RLS, gatilhos e
 * migrações de verdade. Valida o commit atômico, as pré-condições, os incrementos, as consultas, e que a RLS aceita
 * tudo o que o Worker grava. Execução: `pnpm test:integration` (exige Docker).
 */
async function stackWorld(_signer: Signer): Promise<World> {
  const app = makeApp(null, fetch, stackEnv);
  const [a, b] = await Promise.all([createStackUser("userA"), createStackUser("userB")]);
  return { A: new Client(app, a.token), B: new Client(app, b.token) };
}

defineFinanceSuite("finanças (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { fake: false });
