import type {
  Account,
  Category,
  Payable,
  RecurringRule,
  Transaction,
  Transfer,
} from "@lifeflow/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, makeSigner, signToken, type Signer, type fakeFirestore } from "./helpers";
import type { Env } from "../src/env";

/**
 * Suíte financeira da Fase 2. Roda duas vezes com o MESMO código:
 *  - contra o Firestore falso em memória (`pnpm test`, local e CI);
 *  - contra o emulador real do Firestore, com as Security Rules reais (`pnpm test:integration`, CI).
 */

export interface Reply {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Headers;
}

export class Client {
  constructor(
    private readonly app: (path: string, init?: RequestInit, token?: string) => Promise<Response>,
    private readonly token: string,
  ) {}

  async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await this.app(path, init, this.token);
    // ignoreBOM: preserva o BOM do CSV para podermos conferi-lo.
    const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await response.arrayBuffer());
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* resposta não JSON (CSV) */
    }
    return { status: response.status, body: parsed, text, headers: response.headers };
  }

  get = (path: string) => this.send("GET", path);
  patch = (path: string, body: unknown) => this.send("PATCH", path, body);
  /** `key: null` envia sem Idempotency-Key; sem `key`, gera uma nova. */
  post = (path: string, body: unknown, key?: string | null) =>
    this.send("POST", path, body, key === null ? {} : { "Idempotency-Key": key ?? `k-${crypto.randomUUID()}` });
}

export interface World {
  A: Client;
  B: Client;
  fake?: ReturnType<typeof fakeFirestore>;
}

const asAccount = (r: Reply) => r.body as unknown as Account;
const asTx = (r: Reply) => r.body as unknown as Transaction;
const asTransfer = (r: Reply) => r.body as unknown as Transfer;
const asPayable = (r: Reply) => r.body as unknown as Payable;
const TODAY = "2026-11-09"; // relógio fixo do Worker nos testes

