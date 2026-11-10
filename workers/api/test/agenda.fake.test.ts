import { defineAgendaSuite, type AgendaWorld } from "./agenda.suite";
import { Client, tokensFor } from "./finance.suite";
import { fakeFirestore, makeApp, type Clock, type Signer } from "./helpers";

async function fakeWorld(signer: Signer): Promise<AgendaWorld> {
  const fake = fakeFirestore();
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const app = makeApp(signer, ((input: RequestInfo | URL, init?: RequestInit) => fake.fetchImpl(input, init)) as typeof fetch, {}, clock);
  const { a, b } = await tokensFor(signer);
  return { fake, clock, A: new Client(app, a), B: new Client(app, b) };
}

defineAgendaSuite("agenda (Firestore falso em memória)", fakeWorld, { fake: true });
