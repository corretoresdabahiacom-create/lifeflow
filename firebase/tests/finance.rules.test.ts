import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, increment, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regras do módulo financeiro (Fase 2): isolamento entre usuários, formato dos documentos,
 * imutabilidade e ausência de exclusão. Rodam no emulador do Firestore.
 */

let env: RulesTestEnvironment;
const NOW = "2026-11-09T12:00:00.000Z";
const COLLECTIONS = ["accounts", "categories", "transactions", "transfers", "payables", "recurring"] as const;

const account = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  name: "Corrente",
  type: "checking",
  initialBalanceCents: 10_000,
  balanceCents: 10_000,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  requestHash: "h",
  ...over,
});
const category = (uid: string, over: Record<string, unknown> = {}) => ({
  uid, name: "Mercado", kind: "expense", archived: false, createdAt: NOW, updatedAt: NOW, requestHash: "h", ...over,
});
const transaction = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  accountId: "acc1",
  type: "expense",
  amountCents: 1000,
  signedCents: -1000,
  date: "2026-11-09",
  categoryId: null,
  description: "Mercado",
  notes: null,
  status: "posted",
  transferId: null,
  payableId: null,
  createdAt: NOW,
  updatedAt: NOW,
  voidedAt: null,
  requestHash: "h",
  ...over,
});
const transfer = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  fromAccountId: "acc1",
  toAccountId: "acc2",
  amountCents: 500,
  date: "2026-11-09",
  description: null,
  status: "posted",
  outTransactionId: "t1_out",
  inTransactionId: "t1_in",
  createdAt: NOW,
  updatedAt: NOW,
  voidedAt: null,
  requestHash: "h",
  ...over,
});
const payable = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  kind: "payable",
  description: "Energia",
  amountCents: 15_000,
  dueDate: "2026-11-20",
  accountId: null,
  categoryId: null,
  status: "open",
  paidDate: null,
  paidAmountCents: null,
  transactionId: null,
  payCount: 0,
  recurringId: null,
  createdAt: NOW,
  updatedAt: NOW,
  requestHash: "h",
  payRequestHash: null,
  ...over,
});
const recurring = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  kind: "payable",
  description: "Aluguel",
  amountCents: 100_000,
  frequency: "monthly",
  startDate: "2026-11-10",
  endDate: null,
  accountId: null,
  categoryId: null,
  active: true,
  lastMaterializedThrough: null,
  createdAt: NOW,
  updatedAt: NOW,
  requestHash: "h",
  ...over,
});

const FACTORY = { accounts: account, categories: category, transactions: transaction, transfers: transfer, payables: payable, recurring } as const;
const dbOf = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const ref = (db: ReturnType<typeof dbOf>, path: string) => doc(db, path);

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
      await setDoc(doc(db, `users/${uid}/accounts/acc1`), account(uid));
      await setDoc(doc(db, `users/${uid}/accounts/acc2`), account(uid, { name: "Poupança", type: "savings" }));
      await setDoc(doc(db, `users/${uid}/categories/cat1`), category(uid));
      await setDoc(doc(db, `users/${uid}/transactions/tx1`), transaction(uid));
      await setDoc(doc(db, `users/${uid}/transfers/tr1`), transfer(uid));
      await setDoc(doc(db, `users/${uid}/payables/pay1`), payable(uid));
      await setDoc(doc(db, `users/${uid}/recurring/rec1`), recurring(uid));
    }
  });
});

const SEEDED = { accounts: "acc1", categories: "cat1", transactions: "tx1", transfers: "tr1", payables: "pay1", recurring: "rec1" } as const;

describe("finanças: sem autenticação", () => {
  for (const name of COLLECTIONS) {
    it(`${name}: não lê, não lista, não cria`, async () => {
      const db = dbOf(null);
      await assertFails(getDoc(ref(db, `users/userA/${name}/${SEEDED[name]}`)));
      await assertFails(getDocs(collection(db, `users/userA/${name}`)));
      await assertFails(setDoc(ref(db, `users/userA/${name}/novo`), FACTORY[name]("userA")));
    });
  }
});

