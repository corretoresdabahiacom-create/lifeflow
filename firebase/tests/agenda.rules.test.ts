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
 * Regras da agenda (Fase 3): isolamento entre usuários, formato dos documentos, imutabilidade e
 * quem pode excluir. Rodam no emulador do Firestore.
 */

let env: RulesTestEnvironment;
const NOW = "2026-11-09T12:00:00.000Z";
const COLLECTIONS = ["events", "eventExceptions", "tasks", "taskCategories", "reminders", "notifications"] as const;
type Name = (typeof COLLECTIONS)[number];
/** Coleções em que o dono pode excluir. */
const DELETABLE: ReadonlySet<Name> = new Set(["events", "eventExceptions", "tasks", "reminders"]);

const event = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  title: "Reunião",
  kind: "meeting",
  description: null,
  startDate: "2026-11-10",
  startTime: "10:00",
  durationMin: 60,
  timeZone: "America/Sao_Paulo",
  location: null,
  contact: null,
  link: null,
  notes: null,
  estimatedCostCents: null,
  reminders: "10,60",
  recFrequency: null,
  recInterval: null,
  recWeekdays: "",
  recUntil: null,
  recCount: null,
  expenseTransactionId: null,
  createdAt: NOW,
  updatedAt: NOW,
  requestHash: "h",
  ...over,
});
const exception = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  seriesId: "evt1",
  originalDate: "2026-11-17",
  canceled: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const task = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  title: "Pagar IPTU",
  description: null,
  priority: "medium",
  categoryId: null,
  dueDate: "2026-11-12",
  dueTime: null,
  status: "pending",
  reminderMinutes: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  requestHash: "h",
  ...over,
});
const taskCategory = (uid: string, over: Record<string, unknown> = {}) => ({
  uid, name: "Casa", archived: false, createdAt: NOW, updatedAt: NOW, requestHash: "h", ...over,
});
const reminder = (uid: string, over: Record<string, unknown> = {}) => ({
  uid, title: "Ligar", remindAt: "2026-11-09T15:00:00.000Z", createdAt: NOW, requestHash: "h", ...over,
});
const notification = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  type: "event_reminder",
  title: "Reunião",
  body: "Começa em 10 min",
  sourceType: "event",
  sourceId: "evt1",
  occurrenceKey: "2026-11-10@2026-11-10T10:00#10",
  triggerAt: NOW,
  silent: false,
  read: false,
  readAt: null,
  dismissed: false,
  createdAt: NOW,
  ...over,
});

const FACTORY = { events: event, eventExceptions: exception, tasks: task, taskCategories: taskCategory, reminders: reminder, notifications: notification } as const;
const SEEDED: Record<Name, string> = { events: "evt1", eventExceptions: "exc1", tasks: "tsk1", taskCategories: "cat1", reminders: "rem1", notifications: "ntf1" };
const dbOf = (uid: string | null) => (uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore());
const ref = (db: ReturnType<typeof dbOf>, path: string) => doc(db, path);
const A = (path: string) => ref(dbOf("userA"), `users/userA/${path}`);

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
      for (const name of COLLECTIONS) await setDoc(doc(db, `users/${uid}/${name}/${SEEDED[name]}`), FACTORY[name](uid));
    }
  });
});

describe("agenda: sem autenticação", () => {
  for (const name of COLLECTIONS) {
    it(`${name}: não lê, não lista, não cria`, async () => {
      const db = dbOf(null);
      await assertFails(getDoc(ref(db, `users/userA/${name}/${SEEDED[name]}`)));
      await assertFails(getDocs(collection(db, `users/userA/${name}`)));
      await assertFails(setDoc(ref(db, `users/userA/${name}/novo`), FACTORY[name]("userA")));
    });
  }
});

describe("agenda: isolamento entre usuários (A contra B)", () => {
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
      await assertSucceeds(getDoc(A(`${name}/${SEEDED[name]}`)));
      await assertSucceeds(getDocs(collection(dbOf("userA"), `users/userA/${name}`)));
    });

    it(`${name}: troca manual do uid, campo desconhecido e id inválido são negados`, async () => {
      const a = dbOf("userA");
      await assertFails(setDoc(ref(a, `users/userA/${name}/novo`), FACTORY[name]("userB")));
      await assertFails(setDoc(ref(a, `users/userA/${name}/novo`), { ...FACTORY[name]("userA"), extra: 1 }));
      await assertFails(setDoc(ref(a, `users/userA/${name}/id com espaço`), FACTORY[name]("userA")));
    });

    it(`${name}: exclusão pelo dono ${DELETABLE.has(name) ? "é permitida" : "é negada"}`, async () => {
      const result = deleteDoc(A(`${name}/${SEEDED[name]}`));
      await (DELETABLE.has(name) ? assertSucceeds(result) : assertFails(result));
    });
  }
});

