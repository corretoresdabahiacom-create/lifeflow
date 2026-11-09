import {
  addDays,
  centsToDecimal,
  isValidDate,
  monthBounds,
  type Account,
  type Category,
  type Payable,
  type Transaction,
} from "@lifeflow/shared";
import { HttpError } from "../errors";
import { allow, json } from "../http";
import { dateParam, notFound, pathsFor, publicDoc, readAll, todayFor, type Ctx } from "./common";
import { summarize, type NamedCategory } from "./summary";

const MAX_TRANSACTIONS = 5000;

async function loadTransactions(ctx: Ctx, from: string, to: string) {
  const { docs, truncated } = await readAll(
    ctx.db,
    pathsFor(ctx.uid).parent,
    {
      collection: "transactions",
      filters: [
        { field: "date", op: "GREATER_THAN_OR_EQUAL", value: from },
        { field: "date", op: "LESS_THAN_OR_EQUAL", value: to },
      ],
      orderBy: { field: "date", direction: "ASCENDING" },
    },
    MAX_TRANSACTIONS,
  );
  return { transactions: docs.map((d) => publicDoc<Transaction>(d.id, d.data)), truncated };
}

async function loadNames(ctx: Ctx) {
  const parent = pathsFor(ctx.uid).parent;
  const [accounts, categories] = await Promise.all([
    readAll(ctx.db, parent, { collection: "accounts" }, 500),
    readAll(ctx.db, parent, { collection: "categories" }, 500),
  ]);
  return {
    accounts: accounts.docs.map((d) => publicDoc<Account>(d.id, d.data)),
    categories: categories.docs.map((d) => publicDoc<Category>(d.id, d.data)),
  };
}

function period(ctx: Ctx, today: string): { from: string; to: string } {
  const month = monthBounds(today);
  const from = dateParam(ctx.url, "from", isValidDate) ?? month.from;
  const to = dateParam(ctx.url, "to", isValidDate) ?? month.to;
  if (from > to) throw new HttpError(400, "invalid_query", "O período inicial não pode ser posterior ao final");
  return { from, to };
}

const namedCategories = (categories: Category[]): Map<string, NamedCategory> =>
  new Map(categories.map((c) => [c.id, { name: c.name, kind: c.kind }]));

export async function reportsRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (action !== undefined || id !== "summary") throw notFound("Rota");
  allow(ctx.request.method, ["GET"]);
  const { from, to } = period(ctx, await todayFor(ctx));
  const [{ transactions, truncated }, names] = await Promise.all([loadTransactions(ctx, from, to), loadNames(ctx)]);
  const summary = summarize(
    transactions,
    new Map(names.accounts.map((a) => [a.id, a.name])),
    namedCategories(names.categories),
  );
  return json({ from, to, ...summary, truncated });
}

// ------------------------------------------------------------- exportação

/** Neutraliza injeção de fórmulas em planilhas: células de texto que começam com = + - @ ganham um apóstrofo. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function exportRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (action !== undefined || id !== "transactions") throw notFound("Rota");
  allow(ctx.request.method, ["GET"]);
  const { from, to } = period(ctx, await todayFor(ctx));
  const [{ transactions, truncated }, names] = await Promise.all([loadTransactions(ctx, from, to), loadNames(ctx)]);
  const accountNames = new Map(names.accounts.map((a) => [a.id, a.name]));
  const categoryNames = new Map(names.categories.map((c) => [c.id, c.name]));

  const lines = [["date", "account", "type", "category", "description", "amount", "status", "notes"].join(",")];
  for (const tx of transactions) {
    lines.push(
      [
        tx.date,
        csvCell(accountNames.get(tx.accountId) ?? ""),
        tx.type,
        csvCell(tx.categoryId ? (categoryNames.get(tx.categoryId) ?? "") : ""),
        csvCell(tx.description),
        centsToDecimal(tx.signedCents),
        tx.status,
        csvCell(tx.notes ?? ""),
      ].join(","),
    );
  }
  // BOM para o Excel reconhecer UTF-8.
  return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lifeflow-lancamentos-${from}_${to}.csv"`,
      "X-Truncated": String(truncated),
    },
  });
}

// ---------------------------------------------------------- conciliação

/**
 * Confere se o saldo guardado em cada conta bate com `saldo inicial + soma dos lançamentos efetivados`.
 * Somente leitura. Se houver mais de 5000 lançamentos, não dá veredito (`complete:false`).
 */
