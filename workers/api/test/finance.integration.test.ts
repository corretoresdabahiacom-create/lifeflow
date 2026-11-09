import { Client, defineFinanceSuite, tokensFor, type World } from "./finance.suite";
import { makeApp, type Signer } from "./helpers";

/**
 * Mesma suíte financeira, agora contra o EMULADOR REAL do Firestore, com as Security Rules reais
 * (`firebase/firestore.rules`). Valida de verdade: commit atômico, pré-condições, incrementos,
 * consultas, e que as regras aceitam tudo o que o Worker grava.
 * Execução: `pnpm test:integration` (sobe o emulador; exige Java 17+ e acesso ao download do emulador).
 */
const host = process.env["FIRESTORE_EMULATOR_HOST"];
if (!host) {
  throw new Error("FIRESTORE_EMULATOR_HOST ausente: rode `pnpm test:integration` (ele inicia o emulador).");
}

async function emulatorWorld(signer: Signer): Promise<World> {
  // Cada teste usa uids novos, então os dados de um teste nunca interferem nos de outro.
  const app = makeApp(signer, fetch, { FIRESTORE_BASE_URL: `http://${host}` });
  const { a, b } = await tokensFor(signer);
  return { A: new Client(app, a), B: new Client(app, b) };
}

defineFinanceSuite("finanças (emulador real do Firestore + Security Rules)", emulatorWorld, { fake: false });