describe("agenda: eventos", () => {
  it("cria evento simples, de dia inteiro e recorrente", async () => {
    await assertSucceeds(setDoc(A("events/e1"), event("userA")));
    await assertSucceeds(setDoc(A("events/e2"), event("userA", { startTime: null, durationMin: 1440 })));
    await assertSucceeds(
      setDoc(A("events/e3"), event("userA", { recFrequency: "custom", recInterval: 2, recWeekdays: "1,3", recUntil: "2027-01-01", recCount: null })),
    );
    await assertSucceeds(setDoc(A("events/e4"), event("userA", { link: "https://exemplo.com/x", estimatedCostCents: 5000 })));
  });
  it("nega formato inválido: tipo, horário, duração, fuso, link, lembretes, recorrência, custo", async () => {
    for (const [i, bad] of [
      { kind: "festa" },
      { title: "" },
      { startTime: "25:00" },
      { startDate: "10/11/2026" },
      { durationMin: 0 },
      { durationMin: 99999 },
      { durationMin: 1.5 },
      { timeZone: "" },
      { link: "javascript:alert(1)" },
      { reminders: "10,abc" },
      { reminders: "1,2,3,4,5,6" },
      { recFrequency: "hourly" },
      { recInterval: 0 },
      { recWeekdays: "7" },
      { recCount: 5000 },
      { estimatedCostCents: 0 },
      { estimatedCostCents: 10.5 },
      { expenseTransactionId: "abc" }, // despesa só é vinculada depois, nunca na criação
    ].entries()) {
      await assertFails(setDoc(A(`events/bad${i}`), event("userA", bad)));
    }
  });
  it("edita campos livres; nega mudar uid, createdAt e requestHash", async () => {
    await assertSucceeds(updateDoc(A("events/evt1"), { title: "Novo", updatedAt: NOW, reminders: "5" }));
    await assertSucceeds(updateDoc(A("events/evt1"), { expenseTransactionId: "tx_abc", updatedAt: NOW }));
    await assertFails(updateDoc(A("events/evt1"), { uid: "userB" }));
    await assertFails(updateDoc(A("events/evt1"), { createdAt: "2020-01-01T00:00:00.000Z" }));
    await assertFails(updateDoc(A("events/evt1"), { requestHash: "outro" }));
    await assertFails(updateDoc(A("events/evt1"), { durationMin: -5 }));
  });
});

describe("agenda: exceções de ocorrência", () => {
  it("aceita ocorrência cancelada, e com sobrescritas (inclusive null)", async () => {
    await assertSucceeds(setDoc(A("eventExceptions/x1"), exception("userA", { canceled: true })));
    await assertSucceeds(
      setDoc(A("eventExceptions/x2"), exception("userA", { title: "Especial", startTime: "15:00", location: null, durationMin: 30, startDate: "2026-11-19", reminders: "10", estimatedCostCents: null })),
    );
    await assertSucceeds(setDoc(A("eventExceptions/x3"), exception("userA", { startTime: null })));
  });
  it("nega sobrescrita inválida e campos que não existem", async () => {
    for (const [i, bad] of [{ title: "" }, { startTime: "99:99" }, { durationMin: 0 }, { kind: "x" }, { link: "ftp://x" }, { requestHash: "h" }, { originalDate: "17/11" }, { canceled: "sim" }].entries()) {
      await assertFails(setDoc(A(`eventExceptions/bad${i}`), exception("userA", bad)));
    }
  });
  it("altera sobrescritas; nega mudar série, data original e uid", async () => {
    await assertSucceeds(updateDoc(A("eventExceptions/exc1"), { title: "Mudou", updatedAt: NOW }));
    await assertFails(updateDoc(A("eventExceptions/exc1"), { seriesId: "outra" }));
    await assertFails(updateDoc(A("eventExceptions/exc1"), { originalDate: "2026-11-24" }));
    await assertFails(updateDoc(A("eventExceptions/exc1"), { uid: "userB" }));
  });
});

