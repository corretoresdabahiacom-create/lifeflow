import { defineAgendaSuite, type AgendaWorld } from "./agenda.suite";
import { Client, tokensFor } from "./finance.suite";
import { makeApp, type Clock, type Signer } from "./helpers";

/**
 * Mesma suíte da agenda contra o EMULADOR REAL do Firestore, com as Security Rules reais.
 * Execução: `pnpm test:integration` (sobe o emulador).
 */
const host = process.env["FIRESTORE_EMULATOR_HOST"];
if (!host) {
  throw new Error("FIRESTORE_EMULATOR_HOST ausente: rode `pnpm test:integration` (ele inicia o emulador).");
}

async function emulatorWorld(signer: Signer): Promise<AgendaWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const app = makeApp(signer, fetch, { FIRESTORE_BASE_URL: `http://${host}` }, clock);
  const { a, b } = await tokensFor(signer);
  return { clock, A: new Client(app, a), B: new Client(app, b) };
}

defineAgendaSuite("agenda (emulador real do Firestore + Security Rules)", emulatorWorld, { fake: false });