describe("finanças: isolamento entre usuários (A contra B)", () => {
  for (const name of COLLECTIONS) {
    it(`${name}: A não lê, lista, cria, altera nem exclui dados de B`, async () => {
      const a = dbOf("userA");
      await assertFails(getDoc(ref(a, `users/userB/${name}/${SEEDED[name]}`)));
      await assertFails(getDocs(collection(a, `users/userB/${name}`)));
      await assertFails(setDoc(ref(a, `users/userB/${name}/novo`), FACTORY[name]("userA")));
      await assertFails(setDoc(ref(a, `users/userB/${name}/novo`), FACTORY[name]("userB")));
      await assertFails(updateDoc(ref(a, `users/userB/${name}/${SEEDED[name]}`), { updatedAt: "x" }));
      await assertFails(deleteDoc(ref(a, `users/userB/${name}/${SEEDED[name]}`)));
    });

    it(`${name}: o dono lê e lista os próprios dados`, async () => {
      const a = dbOf("userA");
      await assertSucceeds(getDoc(ref(a, `users/userA/${name}/${SEEDED[name]}`)));
      await assertSucceeds(getDocs(collection(a, `users/userA/${name}`)));
    });

    it(`${name}: ninguém exclui (nem o dono)`, async () => {
      await assertFails(deleteDoc(ref(dbOf("userA"), `users/userA/${name}/${SEEDED[name]}`)));
    });

    it(`${name}: troca manual do uid no documento é negada`, async () => {
      await assertFails(setDoc(ref(dbOf("userA"), `users/userA/${name}/novo`), FACTORY[name]("userB")));
    });

    it(`${name}: campo desconhecido e id de documento inválido são negados`, async () => {
      const a = dbOf("userA");
      await assertFails(setDoc(ref(a, `users/userA/${name}/novo`), { ...FACTORY[name]("userA"), extra: 1 }));
      await assertFails(setDoc(ref(a, `users/userA/${name}/id com espaço`), FACTORY[name]("userA")));
    });
  }
});

describe("finanças: contas", () => {
  it("cria conta válida, com saldo inicial igual ao saldo atual", async () => {
    await assertSucceeds(setDoc(ref(dbOf("userA"), "users/userA/accounts/nova"), account("userA")));
    await assertSucceeds(setDoc(ref(dbOf("userA"), "users/userA/accounts/cartao"), account("userA", { type: "credit_card", initialBalanceCents: -5000, balanceCents: -5000 })));
  });
  it("nega saldo diferente do inicial na criação, valor decimal, tipo inválido e conta já arquivada", async () => {
    const a = dbOf("userA");
    await assertFails(setDoc(ref(a, "users/userA/accounts/n1"), account("userA", { balanceCents: 99 })));
    await assertFails(setDoc(ref(a, "users/userA/accounts/n2"), account("userA", { initialBalanceCents: 10.5, balanceCents: 10.5 })));
    await assertFails(setDoc(ref(a, "users/userA/accounts/n3"), account("userA", { type: "poupanca" })));
    await assertFails(setDoc(ref(a, "users/userA/accounts/n4"), account("userA", { archived: true })));
    await assertFails(setDoc(ref(a, "users/userA/accounts/n5"), account("userA", { name: "" })));
    await assertFails(setDoc(ref(a, "users/userA/accounts/n6"), account("userA", { initialBalanceCents: 1e12, balanceCents: 1e12 })));
  });
  it("permite renomear, arquivar e ajustar o saldo por incremento; nega mudar campos imutáveis", async () => {
    const a = dbOf("userA");
    const path = "users/userA/accounts/acc1";
    await assertSucceeds(updateDoc(ref(a, path), { name: "Nova", archived: true, updatedAt: "2026-11-10T00:00:00Z" }));
    await assertSucceeds(updateDoc(ref(a, path), { balanceCents: increment(-2500), updatedAt: "2026-11-10T00:00:00Z" }));
    await assertFails(updateDoc(ref(a, path), { uid: "userB" }));
    await assertFails(updateDoc(ref(a, path), { type: "cash" }));
    await assertFails(updateDoc(ref(a, path), { initialBalanceCents: 1 }));
    await assertFails(updateDoc(ref(a, path), { requestHash: "outro" }));
    await assertFails(updateDoc(ref(a, path), { balanceCents: 1.5 }));
  });
});

