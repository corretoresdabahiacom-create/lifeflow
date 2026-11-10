import { ACCOUNT_TYPES, type Account, type AccountType, type Category } from "@lifeflow/shared";
import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { MoneyField } from "../../components/MoneyField";
import { type ReconcileReport } from "../../lib/api";
import { useIdempotencyKey } from "../../lib/idempotency";
import { useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";
import { parseMoneyToCents } from "@lifeflow/shared";

const TYPE_LABELS: Record<AccountType, string> = {
  checking: "Conta corrente",
  savings: "Poupança",
  cash: "Dinheiro",
  credit_card: "Cartão de crédito",
  investment: "Investimento",
};

function AccountForm({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [initial, setInitial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cents = initial.trim() === "" ? 0 : parseMoneyToCents(initial);
    if (cents === null) {
      setError("Saldo inicial inválido.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createAccount({ name, type, initialBalanceCents: cents }, key.current());
      key.renew();
      setName("");
      setInitial("");
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-nova-conta">
      <h2 id="t-nova-conta">Nova conta</h2>
      <label className="field"><span>Nome</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></label>
      <label className="field">
        <span>Tipo</span>
        <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          {ACCOUNT_TYPES.map((t) => (<option key={t} value={t}>{TYPE_LABELS[t]}</option>))}
        </select>
      </label>
      <MoneyField label="Saldo inicial" value={initial} onChange={setInitial} allowNegative required={false} />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Criando…" : "Criar conta"}</button>
    </form>
  );
}

function CategoryForm({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"income" | "expense">("expense");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createCategory({ name, kind }, key.current());
      key.renew();
      setName("");
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-nova-cat">
      <h2 id="t-nova-cat">Nova categoria</h2>
      <label className="field"><span>Nome</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required /></label>
      <label className="field">
        <span>Tipo</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as "income" | "expense")}>
          <option value="expense">Despesa</option>
          <option value="income">Receita</option>
        </select>
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Criando…" : "Criar categoria"}</button>
    </form>
  );
}

function Reconcile() {
  const api = useApi();
  const money = useMoney();
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.reconcile());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="t-conf">
      <h2 id="t-conf">Conferir saldos</h2>
      <p className="muted">Compara o saldo de cada conta com o saldo inicial somado aos lançamentos efetivados.</p>
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>{busy ? "Conferindo…" : "Conferir agora"}</button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {report ? (
        <>
          <p role="status" className={report.ok ? "form-ok" : "form-error"}>
            {!report.complete
              ? "Há lançamentos demais para conferir de uma vez; a conferência está incompleta."
              : report.ok
                ? "Todos os saldos conferem."
                : "Há divergência entre saldo e lançamentos."}
          </p>
          <ul className="list">
            {report.accounts.map((a) => (
              <li key={a.accountId} className="row">
                <div className="row__main"><strong>{a.name}</strong><span className="muted">Esperado {money(a.expectedCents)}</span></div>
                <div className="row__side"><span className={a.driftCents === 0 ? "amount" : "amount amount--out"}>{a.driftCents === 0 ? "OK" : `Diferença ${money(a.driftCents)}`}</span></div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function AccountsPage() {
  const api = useApi();
  const money = useMoney();
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useLoad(() => api.listAccounts(showArchived), [showArchived]);
  const categories = useLoad(() => api.listCategories(showArchived), [showArchived]);

  async function toggle(kind: "account" | "category", item: Account | Category) {
    setBusy(true);
    setError(null);
    try {
      if (kind === "account") await api.patchAccount(item.id, { archived: !item.archived });
      else await api.patchCategory(item.id, { archived: !item.archived });
      accounts.reload();
      categories.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid">
        <AccountForm onDone={accounts.reload} />
        <CategoryForm onDone={categories.reload} />
      </div>

      <section className="card" aria-labelledby="t-contas">
        <h2 id="t-contas">Contas</h2>
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Mostrar arquivadas</label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {accounts.loading && !accounts.data ? <LoadingState /> : null}
        {accounts.error ? <ErrorState message={accounts.error} onRetry={accounts.reload} /> : null}
        {accounts.data && accounts.data.accounts.length === 0 ? <EmptyState title="Nenhuma conta ainda">Crie sua primeira conta acima.</EmptyState> : null}
        {accounts.data && accounts.data.accounts.length > 0 ? (
          <>
            <p><strong>Saldo total:</strong> {money(accounts.data.totalBalanceCents)}</p>
            <ul className="list">
              {accounts.data.accounts.map((a) => (
                <li key={a.id} className={a.archived ? "row row--voided" : "row"}>
                  <div className="row__main"><strong>{a.name}</strong><span className="muted">{TYPE_LABELS[a.type]}{a.archived ? " · arquivada" : ""}</span></div>
                  <div className="row__side">
                    <span className={a.balanceCents >= 0 ? "amount amount--in" : "amount amount--out"}>{money(a.balanceCents)}</span>
                    <button type="button" className="btn" disabled={busy} onClick={() => void toggle("account", a)}>{a.archived ? "Reativar" : "Arquivar"}</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="card" aria-labelledby="t-cats">
        <h2 id="t-cats">Categorias</h2>
        {categories.loading && !categories.data ? <LoadingState /> : null}
        {categories.error ? <ErrorState message={categories.error} onRetry={categories.reload} /> : null}
        {categories.data && categories.data.categories.length === 0 ? <EmptyState title="Nenhuma categoria ainda" /> : null}
        {categories.data && categories.data.categories.length > 0 ? (
          <ul className="list">
            {categories.data.categories.map((c) => (
              <li key={c.id} className={c.archived ? "row row--voided" : "row"}>
                <div className="row__main"><strong>{c.name}</strong><span className="muted">{c.kind === "income" ? "Receita" : "Despesa"}{c.archived ? " · arquivada" : ""}</span></div>
                <div className="row__side"><button type="button" className="btn" disabled={busy} onClick={() => void toggle("category", c)}>{c.archived ? "Reativar" : "Arquivar"}</button></div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <Reconcile />
    </>
  );
}
