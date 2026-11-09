import { defineFinanceSuite, Client, tokensFor, type World } from "./finance.suite";
import { fakeFirestore, makeApp } from "./helpers";
import type { Signer } from "./helpers";

async function fakeWorld(signer: Signer): Promise<World> {
  const fake = fakeFirestore();
  const app = makeApp(signer, ((input: RequestInfo | URL, init?: RequestInit) => fake.fetchImpl(input, init)) as typeof fetch);
  const { a, b } = await tokensFor(signer);
  return { fake, A: new Client(app, a), B: new Client(app, b) };
}

defineFinanceSuite("finanças (Firestore falso em memória)", fakeWorld, { fake: true });
