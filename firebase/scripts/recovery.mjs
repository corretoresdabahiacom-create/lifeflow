// Teste de RECUPERAÇÃO (Fase 6): semeia dados -> exporta o emulador (backup) -> começa de um emulador vazio -> restaura.
// Uso (feito por scripts/recovery-test.sh):  node scripts/recovery.mjs seed|verify|expect-empty
// Fala direto com a API REST do emulador (credencial "owner" ignora as regras: é só o harness de teste).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) throw new Error("FIRESTORE_EMULATOR_HOST ausente: rode via `firebase emulators:exec`.");
const project = "demo-lifeflow";
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const headers = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const EXPECTED = process.env.RECOVERY_EXPECTED ?? ".recovery-expected.json";

const enc = (v) => (typeof v === "number" ? { integerValue: String(v) } : typeof v === "boolean" ? { booleanValue: v } : { stringValue: String(v) });
const fieldsOf = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));
const dec = (f) => Object.fromEntries(Object.entries(f ?? {}).map(([k, v]) => [k, v.integerValue !== undefined ? Number(v.integerValue) : v.booleanValue ?? v.stringValue]));

async function put(path, data) {
  const r = await fetch(`${base}/${path}`, { method: "PATCH", headers, body: JSON.stringify({ fields: fieldsOf(data) }) });
  if (!r.ok) throw new Error(`PATCH ${path} -> ${r.status} ${await r.text()}`);
}
async function get(path) {
  const r = await fetch(`${base}/${path}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return dec((await r.json()).fields);
}
async function collectionIds(path) {
  const r = await fetch(`${base}/${path}:listCollectionIds`, { method: "POST", headers, body: "{}" });
  if (!r.ok) throw new Error(`listCollectionIds ${path} -> ${r.status}`);
  return ((await r.json()).collectionIds ?? []).sort();
}

function dataset() {
  const docs = {};
  for (const uid of ["userA", "userB"]) {
    docs[`users/${uid}`] = { uid, displayName: `Nome ${uid}`, currency: "BRL" };
    for (let i = 1; i <= 12; i += 1) {
      docs[`users/${uid}/transactions/t${i}`] = { uid, description: `Lançamento ${i}`, amountCents: i * 1234, status: "posted", date: `2026-11-${String(i).padStart(2, "0")}` };
    }
    docs[`users/${uid}/accounts/acc1`] = { uid, name: "Conta", balanceCents: 987654 };
    docs[`users/${uid}/aiConversations/c1`] = { uid, title: "Conversa" };
    docs[`users/${uid}/aiConversations/c1/messages/m1`] = { role: "user", content: "oi" };
    docs[`users/${uid}/billingPayments/p1`] = { uid, amountCents: 1490, status: "approved" };
  }
  docs["plans/pro"] = { name: "Pro", priceCents: 1490, active: true };
  docs["subscriptions/userA"] = { uid: "userA", planId: "pro", status: "active" };
  return docs;
}
// Serialização canônica (chaves ordenadas): o Firestore devolve os campos em ordem alfabética.
const canon = (v) => (v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const digest = (docs) => createHash("sha256").update(canon(docs)).digest("hex");

async function snapshot(paths) {
  const out = {};
  for (const path of paths) out[path] = await get(path);
  return out;
}

const mode = process.argv[2];
if (mode === "seed") {
  const docs = dataset();
  for (const [path, data] of Object.entries(docs)) await put(path, data);
  writeFileSync(EXPECTED, JSON.stringify({ digest: digest(docs), paths: Object.keys(docs), subcollections: { "users/userA": await collectionIds("users/userA") } }));
  console.log(`semeados ${Object.keys(docs).length} documentos (digest ${digest(docs).slice(0, 12)})`);
} else if (mode === "expect-empty") {
  const { paths } = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const found = Object.values(await snapshot(paths)).filter(Boolean).length;
  if (found !== 0) throw new Error(`esperava emulador vazio, mas ${found} documentos existem`);
  console.log("emulador vazio, como esperado (sem backup, nada existe)");
} else if (mode === "verify") {
  const expected = JSON.parse(readFileSync(EXPECTED, "utf8"));
  const restored = await snapshot(expected.paths);
  const missing = Object.entries(restored).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) throw new Error(`restauração incompleta, faltam: ${missing.slice(0, 5).join(", ")} (${missing.length})`);
  if (digest(restored) !== expected.digest) throw new Error("restauração com conteúdo diferente do original (digest não confere)");
  const ids = await collectionIds("users/userA");
  if (JSON.stringify(ids) !== JSON.stringify(expected.subcollections["users/userA"])) throw new Error(`subcoleções diferentes: ${ids}`);
  console.log(`restaurados ${expected.paths.length} documentos, conteúdo idêntico (digest ${expected.digest.slice(0, 12)})`);
} else {
  throw new Error("modo desconhecido: use seed | verify | expect-empty");
}
