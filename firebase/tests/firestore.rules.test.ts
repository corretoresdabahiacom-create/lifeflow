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

let env: RulesTestEnvironment;

const NOW = "2026-11-09T12:00:00.000Z";

const profileFor = (uid: string) => ({
  uid,
  displayName: `Usuário ${uid}`,
  locale: "pt-BR",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
  createdAt: NOW,
  updatedAt: NOW,
});

const prefsFor = (uid: string) => ({
  uid,
  theme: "dark",
  confirmCreations: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  updatedAt: NOW,
});

const dbOf = (uid: string | null) =>
  uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();

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
  // Dados de A e B criados com as regras desligadas (preparação do cenário).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/userA"), profileFor("userA"));
    await setDoc(doc(db, "users/userB"), profileFor("userB"));
    await setDoc(doc(db, "users/userA/preferences/app"), prefsFor("userA"));
    await setDoc(doc(db, "users/userB/preferences/app"), prefsFor("userB"));
  });
});

describe("sem autenticação", () => {
  it("não lê perfil nem preferências", async () => {
    const db = dbOf(null);
    await assertFails(getDoc(doc(db, "users/userA")));
    await assertFails(getDoc(doc(db, "users/userA/preferences/app")));
  });

  it("não cria nem altera dados", async () => {
    const db = dbOf(null);
    await assertFails(setDoc(doc(db, "users/userC"), profileFor("userC")));
    await assertFails(updateDoc(doc(db, "users/userA"), { displayName: "x" }));
  });
});

describe("usuário A com seus próprios dados", () => {
  it("lê seu perfil e suas preferências", async () => {
    const db = dbOf("userA");
    await assertSucceeds(getDoc(doc(db, "users/userA")));
    await assertSucceeds(getDoc(doc(db, "users/userA/preferences/app")));
    await assertSucceeds(getDocs(collection(db, "users/userA/preferences")));
  });

  it("cria o próprio perfil", async () => {
    await env.clearFirestore();
    await assertSucceeds(setDoc(doc(dbOf("userA"), "users/userA"), profileFor("userA")));
  });

  it("atualiza o próprio perfil mantendo uid e createdAt", async () => {
    await assertSucceeds(
      setDoc(doc(dbOf("userA"), "users/userA"), { ...profileFor("userA"), displayName: "Novo nome" }),
    );
  });

  it("exclui as próprias preferências", async () => {
    await assertSucceeds(deleteDoc(doc(dbOf("userA"), "users/userA/preferences/app")));
  });
});

describe("usuário A contra os dados do usuário B", () => {
  it("não consulta o perfil de B", async () => {
    await assertFails(getDoc(doc(dbOf("userA"), "users/userB")));
  });

  it("não consulta as preferências de B (get e list)", async () => {
    const db = dbOf("userA");
    await assertFails(getDoc(doc(db, "users/userB/preferences/app")));
    await assertFails(getDocs(collection(db, "users/userB/preferences")));
  });

  it("não lista a coleção de usuários", async () => {
    await assertFails(getDocs(collection(dbOf("userA"), "users")));
  });

  it("não altera o perfil de B", async () => {
    const db = dbOf("userA");
    await assertFails(updateDoc(doc(db, "users/userB"), { displayName: "invadido" }));
    await assertFails(setDoc(doc(db, "users/userB"), { ...profileFor("userB"), displayName: "invadido" }));
  });

  it("não altera as preferências de B", async () => {
    const db = dbOf("userA");
    await assertFails(updateDoc(doc(db, "users/userB/preferences/app"), { theme: "light" }));
    await assertFails(setDoc(doc(db, "users/userB/preferences/app"), prefsFor("userB")));
  });

  it("não exclui dados de B", async () => {
    const db = dbOf("userA");
    await assertFails(deleteDoc(doc(db, "users/userB")));
    await assertFails(deleteDoc(doc(db, "users/userB/preferences/app")));
  });

  it("não cria registros dentro do espaço de B", async () => {
    await assertFails(setDoc(doc(dbOf("userA"), "users/userB/preferences/app"), prefsFor("userA")));
  });
});

describe("alteração manual do uid", () => {
  it("não cria documento em users/A com uid de B", async () => {
    await env.clearFirestore();
    await assertFails(setDoc(doc(dbOf("userA"), "users/userA"), { ...profileFor("userA"), uid: "userB" }));
  });

  it("não troca o uid de um documento existente de A para B", async () => {
    await assertFails(setDoc(doc(dbOf("userA"), "users/userA"), { ...profileFor("userA"), uid: "userB" }));
    await assertFails(updateDoc(doc(dbOf("userA"), "users/userA/preferences/app"), { uid: "userB" }));
  });

  it("não cria preferências de A com uid de B", async () => {
    await env.clearFirestore();
    await assertFails(
      setDoc(doc(dbOf("userA"), "users/userA/preferences/app"), { ...prefsFor("userA"), uid: "userB" }),
    );
  });
});

describe("validação de dados e negação por padrão", () => {
  it("rejeita campos desconhecidos e tipos inválidos", async () => {
    const db = dbOf("userA");
    await assertFails(setDoc(doc(db, "users/userA"), { ...profileFor("userA"), isAdmin: true }));
    await assertFails(setDoc(doc(db, "users/userA"), { ...profileFor("userA"), currency: "real" }));
    await assertFails(setDoc(doc(db, "users/userA/preferences/app"), { ...prefsFor("userA"), theme: "neon" }));
    await assertFails(setDoc(doc(db, "users/userA/preferences/outra"), prefsFor("userA")));
  });

  it("não permite o dono excluir o próprio perfil pelo cliente", async () => {
    await assertFails(deleteDoc(doc(dbOf("userA"), "users/userA")));
  });

  it("nega coleções não declaradas", async () => {
    const db = dbOf("userA");
    // "accounts" passou a existir na Fase 2; usa-se uma coleção que continua não declarada.
    await assertFails(getDoc(doc(db, "users/userA/subscriptions/x")));
    await assertFails(setDoc(doc(db, "plans/free"), { price: 0 }));
    await assertFails(getDoc(doc(db, "plans/free")));
  });
});