describe("finanças: categorias", () => {
  it("cria válida; nega tipo inválido; nega mudar o tipo depois", async () => {
    const a = dbOf("userA");
    await assertSucceeds(setDoc(ref(a, "users/userA/categories/nova"), category("userA", { kind: "income" })));
    await assertFails(setDoc(ref(a, "users/userA/categories/x"), category("userA", { kind: "outro" })));
    await assertSucceeds(updateDoc(ref(a, "users/userA/categories/cat1"), { archived: true, updatedAt: "y" }));
    await assertFails(updateDoc(ref(a, "users/userA/categories/cat1"), { kind: "income" }));
  });
});

describe("finanças: lançamentos (livro-razão)", () => {
  const a = () => dbOf("userA");
  it("cria lançamento válido para conta existente", async () => {
    await assertSucceeds(setDoc(ref(a(), "users/userA/transactions/novo"), transaction("userA")));
    await assertSucceeds(
      setDoc(ref(a(), "users/userA/transactions/receita"), transaction("userA", { type: "income", signedCents: 1000 })),
    );
  });
  it("nega conta inexistente, valor decimal/zero, sinal inconsistente e status inicial 'voided'", async () => {
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n1"), transaction("userA", { accountId: "nao_existe" })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n2"), transaction("userA", { amountCents: 10.5, signedCents: -10.5 })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n3"), transaction("userA", { amountCents: 0, signedCents: 0 })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n4"), transaction("userA", { signedCents: 1000 })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n5"), transaction("userA", { status: "voided", voidedAt: NOW })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n6"), transaction("userA", { date: "09/11/2026" })));
    await assertFails(setDoc(ref(a(), "users/userA/transactions/n7"), transaction("userA", { type: "outro" })));
  });
  it("permite estornar (posted -> voided) e editar metadados", async () => {
    const path = "users/userA/transactions/tx1";
    await assertSucceeds(updateDoc(ref(a(), path), { description: "Supermercado", notes: "n", updatedAt: "z" }));
    await assertSucceeds(updateDoc(ref(a(), path), { status: "voided", voidedAt: "2026-11-10T00:00:00Z", updatedAt: "z" }));
  });
  it("nega alterar valor, conta, tipo, data, sinal; nega editar estornado; nega 'desestornar'", async () => {
    const path = "users/userA/transactions/tx1";
    await assertFails(updateDoc(ref(a(), path), { amountCents: 1, signedCents: -1 }));
    await assertFails(updateDoc(ref(a(), path), { accountId: "acc2" }));
    await assertFails(updateDoc(ref(a(), path), { type: "income", signedCents: 1000 }));
    await assertFails(updateDoc(ref(a(), path), { date: "2026-01-01" }));
    await assertFails(updateDoc(ref(a(), path), { status: "voided" })); // sem voidedAt
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), path), { status: "voided", voidedAt: NOW });
    });
    await assertFails(updateDoc(ref(a(), path), { description: "tarde demais" }));
    await assertFails(updateDoc(ref(a(), path), { status: "posted", voidedAt: null }));
  });
});

describe("finanças: transferências", () => {
  const a = () => dbOf("userA");
  it("cria válida entre contas existentes; nega origem = destino, conta inexistente e valor inválido", async () => {
    await assertSucceeds(setDoc(ref(a(), "users/userA/transfers/novo"), transfer("userA")));
    await assertFails(setDoc(ref(a(), "users/userA/transfers/n1"), transfer("userA", { toAccountId: "acc1" })));
    await assertFails(setDoc(ref(a(), "users/userA/transfers/n2"), transfer("userA", { toAccountId: "fantasma" })));
    await assertFails(setDoc(ref(a(), "users/userA/transfers/n3"), transfer("userA", { amountCents: -5 })));
    await assertFails(setDoc(ref(a(), "users/userA/transfers/n4"), transfer("userA", { status: "voided", voidedAt: NOW })));
  });
  it("só permite estornar; nega alterar valor ou contas", async () => {
    const path = "users/userA/transfers/tr1";
    await assertFails(updateDoc(ref(a(), path), { amountCents: 1 }));
    await assertFails(updateDoc(ref(a(), path), { toAccountId: "acc1" }));
    await assertSucceeds(updateDoc(ref(a(), path), { status: "voided", voidedAt: NOW, updatedAt: NOW }));
  });
});

