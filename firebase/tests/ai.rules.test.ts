import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/**
 * Regras do assistente de IA (Fase 4): isolamento, formato, imutabilidade de parâmetros e da
 * trilha de auditoria, contadores que só crescem. Rodam no emulador (CI).
 */

let env: RulesTestEnvironment;
const NOW = "2026-11-09T12:00:00.000Z";
const HASH = "a".repeat(64);

const conversation = (uid: string, over: Record<string, unknown> = {}) => ({ uid, title: "Almoço", createdAt: NOW, updatedAt: NOW, ...over });
const message = (uid: string, over: Record<string, unknown> = {}) => ({ uid, conversationId: "conv1", role: "user", content: "oi", createdAt: NOW, ...over });
const action = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  conversationId: "conv1",
  messageId: "msg1",
  tool: "create_transaction",
  kind: "create",
  financial: true,
  argsJson: "{\"amountCents\":5000}",
  argsHash: HASH,
  summary: "Registrar despesa de R$ 50,00",
  amountCents: 5000,
  reinforced: false,
  status: "pending",
  resultNote: null,
  expiresAt: "2026-11-09T12:15:00.000Z",
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const log = (uid: string, over: Record<string, unknown> = {}) => ({
  uid, event: "proposed", tool: "create_transaction", actionId: "act1", argsHash: HASH, detail: "ok", conversationId: "conv1", createdAt: NOW, ...over,
});
const aiSettings = (uid: string, over: Record<string, unknown> = {}) => ({
  uid, autoActionsPerDay: 20, autoValueLimitCents: 100000, confirmAboveCents: 50000, updatedAt: NOW, ...over,
});

const dbOf = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const A = (path: string) => doc(dbOf("userA"), `users/userA/${path}`);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-lifeflow",
    firestore: { rules: readFileSync(resolve(__dirname, "../firestore.rules"), "utf8") },
  });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const uid of ["userA", "userB"]) {
      await setDoc(doc(db, `users/${uid}`), { uid });
      await setDoc(doc(db, `users/${uid}/aiConversations/conv1`), conversation(uid));
      await setDoc(doc(db, `users/${uid}/aiConversations/conv1/messages/msg1`), message(uid));
      await setDoc(doc(db, `users/${uid}/aiActions/act1`), action(uid));
      await setDoc(doc(db, `users/${uid}/aiActions/act2`), action(uid, { status: "done" }));
      await setDoc(doc(db, `users/${uid}/aiLogs/log1`), log(uid));
      await setDoc(doc(db, `users/${uid}/aiUsage/2026-11`), { uid, messages: 5, voiceSeconds: 10, updatedAt: NOW });
      await setDoc(doc(db, `users/${uid}/aiDaily/2026-11-09`), { uid, autoActions: 2, autoValueCents: 1000, updatedAt: NOW });
      await setDoc(doc(db, `users/${uid}/consents/audio`), { uid, granted: true, updatedAt: NOW });
    }
  });
});

const PATHS = ["aiConversations/conv1", "aiConversations/conv1/messages/msg1", "aiActions/act1", "aiLogs/log1", "aiUsage/2026-11", "aiDaily/2026-11-09", "consents/audio"];

describe("IA: sem autenticação e isolamento", () => {
  for (const path of PATHS) {
    it(`${path}: anônimo não lê; A não lê nem altera dados de B`, async () => {
      await assertFails(getDoc(doc(dbOf(null), `users/userA/${path}`)));
      await assertFails(getDoc(doc(dbOf("userA"), `users/userB/${path}`)));
      await assertFails(setDoc(doc(dbOf("userA"), `users/userB/${path}`), { uid: "userB" }));
      await assertSucceeds(getDoc(A(path)));
    });
  }
  it("A não lista coleções de B", async () => {
    for (const name of ["aiConversations", "aiActions", "aiLogs", "aiUsage", "aiDaily"]) {
      await assertFails(getDocs(collection(dbOf("userA"), `users/userB/${name}`)));
      await assertSucceeds(getDocs(collection(dbOf("userA"), `users/userA/${name}`)));
    }
  });
});

describe("IA: conversas e mensagens", () => {
  it("cria conversa válida; recusa uid de outro, título vazio e campo extra", async () => {
    await assertSucceeds(setDoc(A("aiConversations/nova"), conversation("userA")));
    await assertFails(setDoc(A("aiConversations/n2"), conversation("userB")));
    await assertFails(setDoc(A("aiConversations/n3"), conversation("userA", { title: "" })));
    await assertFails(setDoc(A("aiConversations/n4"), conversation("userA", { extra: 1 })));
  });
  it("só avança updatedAt; não troca título nem uid", async () => {
    await assertSucceeds(updateDoc(A("aiConversations/conv1"), { updatedAt: "2026-11-09T13:00:00.000Z" }));
    await assertFails(updateDoc(A("aiConversations/conv1"), { title: "outro" }));
    await assertFails(updateDoc(A("aiConversations/conv1"), { uid: "userB" }));
  });
  it("mensagens são imutáveis e validam papel/conteúdo; o dono pode apagar", async () => {
    await assertSucceeds(setDoc(A("aiConversations/conv1/messages/m2"), message("userA", { role: "assistant" })));
    await assertFails(setDoc(A("aiConversations/conv1/messages/m3"), message("userA", { role: "system" })));
    await assertFails(setDoc(A("aiConversations/conv1/messages/m4"), message("userA", { conversationId: "outra" })));
    await assertFails(setDoc(A("aiConversations/conv1/messages/m5"), message("userA", { content: "" })));
    await assertFails(updateDoc(A("aiConversations/conv1/messages/msg1"), { content: "adulterado" }));
    await assertSucceeds(deleteDoc(A("aiConversations/conv1/messages/msg1")));
    await assertSucceeds(deleteDoc(A("aiConversations/conv1")));
  });
});