describe("agenda: tarefas", () => {
  it("cria tarefa válida (com hora e lembrete só com prazo)", async () => {
    await assertSucceeds(setDoc(A("tasks/t1"), task("userA")));
    await assertSucceeds(setDoc(A("tasks/t2"), task("userA", { dueTime: "09:30", reminderMinutes: 15, priority: "urgent", status: "in_progress" })));
    await assertSucceeds(setDoc(A("tasks/t3"), task("userA", { dueDate: null })));
  });
  it("nega formato inválido", async () => {
    for (const [i, bad] of [
      { priority: "critica" },
      { status: "feito" },
      { status: "completed" }, // não nasce concluída
      { completedAt: NOW },
      { dueTime: "10:00", dueDate: null },
      { reminderMinutes: 10, dueDate: null },
      { reminderMinutes: -1 },
      { dueTime: "24:00" },
      { title: "" },
      { categoryId: "id com espaço" },
    ].entries()) {
      await assertFails(setDoc(A(`tasks/bad${i}`), task("userA", bad)));
    }
  });
  it("conclui (com completedAt) e reabre; completedAt exige status concluída", async () => {
    await assertSucceeds(updateDoc(A("tasks/tsk1"), { status: "completed", completedAt: NOW, updatedAt: NOW }));
    await assertSucceeds(updateDoc(A("tasks/tsk1"), { status: "pending", completedAt: null, updatedAt: NOW }));
    await assertFails(updateDoc(A("tasks/tsk1"), { completedAt: NOW }));
    await assertFails(updateDoc(A("tasks/tsk1"), { uid: "userB" }));
    await assertFails(updateDoc(A("tasks/tsk1"), { requestHash: "x" }));
  });
});

describe("agenda: categorias de tarefa e lembretes avulsos", () => {
  it("categoria: cria ativa, arquiva; nega criar já arquivada e mudar campos imutáveis", async () => {
    await assertSucceeds(setDoc(A("taskCategories/c1"), taskCategory("userA")));
    await assertFails(setDoc(A("taskCategories/c2"), taskCategory("userA", { archived: true })));
    await assertSucceeds(updateDoc(A("taskCategories/cat1"), { archived: true, updatedAt: NOW }));
    await assertFails(updateDoc(A("taskCategories/cat1"), { uid: "userB" }));
    await assertFails(updateDoc(A("taskCategories/cat1"), { createdAt: "x" }));
  });
  it("lembrete avulso: cria e exclui; não pode ser alterado; data inválida é negada", async () => {
    await assertSucceeds(setDoc(A("reminders/r1"), reminder("userA")));
    await assertFails(updateDoc(A("reminders/rem1"), { title: "Outro" }));
    await assertFails(setDoc(A("reminders/r2"), reminder("userA", { remindAt: "amanhã" })));
    await assertFails(setDoc(A("reminders/r3"), reminder("userA", { title: "" })));
  });
});

describe("agenda: notificações", () => {
  it("cria não lida e não dispensada; nega criar já lida ou dispensada", async () => {
    await assertSucceeds(setDoc(A("notifications/n1"), notification("userA")));
    await assertSucceeds(setDoc(A("notifications/n2"), notification("userA", { silent: true, type: "payable_due", sourceType: "payable" })));
    await assertFails(setDoc(A("notifications/n3"), notification("userA", { read: true })));
    await assertFails(setDoc(A("notifications/n4"), notification("userA", { dismissed: true })));
    await assertFails(setDoc(A("notifications/n5"), notification("userA", { type: "spam" })));
    await assertFails(setDoc(A("notifications/n6"), notification("userA", { body: "x".repeat(301) })));
  });
  it("só muda leitura/dispensa, e só para frente (lida → não lida é negado)", async () => {
    await assertSucceeds(updateDoc(A("notifications/ntf1"), { read: true, readAt: NOW }));
    await assertSucceeds(updateDoc(A("notifications/ntf1"), { dismissed: true }));
    await assertFails(updateDoc(A("notifications/ntf1"), { read: false }));
    await assertFails(updateDoc(A("notifications/ntf1"), { dismissed: false }));
    await assertFails(updateDoc(A("notifications/ntf1"), { title: "Outro" }));
    await assertFails(updateDoc(A("notifications/ntf1"), { triggerAt: "x" }));
    await assertFails(updateDoc(A("notifications/ntf1"), { uid: "userB" }));
  });
});