describe("finanças: contas a pagar/receber", () => {
  const a = () => dbOf("userA");
  it("cria em aberto; nega criar já paga ou com payCount > 0", async () => {
    await assertSucceeds(setDoc(ref(a(), "users/userA/payables/novo"), payable("userA")));
    await assertFails(
      setDoc(ref(a(), "users/userA/payables/n1"), payable("userA", { status: "paid", paidDate: "2026-11-09", paidAmountCents: 1, transactionId: "t" })),
    );
    await assertFails(setDoc(ref(a(), "users/userA/payables/n2"), payable("userA", { payCount: 3 })));
    await assertFails(setDoc(ref(a(), "users/userA/payables/n3"), payable("userA", { amountCents: 0 })));
    await assertFails(setDoc(ref(a(), "users/userA/payables/n4"), payable("userA", { kind: "outro" })));
  });
  it("baixa exige data, valor e lançamento; reabrir exige limpar tudo; nega mudar o tipo", async () => {
    const path = "users/userA/payables/pay1";
    await assertFails(updateDoc(ref(a(), path), { status: "paid" })); // incompleta
    await assertFails(updateDoc(ref(a(), path), { status: "paid", paidDate: "2026-11-09", paidAmountCents: 15_000, transactionId: null }));
    await assertSucceeds(
      updateDoc(ref(a(), path), { status: "paid", paidDate: "2026-11-09", paidAmountCents: 15_000, transactionId: "pay_pay1_1", payCount: 1, payRequestHash: "f", updatedAt: NOW }),
    );
    await assertFails(updateDoc(ref(a(), path), { status: "open" })); // sobrou data/valor da baixa
    await assertSucceeds(
      updateDoc(ref(a(), path), { status: "open", paidDate: null, paidAmountCents: null, transactionId: null, payRequestHash: null, updatedAt: NOW }),
    );
    await assertFails(updateDoc(ref(a(), path), { kind: "receivable" }));
    await assertFails(updateDoc(ref(a(), path), { recurringId: "x" }));
  });
});

describe("finanças: recorrências", () => {
  const a = () => dbOf("userA");
  it("cria válida; nega frequência inválida e geração já marcada", async () => {
    await assertSucceeds(setDoc(ref(a(), "users/userA/recurring/novo"), recurring("userA")));
    await assertFails(setDoc(ref(a(), "users/userA/recurring/n1"), recurring("userA", { frequency: "diaria" })));
    await assertFails(setDoc(ref(a(), "users/userA/recurring/n2"), recurring("userA", { lastMaterializedThrough: "2026-12-10" })));
    await assertFails(setDoc(ref(a(), "users/userA/recurring/n3"), recurring("userA", { endDate: "10/12/2026" })));
  });
  it("permite pausar e avançar a geração; nega mudar frequência, início e tipo", async () => {
    const path = "users/userA/recurring/rec1";
    await assertSucceeds(updateDoc(ref(a(), path), { active: false, updatedAt: NOW }));
    await assertSucceeds(updateDoc(ref(a(), path), { lastMaterializedThrough: "2026-12-10", updatedAt: NOW }));
    await assertFails(updateDoc(ref(a(), path), { frequency: "weekly" }));
    await assertFails(updateDoc(ref(a(), path), { startDate: "2020-01-01" }));
    await assertFails(updateDoc(ref(a(), path), { kind: "receivable" }));
  });
});

describe("finanças: coleções não declaradas continuam negadas", () => {
  it("nega coleção desconhecida dentro do usuário", async () => {
    await assertFails(setDoc(ref(dbOf("userA"), "users/userA/segredos/x"), { uid: "userA" }));
    await assertFails(getDoc(ref(dbOf("userA"), "users/userA/segredos/x")));
    expect(true).toBe(true);
  });
});