export async function reconcileRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (id !== undefined || action !== undefined) throw notFound("Rota");
  allow(ctx.request.method, ["GET"]);
  const parent = pathsFor(ctx.uid).parent;
  const [accounts, txs] = await Promise.all([
    readAll(ctx.db, parent, { collection: "accounts" }, 500),
    readAll(ctx.db, parent, { collection: "transactions", orderBy: { field: "date", direction: "ASCENDING" } }, MAX_TRANSACTIONS),
  ]);
  const sums = new Map<string, number>();
  for (const doc of txs.docs) {
    if (doc.data["status"] !== "posted") continue;
    const accountId = String(doc.data["accountId"]);
    sums.set(accountId, (sums.get(accountId) ?? 0) + Number(doc.data["signedCents"]));
  }
  const rows = accounts.docs.map((doc) => {
    const stored = Number(doc.data["balanceCents"]);
    const expected = Number(doc.data["initialBalanceCents"]) + (sums.get(doc.id) ?? 0);
    return {
      accountId: doc.id,
      name: String(doc.data["name"]),
      storedCents: stored,
      expectedCents: expected,
      driftCents: stored - expected,
    };
  });
  const complete = !txs.truncated;
  return json({ complete, ok: complete && rows.every((r) => r.driftCents === 0), accounts: rows });
}

// ---------------------------------------------------------------- painel

export async function overviewRoute(ctx: Ctx, id: string | undefined, action: string | undefined): Promise<Response> {
  if (id !== "overview" || action !== undefined) throw notFound("Rota");
  allow(ctx.request.method, ["GET"]);
  const today = await todayFor(ctx);
  const month = monthBounds(today);
  const horizon = addDays(today, 30);
  const parent = pathsFor(ctx.uid).parent;

  const [names, tx, payables] = await Promise.all([
    loadNames(ctx),
    loadTransactions(ctx, month.from, month.to),
    readAll(
      ctx.db,
      parent,
      {
        collection: "payables",
        filters: [{ field: "dueDate", op: "LESS_THAN_OR_EQUAL", value: horizon }],
        orderBy: { field: "dueDate", direction: "ASCENDING" },
      },
      2000,
    ),
  ]);

  const activeAccounts = names.accounts.filter((a) => !a.archived);
  const summary = summarize(
    tx.transactions,
    new Map(names.accounts.map((a) => [a.id, a.name])),
    namedCategories(names.categories),
  );

  const open = payables.docs
    .map((d) => publicDoc<Payable>(d.id, d.data))
    .filter((p) => p.status === "open");
  const bucket = (items: Payable[]) => ({
    count: items.length,
    totalCents: items.reduce((sum, p) => sum + p.amountCents, 0),
  });
  const dueSoonEnd = addDays(today, 7);
  const overdue = open.filter((p) => p.dueDate < today);
  const next7 = open.filter((p) => p.dueDate >= today && p.dueDate <= dueSoonEnd);
  const next30 = open.filter((p) => p.dueDate >= today);

  return json({
    today,
    month,
    totalBalanceCents: activeAccounts.reduce((sum, a) => sum + a.balanceCents, 0),
    accounts: activeAccounts
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((a) => ({ id: a.id, name: a.name, type: a.type, balanceCents: a.balanceCents })),
    monthSummary: {
      incomeCents: summary.totals.incomeCents,
      expenseCents: summary.totals.expenseCents,
      netCents: summary.totals.netCents,
      truncated: tx.truncated,
    },
    payables: {
      overdueToPay: bucket(overdue.filter((p) => p.kind === "payable")),
      overdueToReceive: bucket(overdue.filter((p) => p.kind === "receivable")),
      next7ToPay: bucket(next7.filter((p) => p.kind === "payable")),
      next7ToReceive: bucket(next7.filter((p) => p.kind === "receivable")),
      next30ToPay: bucket(next30.filter((p) => p.kind === "payable")),
      next30ToReceive: bucket(next30.filter((p) => p.kind === "receivable")),
      truncated: payables.truncated,
    },
  });
}