describe("IA: ações propostas", () => {
  it("nasce pendente e válida; recusa status diferente de pending, ferramenta vazia e campo extra", async () => {
    await assertSucceeds(setDoc(A("aiActions/nova"), action("userA")));
    await assertFails(setDoc(A("aiActions/n2"), action("userA", { status: "done" })));
    await assertFails(setDoc(A("aiActions/n3"), action("userA", { tool: "" })));
    await assertFails(setDoc(A("aiActions/n4"), action("userA", { extra: true })));
    await assertFails(setDoc(A("aiActions/n5"), action("userA", { uid: "userB" })));
    await assertFails(setDoc(A("aiActions/n6"), action("userA", { argsHash: "curto" })));
    await assertFails(setDoc(A("aiActions/n7"), action("userA", { kind: "drop" })));
  });
  it("só status/resultNote/updatedAt mudam; parâmetros e resumo são imutáveis", async () => {
    await assertFails(updateDoc(A("aiActions/act1"), { argsJson: "{\"amountCents\":1}", updatedAt: NOW }));
    await assertFails(updateDoc(A("aiActions/act1"), { summary: "outro", updatedAt: NOW }));
    await assertFails(updateDoc(A("aiActions/act1"), { amountCents: 1, updatedAt: NOW }));
    await assertSucceeds(updateDoc(A("aiActions/act1"), { status: "executing", updatedAt: NOW }));
    await assertSucceeds(updateDoc(A("aiActions/act1"), { status: "done", resultNote: "ok", updatedAt: NOW }));
  });
  it("estado terminal não muda mais; não há exclusão", async () => {
    await assertFails(updateDoc(A("aiActions/act2"), { status: "pending", updatedAt: NOW }));
    await assertFails(updateDoc(A("aiActions/act2"), { status: "failed", updatedAt: NOW }));
    await assertFails(deleteDoc(A("aiActions/act1")));
  });
  it("de executing só vai para done/failed/blocked", async () => {
    await assertSucceeds(updateDoc(A("aiActions/act1"), { status: "executing", updatedAt: NOW }));
    await assertFails(updateDoc(A("aiActions/act1"), { status: "rejected", updatedAt: NOW }));
    await assertSucceeds(updateDoc(A("aiActions/act1"), { status: "failed", updatedAt: NOW }));
  });
});

describe("IA: trilha de auditoria", () => {
  it("só cria (evento válido); nunca altera nem apaga", async () => {
    await assertSucceeds(setDoc(A("aiLogs/novo"), log("userA")));
    await assertFails(setDoc(A("aiLogs/n2"), log("userA", { event: "hackeado" })));
    await assertFails(setDoc(A("aiLogs/n3"), log("userB")));
    await assertFails(setDoc(A("aiLogs/n4"), log("userA", { detail: "x".repeat(301) })));
    await assertFails(updateDoc(A("aiLogs/log1"), { detail: "apagado" }));
    await assertFails(deleteDoc(A("aiLogs/log1")));
  });
});

describe("IA: consumo, automação diária e consentimento", () => {
  it("contadores só crescem e não podem ser apagados", async () => {
    await assertSucceeds(updateDoc(A("aiUsage/2026-11"), { messages: 6, updatedAt: NOW }));
    await assertFails(updateDoc(A("aiUsage/2026-11"), { messages: 1, updatedAt: NOW }));
    await assertFails(updateDoc(A("aiUsage/2026-11"), { voiceSeconds: 0, updatedAt: NOW }));
    await assertFails(setDoc(A("aiUsage/novembro"), { uid: "userA", messages: 1, updatedAt: NOW }));
    await assertFails(deleteDoc(A("aiUsage/2026-11")));
    await assertSucceeds(updateDoc(A("aiDaily/2026-11-09"), { autoActions: 3, autoValueCents: 2000, updatedAt: NOW }));
    await assertFails(updateDoc(A("aiDaily/2026-11-09"), { autoActions: 0, updatedAt: NOW }));
    await assertFails(deleteDoc(A("aiDaily/2026-11-09")));
  });
  it("configurações de automação validam limites; consentimento só 'audio'", async () => {
    await assertSucceeds(setDoc(A("preferences/ai"), aiSettings("userA")));
    await assertFails(setDoc(A("preferences/ai"), aiSettings("userA", { autoActionsPerDay: -1 })));
    await assertFails(setDoc(A("preferences/ai"), aiSettings("userA", { autoValueLimitCents: 1.5 })));
    await assertFails(setDoc(A("preferences/ai"), aiSettings("userB")));
    await assertSucceeds(setDoc(A("consents/audio"), { uid: "userA", granted: false, updatedAt: NOW }));
    await assertFails(setDoc(A("consents/outro"), { uid: "userA", granted: true, updatedAt: NOW }));
    await assertFails(setDoc(A("consents/audio"), { uid: "userA", granted: "sim", updatedAt: NOW }));
    await assertFails(deleteDoc(A("consents/audio")));
  });
});
