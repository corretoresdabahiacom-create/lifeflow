import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/** Regras da Fase 5: o cliente nunca escreve plano/assinatura/pagamento; só lê o que é dele. Rodam no emulador (CI). */
let env: RulesTestEnvironment;
const NOW = "2026-11-09T12:00:00.000Z";
const sub = (uid: string) => ({ uid, planId: "pro", status: "active", updatedAt: NOW });
const dbOf = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-lifeflow", firestore: { rules: readFileSync(resolve(__dirname, "../firestore.rules"), "utf8") } });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "plans/pro"), { name: "Pro", priceCents: 1490 });
    for (const uid of ["userA", "userB"]) {
      await setDoc(doc(db, `users/${uid}`), { uid });
      await setDoc(doc(db, `subscriptions/${uid}`), sub(uid));
      await setDoc(doc(db, `users/${uid}/billingPayments/pay1`), { uid, amountCents: 1490, status: "approved" });
    }
    await setDoc(doc(db, "webhookEvents/e1"), { status: "processed" });
    await setDoc(doc(db, "adminLogs/l1"), { action: "plans.update" });
  });
});

describe("planos", () => {
  it("usuário autenticado lê os planos; anônimo não; ninguém escreve", async () => {
    await assertSucceeds(getDoc(doc(dbOf("userA"), "plans/pro")));
    await assertSucceeds(getDocs(collection(dbOf("userA"), "plans")));
    await assertFails(getDoc(doc(dbOf(null), "plans/pro")));
    await assertFails(setDoc(doc(dbOf("userA"), "plans/pro"), { name: "Pro", priceCents: 1 }));
    await assertFails(updateDoc(doc(dbOf("userA"), "plans/pro"), { priceCents: 0 }));
    await assertFails(setDoc(doc(dbOf("userA"), "plans/ouro"), { priceCents: 0 }));
    await assertFails(deleteDoc(doc(dbOf("userA"), "plans/pro")));
  });
});

describe("assinatura", () => {
  it("o dono lê a sua; outro usuário, anônimo e listagem são negados", async () => {
    await assertSucceeds(getDoc(doc(dbOf("userA"), "subscriptions/userA")));
    await assertFails(getDoc(doc(dbOf("userA"), "subscriptions/userB")));
    await assertFails(getDoc(doc(dbOf(null), "subscriptions/userA")));
    await assertFails(getDocs(collection(dbOf("userA"), "subscriptions")));
  });
  it("o cliente NÃO consegue forjar, alterar nem apagar a assinatura (nem a própria)", async () => {
    await assertFails(setDoc(doc(dbOf("userA"), "subscriptions/userA"), { ...sub("userA"), planId: "premium_ai" }));
    await assertFails(updateDoc(doc(dbOf("userA"), "subscriptions/userA"), { planId: "premium_ai" }));
    await assertFails(deleteDoc(doc(dbOf("userA"), "subscriptions/userA")));
    await assertFails(setDoc(doc(dbOf("userA"), "subscriptions/userB"), sub("userB")));
    await assertFails(setDoc(doc(dbOf("novo"), "subscriptions/novo"), { ...sub("novo"), status: "active" }));
  });
});

describe("pagamentos, eventos de webhook e auditoria", () => {
  it("o dono lê seus pagamentos; ninguém escreve; outro usuário não lê", async () => {
    await assertSucceeds(getDoc(doc(dbOf("userA"), "users/userA/billingPayments/pay1")));
    await assertSucceeds(getDocs(collection(dbOf("userA"), "users/userA/billingPayments")));
    await assertFails(getDoc(doc(dbOf("userA"), "users/userB/billingPayments/pay1")));
    await assertFails(getDocs(collection(dbOf("userA"), "users/userB/billingPayments")));
    await assertFails(getDoc(doc(dbOf(null), "users/userA/billingPayments/pay1")));
    await assertFails(setDoc(doc(dbOf("userA"), "users/userA/billingPayments/pay2"), { uid: "userA", amountCents: 0, status: "approved" }));
    await assertFails(updateDoc(doc(dbOf("userA"), "users/userA/billingPayments/pay1"), { amountCents: 0 }));
    await assertFails(deleteDoc(doc(dbOf("userA"), "users/userA/billingPayments/pay1")));
  });
  it("webhookEvents e adminLogs: negados a qualquer cliente (inclusive com claim admin)", async () => {
    const admin = env.authenticatedContext("adm", { admin: true }).firestore();
    for (const path of ["webhookEvents/e1", "adminLogs/l1"]) {
      await assertFails(getDoc(doc(dbOf("userA"), path)));
      await assertFails(getDoc(doc(admin, path)));
      await assertFails(setDoc(doc(admin, path), { x: 1 }));
    }
    await assertFails(getDocs(collection(admin, "adminLogs")));
  });
  it("a claim admin NÃO dá acesso ao conteúdo dos usuários", async () => {
    const admin = env.authenticatedContext("adm", { admin: true }).firestore();
    await assertFails(getDoc(doc(admin, "users/userA")));
    await assertFails(getDoc(doc(admin, "users/userA/billingPayments/pay1")));
    await assertFails(getDoc(doc(admin, "subscriptions/userA")));
  });
});
