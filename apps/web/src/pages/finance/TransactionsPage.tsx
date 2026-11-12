import { type Account, type Category, type Transaction } from "@lifeflow/shared";
import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { MoneyField, toPositiveCents } from "../../components/MoneyField";
import { ApiError, type TransactionPage } from "../../lib/api";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatDate, monthRange, todayLocal, useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeText({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={notice.kind === "ok" ? "form-ok" : "form-error"} role={notice.kind === "ok" ? "status" : "alert"}>
      {notice.text}
    </p>
  );
}

export function TransactionForm({ accounts, categories, onDone }: { accounts: Account[]; categories: Category[]; onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [type, setType] = useState<"income" | "expense">("expense");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);

  const cents = toPositiveCents(amount);
  const kindCategories = categories.filter((c) => c.kind === type);

  async function submit(allowDuplicate: boolean) {
    if (cents === null || !accountId) {
      setNotice({ kind: "error", text: "Informe uma conta e um valor válido." });
      return;
    }
    setBusy(true);
    setNotice(null);
    // Mudar o conteúdo (allowDuplicate) muda o pedido: precisa de uma chave nova.
    if (allowDuplicate) key.renew();
    try {
      await api.createTransaction(
        { accountId, type, amountCents: cents, date, description, categoryId: categoryId || null, allowDuplicate },
        key.current(),
      );
      key.renew(); // ação concluída: o próximo envio é outro lançamento
      setAmount("");
      setDescription("");
      setDuplicate(false);
      setNotice({ kind: "ok", text: "Lançamento registrado." });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "possible_duplicate") {
        setDuplicate(true);
        setNotice({ kind: "error", text: e.message });
      } else {
        // Erro de rede/servidor: a chave NÃO é renovada, então tentar de novo nunca duplica.
        setNotice({ kind: "error", text: describeError(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(false);
  }

  return (
    <form className="card form" onSubmit={onSubmit} aria-labelledby="t-novo-lanc">
      <h2 id="t-novo-lanc">Novo lançamento</h2>
      <div className="seg" role="group" aria-label="Tipo">
        <button type="button" className={type === "expense" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={type === "expense"} onClick={() => { setType("expense"); setCategoryId(""); }}>
          Despesa
        </button>
        <button type="button" className={type === "income" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={type === "income"} onClick={() => { setType("income"); setCategoryId(""); }}>
          Receita
        </button>
      </div>
      <label className="field">
        <span>Conta</span>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </label>
      <MoneyField label="Valor" value={amount} onChange={setAmount} />
      <label className="field">
        <span>Data</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="field">
        <span>Categoria</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Sem categoria</option>
          {kindCategories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Descrição</span>
        <input value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} required />
      </label>
      <NoticeText notice={notice} />
      {duplicate ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void submit(true)}>
          Registrar mesmo assim
        </button>
      ) : null}
      <button type="submit" className="btn btn--primary" disabled={busy || accounts.length === 0}>
        {busy ? "Salvando…" : "Registrar"}
      </button>
      {accounts.length === 0 ? <p className="muted">Crie uma conta em “Contas e categorias” para começar.</p> : null}
    </form>
  );
}

export function TransferForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [from, setFrom] = useState(accounts[0]?.id ?? "");
  const [to, setTo] = useState(accounts[1]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayLocal());
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cents = toPositiveCents(amount);
    if (cents === null || !from || !to || from === to) {
      setNotice({ kind: "error", text: "Escolha duas contas diferentes e um valor válido." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.createTransfer({ fromAccountId: from, toAccountId: to, amountCents: cents, date }, key.current());
      key.renew();
      setAmount("");
      setNotice({ kind: "ok", text: "Transferência realizada." });
      onDone();
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-transf">
      <h2 id="t-transf">Transferir entre contas</h2>
      <label className="field">
        <span>De</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)} required>
          {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>
      </label>
      <label className="field">
        <span>Para</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} required>
          {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>
      </label>
      <MoneyField label="Valor" value={amount} onChange={setAmount} />
      <label className="field">
        <span>Data</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <NoticeText notice={notice} />
      <button type="submit" className="btn btn--primary" disabled={busy || accounts.length < 2}>
        {busy ? "Transferindo…" : "Transferir"}
      </button>
      {accounts.length < 2 ? <p className="muted">São necessárias pelo menos duas contas.</p> : null}
    </form>
  );
}

function TransactionRow({ tx, accountName, onVoid, busy }: { tx: Transaction; accountName: string; onVoid: (tx: Transaction) => void; busy: boolean }) {
  const money = useMoney();
  const [confirming, setConfirming] = useState(false);
  const voided = tx.status === "voided";
  return (
    <li className={voided ? "row row--voided" : "row"}>
      <div className="row__main">
        <strong>{tx.description}</strong>
        <span className="muted">
          {formatDate(tx.date)} · {accountName}
          {tx.transferId ? " · transferência" : ""}
          {voided ? " · estornado" : ""}
          {tx.origin === "ai" ? (
            <>
              {" · "}
              <span className="badge badge--ai" title="Lançamento criado pelo assistente de IA, após confirmação">IA</span>
            </>
          ) : null}
        </span>
      </div>
      <div className="row__side">
        <span className={tx.signedCents >= 0 ? "amount amount--in" : "amount amount--out"}>{money(tx.signedCents)}</span>
        {!voided && !tx.transferId ? (
          confirming ? (
            <span className="row__actions">
              <button type="button" className="btn btn--danger" disabled={busy} onClick={() => onVoid(tx)}>Confirmar estorno</button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancelar</button>
            </span>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirming(true)}>Estornar</button>
          )
        ) : null}
      </div>
    </li>
  );
}

export function TransactionsPage() {
  const api = useApi();
  const initial = monthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [accountFilter, setAccountFilter] = useState("");
  const [extra, setExtra] = useState<Transaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const refs = useLoad(async () => {
    const [accounts, categories] = await Promise.all([api.listAccounts(true), api.listCategories()]);
    return { accounts: accounts.accounts, categories: categories.categories };
  }, []);
  const page = useLoad<TransactionPage>(
    () => api.listTransactions({ from, to, accountId: accountFilter, limit: 50 }),
    [from, to, accountFilter],
  );

  const reloadAll = () => {
    setExtra([]);
    refs.reload();
    page.reload();
  };

  if (refs.loading && !refs.data) return <LoadingState />;
  if (refs.error || !refs.data) return <ErrorState message={refs.error ?? "Erro ao carregar"} onRetry={refs.reload} />;

  const active = refs.data.accounts.filter((a) => !a.archived);
  const names = new Map(refs.data.accounts.map((a) => [a.id, a.name]));
  const items = [...(page.data?.items ?? []), ...extra];
  const nextCursor = extra.length > 0 ? null : page.data?.nextCursor ?? null;

  async function loadMore() {
    if (!page.data?.nextCursor) return;
    setBusy(true);
    try {
      const more = await api.listTransactions({ from, to, accountId: accountFilter, limit: 50, cursor: page.data.nextCursor });
      setExtra(more.items);
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function voidTx(tx: Transaction) {
    setBusy(true);
    setNotice(null);
    try {
      await api.voidTransaction(tx.id);
      setNotice({ kind: "ok", text: "Lançamento estornado e saldo ajustado." });
      reloadAll();
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid">
        <TransactionForm accounts={active} categories={refs.data.categories} onDone={reloadAll} />
        <TransferForm accounts={active} onDone={reloadAll} />
      </div>

      <section className="card" aria-labelledby="t-lista">
        <h2 id="t-lista">Lançamentos</h2>
        <div className="filters">
          <label className="field"><span>De</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>Até</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">
            <span>Conta</span>
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
              <option value="">Todas</option>
              {refs.data.accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
            </select>
          </label>
        </div>
        <NoticeText notice={notice} />
        {page.loading && !page.data ? <LoadingState /> : null}
        {page.error ? <ErrorState message={page.error} onRetry={page.reload} /> : null}
        {page.data && items.length === 0 ? <EmptyState title="Nenhum lançamento no período" /> : null}
        {items.length > 0 ? (
          <ul className="list">
            {items.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} accountName={names.get(tx.accountId) ?? "Conta"} onVoid={(t) => void voidTx(t)} busy={busy} />
            ))}
          </ul>
        ) : null}
        {nextCursor ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void loadMore()}>Carregar mais</button>
        ) : null}
      </section>
    </>
  );
}
