import { defineAgendaSuite, type AgendaWorld } from "./agenda.suite";
import { Client } from "./finance.suite";
import { makeApp, type Clock, type Signer } from "./helpers";
import { createStackUser, stackEnv } from "./stack";

async function stackWorld(_signer: Signer): Promise<AgendaWorld> {
  const clock: Clock = { now: new Date("2026-11-09T12:00:00.000Z") };
  const app = makeApp(null, fetch, stackEnv, clock);
  const [a, b] = await Promise.all([createStackUser("userA"), createStackUser("userB")]);
  return { clock, A: new Client(app, a.token), B: new Client(app, b.token) };
}

defineAgendaSuite("agenda (Supabase real: GoTrue + PostgREST + RLS)", stackWorld, { fake: false });
