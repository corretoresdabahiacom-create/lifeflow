import { monthOf, type Transaction } from "@lifeflow/shared";

export interface NamedCategory {
  name: string;
  kind: string;
}

export interface Summary {
  totals: { incomeCents: number; expenseCents: number; netCents: number; transferVolumeCents: number };
  byCategory: Array<{ categoryId: string | null; name: string; kind: "income" | "expense"; totalCents: number; count: number }>;
  byAccount: Array<{
    accountId: string;
    name: string;
    incomeCents: number;
    expenseCents: number;
    transferInCents: number;
    transferOutCents: number;
    netCents: number;
  }>;
  byMonth: Array<{ month: string; incomeCents: number; expenseCents: number; netCents: number }>;
  transactionCount: number;
}

/**
 * Agrega lançamentos EFETIVADOS (`posted`). Estornados são ignorados. Transferências não contam como
 * receita nem despesa (apenas movem dinheiro entre contas) e aparecem só no volume e por conta.
 */
export function summarize(
  transactions: Transaction[],
  accountNames: Map<string, string>,
  categories: Map<string, NamedCategory>,
): Summary {
  const totals = { incomeCents: 0, expenseCents: 0, netCents: 0, transferVolumeCents: 0 };
  const byCategory = new Map<string, Summary["byCategory"][number]>();
  const byAccount = new Map<string, Summary["byAccount"][number]>();
  const byMonth = new Map<string, Summary["byMonth"][number]>();
  let count = 0;

  for (const tx of transactions) {
    if (tx.status !== "posted") continue;
    count++;

    let account = byAccount.get(tx.accountId);
    if (!account) {
      account = {
        accountId: tx.accountId,
        name: accountNames.get(tx.accountId) ?? "(conta removida)",
        incomeCents: 0,
        expenseCents: 0,
        transferInCents: 0,
        transferOutCents: 0,
        netCents: 0,
      };
      byAccount.set(tx.accountId, account);
    }
    account.netCents += tx.signedCents;

    if (tx.type === "transfer_in") {
      account.transferInCents += tx.amountCents;
      continue;
    }
    if (tx.type === "transfer_out") {
      account.transferOutCents += tx.amountCents;
      totals.transferVolumeCents += tx.amountCents;
      continue;
    }

    const month = monthOf(tx.date);
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = { month, incomeCents: 0, expenseCents: 0, netCents: 0 };
      byMonth.set(month, bucket);
    }
    const key = `${tx.type}:${tx.categoryId ?? ""}`;
    let category = byCategory.get(key);
    if (!category) {
      const known = tx.categoryId ? categories.get(tx.categoryId) : undefined;
      category = {
        categoryId: tx.categoryId,
        name: tx.categoryId ? (known?.name ?? "(categoria removida)") : "Sem categoria",
        kind: tx.type,
        totalCents: 0,
        count: 0,
      };
      byCategory.set(key, category);
    }
    category.totalCents += tx.amountCents;
    category.count++;

    if (tx.type === "income") {
      totals.incomeCents += tx.amountCents;
      account.incomeCents += tx.amountCents;
      bucket.incomeCents += tx.amountCents;
    } else {
      totals.expenseCents += tx.amountCents;
      account.expenseCents += tx.amountCents;
      bucket.expenseCents += tx.amountCents;
    }
    bucket.netCents += tx.signedCents;
  }
  totals.netCents = totals.incomeCents - totals.expenseCents;

  return {
    totals,
    byCategory: [...byCategory.values()].sort((a, b) => b.totalCents - a.totalCents),
    byAccount: [...byAccount.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    byMonth: [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    transactionCount: count,
  };
}
