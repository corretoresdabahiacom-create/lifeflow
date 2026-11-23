import { defineFinanceSuite, Client, tokensFor, type World } from "./finance.suite";
import { fakeSupabase, makeApp } from "./helpers";
import type { Signer } from "./helpers";

async function fakeWorld(signer: Signer): Promise<World> {
  const fake = await fakeSupabase();
  const app = makeApp(signer, ((input: RequestInfo | URL, init?: RequestInit) => fake.fetchImpl(input, init)) as typeof fetch);
  const { a, b } = await tokensFor(signer);
  return { fake, A: new Client(app, a), B: new Client(app, b) };
}

defineFinanceSuite("finanças (Supabase local (Postgres real em PGlite))", fakeWorld, { fake: true });