export function defineFinanceSuite(
  title: string,
  makeWorld: (signer: Signer) => World | Promise<World>,
  options: { fake: boolean },
): void {
  describe(title, () => {
    let signer: Signer;
    beforeAll(async () => {
      signer = await makeSigner("k1");
    });

    const world = () => makeWorld(signer);

    const newAccount = async (c: Client, name: string, initialBalanceCents = 0, type = "checking") => {
      const r = await c.post("/v1/accounts", { name, type, initialBalanceCents });
      expect(r.status).toBe(201);
      return asAccount(r);
    };
    const balances = async (c: Client) => {
      const r = await c.get("/v1/accounts");
      const list = (r.body as unknown as { accounts: Account[]; totalBalanceCents: number });
      return { byId: new Map(list.accounts.map((a) => [a.id, a.balanceCents])), total: list.totalBalanceCents };
    };
    const txBody = (accountId: string, over: Record<string, unknown> = {}) => ({
      accountId,
      type: "expense",
      amountCents: 1000,
      date: TODAY,
      description: "Mercado",
      ...over,
    });
    const listTx = async (c: Client, query = "from=2026-11-01&to=2026-11-30") =>
      (await c.get(`/v1/transactions?${query}`)).body as unknown as { items: Transaction[]; nextCursor: string | null };

    // ------------------------------------------------------------ checklist da fase
    it("checklist: duas contas, receita, despesa, transferência e saldos conferem", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Conta corrente", 100_000);
      const a2 = await newAccount(A, "Poupança", 0, "savings");

      expect((await A.post("/v1/transactions", txBody(a1.id, { type: "income", amountCents: 50_000, description: "Salário" }))).status).toBe(201);
      expect((await A.post("/v1/transactions", txBody(a1.id, { amountCents: 20_000 }))).status).toBe(201);
      expect((await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 30_000, date: TODAY })).status).toBe(201);

      const { byId, total } = await balances(A);
      expect(byId.get(a1.id)).toBe(100_000 + 50_000 - 20_000 - 30_000);
      expect(byId.get(a2.id)).toBe(30_000);
      expect(total).toBe(130_000);

      const reconcile = (await A.get("/v1/reconcile")).body as unknown as { ok: boolean; complete: boolean; accounts: Array<{ driftCents: number }> };
      expect(reconcile.complete).toBe(true);
      expect(reconcile.ok).toBe(true);
      expect(reconcile.accounts.every((r) => r.driftCents === 0)).toBe(true);

      const { items } = await listTx(A);
      expect(items.map((t) => t.type).sort()).toEqual(["expense", "income", "transfer_in", "transfer_out"]);
    });

    // ------------------------------------------------------------ idempotência
    it("idempotência: repetir a mesma requisição devolve o original e não duplica", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const key = `key-${crypto.randomUUID()}`;
      const first = await A.post("/v1/transactions", txBody(acc.id, { amountCents: 2500 }), key);
      const second = await A.post("/v1/transactions", txBody(acc.id, { amountCents: 2500 }), key);
      const third = await A.post("/v1/transactions", txBody(acc.id, { amountCents: 2500 }), key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(second.headers.get("Idempotent-Replay")).toBe("true");
      expect(first.headers.get("Idempotent-Replay")).toBeNull();
      expect(asTx(second).id).toBe(asTx(first).id);
      expect((await listTx(A)).items).toHaveLength(1);
      expect((await balances(A)).byId.get(acc.id)).toBe(10_000 - 2500);
    });

    it("mesma chave com conteúdo diferente: 422 e nada muda", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const key = `key-${crypto.randomUUID()}`;
      expect((await A.post("/v1/transactions", txBody(acc.id, { amountCents: 1000 }), key)).status).toBe(201);
      const reuse = await A.post("/v1/transactions", txBody(acc.id, { amountCents: 9999 }), key);
      expect(reuse.status).toBe(422);
      expect((reuse.body.error as { code: string }).code).toBe("idempotency_key_reuse");
      expect((await balances(A)).byId.get(acc.id)).toBe(9000);
      expect((await listTx(A)).items).toHaveLength(1);
    });

    it("exige Idempotency-Key válida nas operações de criação", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente");
      const missing = await A.post("/v1/transactions", txBody(acc.id), null);
      expect(missing.status).toBe(400);
      expect((missing.body.error as { code: string }).code).toBe("idempotency_key_required");
      const invalid = await A.post("/v1/transactions", txBody(acc.id), "curta");
      expect(invalid.status).toBe(400);
      expect((invalid.body.error as { code: string }).code).toBe("idempotency_key_invalid");
      expect((await listTx(A)).items).toHaveLength(0);
    });

    it("requisições simultâneas com a mesma chave geram um único lançamento", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 50_000);
      const key = `key-${crypto.randomUUID()}`;
      const replies = await Promise.all(
        Array.from({ length: 6 }, () => A.post("/v1/transactions", txBody(acc.id, { amountCents: 7000 }), key)),
      );
      const created = replies.filter((r) => r.status === 201);
      const replays = replies.filter((r) => r.status === 200);
      expect(created).toHaveLength(1);
      expect(replays).toHaveLength(5);
      expect(new Set(replies.map((r) => asTx(r).id)).size).toBe(1);
      expect((await listTx(A)).items).toHaveLength(1);
      expect((await balances(A)).byId.get(acc.id)).toBe(43_000);
    });

    it("contas e categorias também são idempotentes", async () => {
      const { A } = await world();
      const key = `key-${crypto.randomUUID()}`;
      const one = await A.post("/v1/accounts", { name: "Carteira", type: "cash" }, key);
      const two = await A.post("/v1/accounts", { name: "Carteira", type: "cash" }, key);
      expect(one.status).toBe(201);
      expect(two.status).toBe(200);
      expect(((await A.get("/v1/accounts")).body.accounts as Account[])).toHaveLength(1);

      const catKey = `key-${crypto.randomUUID()}`;
      await A.post("/v1/categories", { name: "Mercado", kind: "expense" }, catKey);
      const again = await A.post("/v1/categories", { name: "Mercado", kind: "expense" }, catKey);
      expect(again.status).toBe(200);
      expect(((await A.get("/v1/categories")).body.categories as Category[])).toHaveLength(1);
    });

    // ------------------------------------------------------------ duplicidade
    it("prevenção de duplicidade: mesmo conteúdo com outra chave exige confirmação", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      expect((await A.post("/v1/transactions", txBody(acc.id, { description: "Padaria" }))).status).toBe(201);

      const dup = await A.post("/v1/transactions", txBody(acc.id, { description: "  padaria " }));
      expect(dup.status).toBe(409);
      expect((dup.body.error as { code: string }).code).toBe("possible_duplicate");
      expect((await balances(A)).byId.get(acc.id)).toBe(9000);

      const confirmed = await A.post("/v1/transactions", txBody(acc.id, { description: "Padaria", allowDuplicate: true }));
      expect(confirmed.status).toBe(201);
      expect((await balances(A)).byId.get(acc.id)).toBe(8000);
      expect((await listTx(A)).items).toHaveLength(2);
    });

    // ------------------------------------------------------------ transferências
    it("transferência: destino inexistente não grava nada (atomicidade)", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const r = await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: "conta_que_nao_existe", amountCents: 5000, date: TODAY });
      expect(r.status).toBe(404);
      expect((await balances(A)).byId.get(a1.id)).toBe(10_000);
      expect((await listTx(A)).items).toHaveLength(0);
      expect(((await A.get("/v1/transfers")).body.items as Transfer[])).toHaveLength(0);
    });

    it("transferência: mesma conta é rejeitada", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const r = await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a1.id, amountCents: 100, date: TODAY });
      expect(r.status).toBe(400);
      expect((await balances(A)).byId.get(a1.id)).toBe(10_000);
    });

    it("transferência: repetir a requisição não move o dinheiro duas vezes", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const a2 = await newAccount(A, "Destino", 0);
      const body = { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 4000, date: TODAY };
      const key = `key-${crypto.randomUUID()}`;
      const first = await A.post("/v1/transfers", body, key);
      const second = await A.post("/v1/transfers", body, key);
      expect([first.status, second.status]).toEqual([201, 200]);
      expect(asTransfer(second).id).toBe(asTransfer(first).id);
      const { byId } = await balances(A);
      expect(byId.get(a1.id)).toBe(6000);
      expect(byId.get(a2.id)).toBe(4000);
      expect((await listTx(A)).items).toHaveLength(2);
    });

    it("transferências simultâneas com a mesma chave: efeito único", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const a2 = await newAccount(A, "Destino", 0);
      const body = { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 2500, date: TODAY };
      const key = `key-${crypto.randomUUID()}`;
      const replies = await Promise.all(Array.from({ length: 5 }, () => A.post("/v1/transfers", body, key)));
      expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 200)).toHaveLength(4);
      const { byId } = await balances(A);
      expect(byId.get(a1.id)).toBe(7500);
      expect(byId.get(a2.id)).toBe(2500);
      expect((await listTx(A)).items).toHaveLength(2);
    });

    it("estorno de transferência devolve os dois saldos e é idempotente", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const a2 = await newAccount(A, "Destino", 500);
      const transfer = asTransfer(await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 3000, date: TODAY }));

      const voided = await A.post(`/v1/transfers/${transfer.id}/void`, {});
      expect(voided.status).toBe(200);
      expect(asTransfer(voided).status).toBe("voided");
      const again = await A.post(`/v1/transfers/${transfer.id}/void`, {});
      expect(again.status).toBe(200);

      const { byId } = await balances(A);
      expect(byId.get(a1.id)).toBe(10_000);
      expect(byId.get(a2.id)).toBe(500);
      const { items } = await listTx(A);
      expect(items.every((t) => t.status === "voided")).toBe(true);
      const reconcile = (await A.get("/v1/reconcile")).body as unknown as { ok: boolean };
      expect(reconcile.ok).toBe(true);
    });

    it("uma perna de transferência não pode ser estornada isoladamente", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Origem", 10_000);
      const a2 = await newAccount(A, "Destino", 0);
      const transfer = asTransfer(await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 1000, date: TODAY }));
      const r = await A.post(`/v1/transactions/${transfer.outTransactionId}/void`, {});
      expect(r.status).toBe(409);
      expect((await balances(A)).byId.get(a1.id)).toBe(9000);
    });

    // ------------------------------------------------------------ lançamentos
    it("estorno de lançamento reverte o saldo, é idempotente e bloqueia edição", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const tx = asTx(await A.post("/v1/transactions", txBody(acc.id, { type: "income", amountCents: 4000, description: "Freela" })));
      expect((await balances(A)).byId.get(acc.id)).toBe(14_000);

      expect((await A.post(`/v1/transactions/${tx.id}/void`, {})).status).toBe(200);
      expect((await A.post(`/v1/transactions/${tx.id}/void`, {})).status).toBe(200);
      expect((await balances(A)).byId.get(acc.id)).toBe(10_000);

      const edit = await A.patch(`/v1/transactions/${tx.id}`, { description: "novo" });
      expect(edit.status).toBe(409);
    });

    it("editar metadados não altera o saldo; valor e conta não são editáveis", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const cat = (await A.post("/v1/categories", { name: "Mercado", kind: "expense" })).body as unknown as Category;
      const tx = asTx(await A.post("/v1/transactions", txBody(acc.id, { amountCents: 3000 })));

      const edited = await A.patch(`/v1/transactions/${tx.id}`, { description: "Supermercado", categoryId: cat.id });
      expect(edited.status).toBe(200);
      expect(asTx(edited).description).toBe("Supermercado");
      expect(asTx(edited).categoryId).toBe(cat.id);
      expect((await balances(A)).byId.get(acc.id)).toBe(7000);

      expect((await A.patch(`/v1/transactions/${tx.id}`, { amountCents: 1 })).status).toBe(400);
      expect((await A.patch(`/v1/transactions/${tx.id}`, { accountId: "outra" })).status).toBe(400);
    });

    it("validações de entrada e de referências", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const incomeCat = (await A.post("/v1/categories", { name: "Salário", kind: "income" })).body as unknown as Category;

      for (const bad of [
        { amountCents: 12.5 },
        { amountCents: 0 },
        { amountCents: -10 },
        { amountCents: "10" },
        { date: "2026-02-30" },
        { type: "transfer_out" },
        { uid: "outro-usuario" },
        { balanceCents: 1 },
        { accountId: "../outro" },
      ]) {
        expect((await A.post("/v1/transactions", txBody(acc.id, bad))).status).toBe(400);
      }
      expect((await A.post("/v1/transactions", txBody("conta_inexistente"))).status).toBe(404);
      const wrongKind = await A.post("/v1/transactions", txBody(acc.id, { categoryId: incomeCat.id }));
      expect(wrongKind.status).toBe(422);
      expect((await A.get("/v1/transactions/..%2F..%2Fusers")).status).toBe(404);

      await A.patch(`/v1/accounts/${acc.id}`, { archived: true });
      const archived = await A.post("/v1/transactions", txBody(acc.id));
      expect(archived.status).toBe(422);
      expect((archived.body.error as { code: string }).code).toBe("account_archived");

      expect((await balances(A)).total).toBe(0); // conta arquivada fica fora do total
      expect((await listTx(A)).items).toHaveLength(0);
    });

    it("saldo não pode ser alterado por PATCH de conta", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      expect((await A.patch(`/v1/accounts/${acc.id}`, { balanceCents: 999_999 })).status).toBe(400);
      const renamed = await A.patch(`/v1/accounts/${acc.id}`, { name: "Renomeada" });
      expect(asAccount(renamed).name).toBe("Renomeada");
      expect(asAccount(renamed).balanceCents).toBe(10_000);
    });

    it("paginação por cursor percorre todos os lançamentos sem repetir", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 0);
      const dates = ["2026-11-01", "2026-11-03", "2026-11-03", "2026-11-05", "2026-11-07"];
      for (const [i, date] of dates.entries()) {
        const r = await A.post("/v1/transactions", txBody(acc.id, { date, description: `Item ${i}`, amountCents: 100 + i }));
        expect(r.status).toBe(201);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page = (await A.get(`/v1/transactions?from=2026-11-01&to=2026-11-30&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).body as unknown as {
          items: Transaction[];
          nextCursor: string | null;
        };
        seen.push(...page.items.map((t) => `${t.date}|${t.description}`));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      const onlyDates = seen.map((s) => s.split("|")[0] as string);
      expect(onlyDates).toEqual([...onlyDates].sort().reverse());
      expect((await A.get("/v1/transactions?cursor=invalido")).status).toBe(400);
    });

    // ------------------------------------------------------------ contas a pagar
    it("baixa: conta vencida é baixada uma única vez, mesmo repetida ou concorrente", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 100_000);
      const payable = asPayable(await A.post("/v1/payables", { kind: "payable", description: "Energia", amountCents: 15_000, dueDate: "2026-11-05" }));

      const overdue = (await A.get("/v1/payables?status=overdue")).body as unknown as { items: Payable[] };
      expect(overdue.items.map((p) => p.id)).toEqual([payable.id]);
      expect(overdue.items[0]?.overdue).toBe(true);

      const key = `key-${crypto.randomUUID()}`;
      const body = { accountId: acc.id, date: TODAY };
      const first = await A.post(`/v1/payables/${payable.id}/pay`, body, key);
      expect(first.status).toBe(200);
      expect((first.body.payable as Payable).status).toBe("paid");
      expect((await balances(A)).byId.get(acc.id)).toBe(85_000);

      const replay = await A.post(`/v1/payables/${payable.id}/pay`, body, key);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("Idempotent-Replay")).toBe("true");
      expect((await balances(A)).byId.get(acc.id)).toBe(85_000);

      const second = await A.post(`/v1/payables/${payable.id}/pay`, body);
      expect(second.status).toBe(409);
      expect((second.body.error as { code: string }).code).toBe("already_paid");
      expect((await balances(A)).byId.get(acc.id)).toBe(85_000);

      const { items } = await listTx(A);
      expect(items.filter((t) => t.payableId === payable.id)).toHaveLength(1);
      expect(((await A.get("/v1/payables?status=overdue")).body.items as Payable[])).toHaveLength(0);
    });

    it("baixa simultânea com chaves diferentes: só uma vence", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 100_000);
      const payable = asPayable(await A.post("/v1/payables", { kind: "payable", description: "Internet", amountCents: 12_000, dueDate: TODAY }));
      const replies = await Promise.all(
        Array.from({ length: 5 }, () => A.post(`/v1/payables/${payable.id}/pay`, { accountId: acc.id, date: TODAY })),
      );
      expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
      expect(replies.filter((r) => r.status === 409)).toHaveLength(4);
      expect((await balances(A)).byId.get(acc.id)).toBe(88_000);
      expect((await listTx(A)).items.filter((t) => t.payableId === payable.id)).toHaveLength(1);
    });

    it("conta a receber baixada credita a conta; valor pago pode diferir do previsto", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 0);
      const receivable = asPayable(await A.post("/v1/payables", { kind: "receivable", description: "Cliente X", amountCents: 50_000, dueDate: "2026-11-20" }));
      const paid = await A.post(`/v1/payables/${receivable.id}/pay`, { accountId: acc.id, date: TODAY, amountCents: 49_000 });
      expect(paid.status).toBe(200);
      expect((paid.body.payable as Payable).paidAmountCents).toBe(49_000);
      expect((await balances(A)).byId.get(acc.id)).toBe(49_000);
      const { items } = await listTx(A);
      expect(items[0]?.type).toBe("income");
    });

    it("estornar a baixa reabre a conta e permite baixar de novo", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 100_000);
      const payable = asPayable(await A.post("/v1/payables", { kind: "payable", description: "Seguro", amountCents: 30_000, dueDate: TODAY }));
      const paid = await A.post(`/v1/payables/${payable.id}/pay`, { accountId: acc.id, date: TODAY });
      const txId = paid.body.transactionId as string;

      expect((await A.post(`/v1/transactions/${txId}/void`, {})).status).toBe(200);
      expect((await balances(A)).byId.get(acc.id)).toBe(100_000);
      const reopened = asPayable(await A.get(`/v1/payables/${payable.id}`));
      expect(reopened.status).toBe("open");
      expect(reopened.transactionId).toBeNull();

      const again = await A.post(`/v1/payables/${payable.id}/pay`, { accountId: acc.id, date: TODAY });
      expect(again.status).toBe(200);
      expect(again.body.transactionId).not.toBe(txId);
      expect((await balances(A)).byId.get(acc.id)).toBe(70_000);
      const reconcile = (await A.get("/v1/reconcile")).body as unknown as { ok: boolean };
      expect(reconcile.ok).toBe(true);
    });

    it("baixa: conta inexistente, arquivada ou cancelada é rejeitada sem gravar", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const payable = asPayable(await A.post("/v1/payables", { kind: "payable", description: "X", amountCents: 1000, dueDate: TODAY }));
      expect((await A.post("/v1/payables/inexistente/pay", { accountId: acc.id })).status).toBe(404);
      expect((await A.post(`/v1/payables/${payable.id}/pay`, { accountId: "nao_existe" })).status).toBe(404);

      expect((await A.post(`/v1/payables/${payable.id}/cancel`, {})).status).toBe(200);
      expect((await A.post(`/v1/payables/${payable.id}/cancel`, {})).status).toBe(200);
      expect((await A.post(`/v1/payables/${payable.id}/pay`, { accountId: acc.id })).status).toBe(409);
      expect((await balances(A)).byId.get(acc.id)).toBe(10_000);
      expect((await listTx(A)).items).toHaveLength(0);
    });

    it("conta a pagar só é editável enquanto aberta", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 10_000);
      const payable = asPayable(await A.post("/v1/payables", { kind: "payable", description: "Água", amountCents: 8000, dueDate: "2026-12-01" }));
      const edited = await A.patch(`/v1/payables/${payable.id}`, { amountCents: 8500, dueDate: "2026-12-05" });
      expect(edited.status).toBe(200);
      expect(asPayable(edited).amountCents).toBe(8500);
      await A.post(`/v1/payables/${payable.id}/pay`, { accountId: acc.id, date: TODAY });
      expect((await A.patch(`/v1/payables/${payable.id}`, { amountCents: 1 })).status).toBe(409);
    });

    // ------------------------------------------------------------ recorrências
    it("recorrência mensal gera contas sem duplicar ao repetir", async () => {
      const { A } = await world();
      const rule = (await A.post("/v1/recurring", { kind: "payable", description: "Aluguel", amountCents: 150_000, frequency: "monthly", startDate: "2026-11-10" })).body as unknown as RecurringRule;
      expect(rule.id).toBeTruthy();

      const first = await A.post("/v1/recurring/materialize", { through: "2027-01-31" });
      expect(first.status).toBe(200);
      expect(first.body.created).toBe(3);
      const second = await A.post("/v1/recurring/materialize", { through: "2027-01-31" });
      expect(second.body.created).toBe(0);

      const list = (await A.get("/v1/payables?from=2026-11-01&to=2027-02-28")).body as unknown as { items: Payable[] };
      expect(list.items.map((p) => p.dueDate)).toEqual(["2026-11-10", "2026-12-10", "2027-01-10"]);
      expect(list.items.every((p) => p.recurringId === rule.id && p.status === "open")).toBe(true);

      await A.patch(`/v1/recurring/${rule.id}`, { active: false });
      const afterPause = await A.post("/v1/recurring/materialize", { through: "2027-03-31" });
      expect(afterPause.body.created).toBe(0);
      expect((await A.post("/v1/recurring/materialize", { through: "2099-01-01" })).status).toBe(422);
    });

    it("materialização respeita o limite por chamada e completa sem duplicar", async () => {
      const { A } = await world();
      await A.post("/v1/recurring", { kind: "receivable", description: "Mesada", amountCents: 1000, frequency: "weekly", startDate: TODAY });
      let created = 0;
      for (let i = 0; i < 6; i++) {
        const r = await A.post("/v1/recurring/materialize", { through: "2027-11-08" });
        created += r.body.created as number;
        if (!r.body.hasMore) break;
      }
      expect(created).toBe(53); // semanal de 2026-11-09 até 2027-11-08
      const all = (await A.get("/v1/payables?limit=200")).body as unknown as { items: Payable[] };
      expect(all.items).toHaveLength(53);
      expect(new Set(all.items.map((p) => p.dueDate)).size).toBe(53);
    });

    // ------------------------------------------------------------ relatórios
    it("relatório: totais por categoria/conta/mês; transferências e estornos ficam fora de receita/despesa", async () => {
      const { A } = await world();
      const a1 = await newAccount(A, "Corrente", 0);
      const a2 = await newAccount(A, "Poupança", 0);
      const salary = (await A.post("/v1/categories", { name: "Salário", kind: "income" })).body as unknown as Category;
      const food = (await A.post("/v1/categories", { name: "Mercado", kind: "expense" })).body as unknown as Category;

      await A.post("/v1/transactions", txBody(a1.id, { type: "income", amountCents: 500_000, categoryId: salary.id, description: "Salário" }));
      await A.post("/v1/transactions", txBody(a1.id, { amountCents: 12_050, categoryId: food.id, description: "Feira" }));
      await A.post("/v1/transactions", txBody(a1.id, { amountCents: 7950, categoryId: food.id, description: "Padaria" }));
      const toVoid = asTx(await A.post("/v1/transactions", txBody(a1.id, { amountCents: 99_999, description: "Errado" })));
      await A.post(`/v1/transactions/${toVoid.id}/void`, {});
      await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 100_000, date: TODAY });

      const report = (await A.get("/v1/reports/summary?from=2026-11-01&to=2026-11-30")).body as unknown as {
        totals: { incomeCents: number; expenseCents: number; netCents: number; transferVolumeCents: number };
        byCategory: Array<{ name: string; totalCents: number; count: number }>;
        byAccount: Array<{ name: string; netCents: number }>;
        byMonth: Array<{ month: string; netCents: number }>;
        truncated: boolean;
      };
      expect(report.totals).toEqual({ incomeCents: 500_000, expenseCents: 20_000, netCents: 480_000, transferVolumeCents: 100_000 });
      expect(report.byCategory.find((c) => c.name === "Mercado")).toMatchObject({ totalCents: 20_000, count: 2 });
      expect(report.byAccount.find((a) => a.name === "Corrente")?.netCents).toBe(380_000);
      expect(report.byAccount.find((a) => a.name === "Poupança")?.netCents).toBe(100_000);
      expect(report.byMonth).toEqual([{ month: "2026-11", incomeCents: 500_000, expenseCents: 20_000, netCents: 480_000 }]);
      expect(report.truncated).toBe(false);
      expect((await A.get("/v1/reports/summary?from=2026-12-01&to=2026-11-01")).status).toBe(400);
    });

    it("exportação CSV: BOM, valores em decimal, aspas e proteção contra injeção de fórmula", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "=CMD()", 0);
      await A.post("/v1/transactions", txBody(acc.id, { type: "income", amountCents: 123_456, description: '=HYPERLINK("http://x","clique")' }));
      await A.post("/v1/transactions", txBody(acc.id, { amountCents: 550, description: 'Pão, "quente"', notes: "@nota" }));

      const csv = await A.get("/v1/export/transactions?from=2026-11-01&to=2026-11-30");
      expect(csv.status).toBe(200);
      expect(csv.headers.get("Content-Type")).toContain("text/csv");
      expect(csv.headers.get("Content-Disposition")).toContain("attachment");
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.text.slice(1).trim().split("\r\n");
      expect(lines[0]).toBe("date,account,type,category,description,amount,status,notes");
      expect(lines).toHaveLength(3);
      expect(csv.text).toContain("1234.56");
      expect(csv.text).toContain("-5.50");
      expect(csv.text).toContain("'=CMD()");
      expect(csv.text).toContain(`"'=HYPERLINK(""http://x"",""clique"")"`);
      expect(csv.text).toContain('"Pão, ""quente"""');
      expect(csv.text).toContain("'@nota");
      expect(csv.text).not.toMatch(/(^|,)=/m);
    });

    it("painel: saldo total, resultado do mês e contas a pagar/receber", async () => {
      const { A } = await world();
      const acc = await newAccount(A, "Corrente", 100_000);
      await A.post("/v1/transactions", txBody(acc.id, { type: "income", amountCents: 20_000, description: "Extra" }));
      await A.post("/v1/payables", { kind: "payable", description: "Vencida", amountCents: 5000, dueDate: "2026-11-01" });
      await A.post("/v1/payables", { kind: "payable", description: "Esta semana", amountCents: 7000, dueDate: "2026-11-12" });
      await A.post("/v1/payables", { kind: "receivable", description: "Mês que vem", amountCents: 9000, dueDate: "2026-11-30" });

      const overview = (await A.get("/v1/finance/overview")).body as unknown as {
        today: string;
        totalBalanceCents: number;
        monthSummary: { incomeCents: number; expenseCents: number; netCents: number };
        payables: Record<string, { count: number; totalCents: number }>;
      };
      expect(overview.today).toBe(TODAY);
      expect(overview.totalBalanceCents).toBe(120_000);
      expect(overview.monthSummary).toMatchObject({ incomeCents: 20_000, expenseCents: 0, netCents: 20_000 });
      expect(overview.payables["overdueToPay"]).toEqual({ count: 1, totalCents: 5000 });
      expect(overview.payables["next7ToPay"]).toEqual({ count: 1, totalCents: 7000 });
      expect(overview.payables["next30ToReceive"]).toEqual({ count: 1, totalCents: 9000 });
    });

    // ------------------------------------------------------------ isolamento
    it("isolamento: o usuário B não enxerga nem altera dados do usuário A", async () => {
      const { A, B } = await world();
      const accA = await newAccount(A, "Conta de A", 50_000);
      const accB = await newAccount(B, "Conta de B", 1000);
      const catA = (await A.post("/v1/categories", { name: "Privada", kind: "expense" })).body as unknown as Category;
      const txA = asTx(await A.post("/v1/transactions", txBody(accA.id, { amountCents: 2000 })));
      const payableA = asPayable(await A.post("/v1/payables", { kind: "payable", description: "Só de A", amountCents: 3000, dueDate: TODAY }));
      await A.post("/v1/recurring", { kind: "payable", description: "Só de A", amountCents: 100, frequency: "monthly", startDate: TODAY });

      // B não vê nada de A.
      expect(((await B.get("/v1/accounts")).body.accounts as Account[]).map((a) => a.id)).toEqual([accB.id]);
      expect(((await B.get("/v1/categories")).body.categories as Category[])).toHaveLength(0);
      expect((await listTx(B)).items).toHaveLength(0);
      expect(((await B.get("/v1/payables")).body.items as Payable[])).toHaveLength(0);
      expect(((await B.get("/v1/recurring")).body.rules as RecurringRule[])).toHaveLength(0);
      expect(((await B.get("/v1/transfers")).body.items as Transfer[])).toHaveLength(0);

      // Acesso direto por id de A: 404 (o caminho é derivado do uid de B).
      expect((await B.get(`/v1/accounts/${accA.id}`)).status).toBe(404);
      expect((await B.get(`/v1/transactions/${txA.id}`)).status).toBe(404);
      expect((await B.get(`/v1/payables/${payableA.id}`)).status).toBe(404);
      expect((await B.patch(`/v1/accounts/${accA.id}`, { name: "invadida" })).status).toBe(404);
      expect((await B.patch(`/v1/categories/${catA.id}`, { archived: true })).status).toBe(404);
      expect((await B.post(`/v1/transactions/${txA.id}/void`, {})).status).toBe(404);

      // B não consegue movimentar a conta de A.
      expect((await B.post("/v1/transactions", txBody(accA.id))).status).toBe(404);
      expect((await B.post("/v1/transfers", { fromAccountId: accA.id, toAccountId: accB.id, amountCents: 100, date: TODAY })).status).toBe(404);
      expect((await B.post("/v1/transfers", { fromAccountId: accB.id, toAccountId: accA.id, amountCents: 100, date: TODAY })).status).toBe(404);
      expect((await B.post(`/v1/payables/${payableA.id}/pay`, { accountId: accB.id })).status).toBe(404);
      expect((await B.post("/v1/payables", { kind: "payable", description: "x", amountCents: 1, dueDate: TODAY, accountId: accA.id })).status).toBe(404);

      // Nada mudou para A nem para B.
      expect((await balances(A)).byId.get(accA.id)).toBe(48_000);
      expect((await balances(B)).byId.get(accB.id)).toBe(1000);
      expect(asAccount(await A.get(`/v1/accounts/${accA.id}`)).name).toBe("Conta de A");
      expect(asPayable(await A.get(`/v1/payables/${payableA.id}`)).status).toBe("open");
      expect(((await B.get("/v1/reconcile")).body as { ok: boolean }).ok).toBe(true);

      // A mesma Idempotency-Key em usuários diferentes não colide.
      const shared = `shared-${crypto.randomUUID()}`;
      const ra = await A.post("/v1/accounts", { name: "Igual", type: "cash" }, shared);
      const rb = await B.post("/v1/accounts", { name: "Igual", type: "cash" }, shared);
      expect([ra.status, rb.status]).toEqual([201, 201]);
    });

    it("sem token a API nega o acesso financeiro", async () => {
      const { fake } = await world();
      const anonymous = new Client(makeApp(signer, fake?.fetchImpl ?? fetch), "");
      const r = await anonymous.get("/v1/accounts");
      expect(r.status).toBe(401);
    });

    // ------------------------------------------------------------ somente com o banco falso
    if (options.fake) {
      it("a transferência é UM único commit com as 5 gravações (transferência, 2 pernas, 2 saldos)", async () => {
        const { A, fake } = await world();
        const a1 = await newAccount(A, "Origem", 10_000);
        const a2 = await newAccount(A, "Destino", 0);
        const before = fake!.calls.length;
        const r = await A.post("/v1/transfers", { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 1000, date: TODAY });
        expect(r.status).toBe(201);
        const commits = fake!.calls.slice(before).filter((c) => c.url.endsWith(":commit"));
        expect(commits).toHaveLength(1);
        const writes = (JSON.parse(commits[0]?.body ?? "{}") as { writes: Array<{ updateTransforms?: unknown[]; currentDocument?: unknown }> }).writes;
        expect(writes).toHaveLength(5);
        expect(writes.filter((w) => w.updateTransforms).length).toBe(2);
        expect(writes.every((w) => w.currentDocument !== undefined)).toBe(true);
      });

      it("falha do banco no commit não deixa estado parcial", async () => {
        const { A, fake } = await world();
        const a1 = await newAccount(A, "Origem", 10_000);
        const a2 = await newAccount(A, "Destino", 0);
        const body = { fromAccountId: a1.id, toAccountId: a2.id, amountCents: 1000, date: TODAY };

        fake!.failCommit(500);
        expect((await A.post("/v1/transfers", body)).status).toBe(502);
        fake!.failCommit("network");
        expect((await A.post("/v1/transfers", body)).status).toBe(504);

        const { byId } = await balances(A);
        expect(byId.get(a1.id)).toBe(10_000);
        expect(byId.get(a2.id)).toBe(0);
        expect((await listTx(A)).items).toHaveLength(0);

        // Depois da falha, repetir funciona normalmente.
        const key = `key-${crypto.randomUUID()}`;
        fake!.failCommit(500);
        expect((await A.post("/v1/transfers", body, key)).status).toBe(502);
        expect((await A.post("/v1/transfers", body, key)).status).toBe(201);
        expect((await balances(A)).byId.get(a1.id)).toBe(9000);
      });

      it("o token do usuário é repassado ao banco em toda gravação financeira", async () => {
        const { A, fake } = await world();
        const acc = await newAccount(A, "Corrente", 0);
        await A.post("/v1/transactions", txBody(acc.id));
        expect(fake!.calls.length).toBeGreaterThan(0);
        expect(fake!.calls.every((c) => (c.authorization ?? "").startsWith("Bearer ey"))).toBe(true);
      });

      it("a precondição de updateTime impede sobrescrever alteração concorrente (409)", async () => {
        const { A, fake } = await world();
        const acc = await newAccount(A, "Corrente", 0);
        // Outra alteração acontece entre a leitura e a escrita do PATCH.
        const path = [...fake!.docs.keys()].find((k) => k.includes("/accounts/")) as string;
        const originalFetch = fake!.fetchImpl;
        let injected = false;
        fake!.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (!injected && (init?.method ?? "GET") === "POST" && String(input).endsWith(":commit")) {
            injected = true;
            await originalFetch(`https://firestore.test/v1/projects/demo-lifeflow/databases/(default)/documents/${path}?updateMask.fieldPaths=name`, {
              method: "PATCH",
              body: JSON.stringify({ fields: { name: { stringValue: "mudou por fora" } } }),
            });
          }
          return originalFetch(input, init);
        }) as typeof fetch;
        const r = await A.patch(`/v1/accounts/${acc.id}`, { name: "minha" });
        expect(r.status).toBe(409);
      });
    }
  });
}

export async function tokensFor(signer: Signer): Promise<{ a: string; b: string }> {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return {
    a: await signToken(signer, { uid: `userA_${suffix}` }),
    b: await signToken(signer, { uid: `userB_${suffix}` }),
  };
}

export type { Env };
