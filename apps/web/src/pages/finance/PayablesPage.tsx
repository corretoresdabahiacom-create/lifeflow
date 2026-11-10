import { FREQUENCIES, type Account, type Category, type Payable, type RecurringRule } from "@lifeflow/shared";
import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { MoneyField, toPositiveCents } from "../../components/MoneyField";
import { useIdempotencyKey } from "../../lib/idempotency";
import { formatDate, todayLocal, useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

const FREQ_LABELS = { weekly: "Semanal", monthly: "Mensal", yearly: "Anual" } as const;
const STATUS_FILTERS = [
  { value: "open", label: "Em aberto" },
  { value: "overdue", label: "Vencidas" },
  { value: "paid", label: "Pagas/recebidas" },
  { value: "", label: "Todas" },
] as const;

function PayableForm({ accounts, categories, onDone }: { accounts: Account[]; categories: Category[]; onDone: () => void }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const [kind, setKind] = useState<"payable" | "receivable">("payable");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(todayLocal());
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cents = toPositiveCents(amount);
    if (cents === null) {
      setError("Informe um valor válido.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createPayable({ kind, description, amountCents: cents, dueDate, categoryId: categoryId || null }, key.current());
      key.renew();
      setDescription("");
      setAmount("");
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  const wanted = kind === "payable" ? "expense" : "income";
  return (
    <form className="card form" onSubmit={(e) => void onSubmit(e)} aria-labelledby="t-nova-conta-pr">
      <h2 id="t-nova-conta-pr">Nova conta a pagar/receber</h2>
      <div className="seg" role="group" aria-label="Tipo">
        <button type="button" className={kind === "payable" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={kind === "payable"} onClick={() => { setKind("payable"); setCategoryId(""); }}>A pagar</button>
        <button type="button" className={kind === "receivable" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={kind === "receivable"} onClick={() => { setKind("receivable"); setCategoryId(""); }}>A receber</button>
      </div>
      <label className="field"><span>Descrição</span><input value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} required /></label>
      <MoneyField label="Valor" value={amount} onChange={setAmount} />
      <label className="field"><span>Vencimento</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></label>
      <label className="field">
        <span>Categoria</span>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Sem categoria</option>
          {categories.filter((c) => c.kind === wanted).map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
        </select>
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={busy || accounts.length === 0}>{busy ? "Salvando…" : "Adicionar"}</button>
    </form>
  );
}

/** Baixa: escolhe a conta e a data; a baixa gera o lançamento e ajusta o saldo de forma atômica. */
function PayableRow({ item, accounts, onChanged }: { item: Payable; accounts: Account[]; onChanged: () => void }) {
  const api = useApi();
  const money = useMoney();
  const key = useIdempotencyKey();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(item.accountId ?? accounts[0]?.id ?? "");
  const [date, setDate] = useState(todayLocal());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      await api.payPayable(item.id, { accountId, date }, key.current());
      key.renew();
      setOpen(false);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelPayable(item.id);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const label = item.kind === "payable" ? "Pagar" : "Receber";
  const statusText = item.status === "paid" ? (item.kind === "payable" ? "paga" : "recebida") : item.status === "canceled" ? "cancelada" : item.overdue ? "vencida" : "em aberto";
  return (
    <li className={item.status === "open" ? "row row--stack" : "row row--stack row--voided"}>
      <div className="row">
        <div className="row__main">
          <strong>{item.description}</strong>
          <span className="muted">Vence em {formatDate(item.dueDate)} · {item.kind === "payable" ? "a pagar" : "a receber"} · {statusText}</span>
        </div>
        <div className="row__side">
          <span className={item.kind === "receivable" ? "amount amount--in" : "amount amount--out"}>{money(item.amountCents)}</span>
          {item.overdue ? <span className="badge badge--danger">Vencida</span> : null}
          {item.status === "open" ? (
            <span className="row__actions">
              <button type="button" className="btn btn--primary" disabled={accounts.length === 0} onClick={() => setOpen((v) => !v)}>{label}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void cancel()}>Cancelar</button>
            </span>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="inline-form">
          <label className="field"><span>Conta</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}</select>
          </label>
          <label className="field"><span>Data</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void pay()}>{busy ? "Baixando…" : `Confirmar (${money(item.amountCents)})`}</button>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </li>
  );
}

function RecurringSection({ accounts, categories }: { accounts: Account[]; categories: Category[] }) {
  const api = useApi();
  const key = useIdempotencyKey();
  const rules = useLoad(() => api.listRecurring(), []);
  const [kind, setKind] = useState<"payable" | "receivable">("payable");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<RecurringRule["frequency"]>("monthly");
  const [startDate, setStartDate] = useState(todayLocal());
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    const cents = toPositiveCents(amount);
    if (cents === null) {
      setNotice({ kind: "error", text: "Informe um valor válido." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.createRecurring({ kind, description, amountCents: cents, frequency, startDate }, key.current());
      key.renew();
      setDescription("");
      setAmount("");
      rules.reload();
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.materialize();
      setNotice({
        kind: "ok",
        text: result.created === 0 ? "Nenhuma conta nova a gerar." : `${result.created} conta(s) gerada(s) até ${formatDate(result.through)}.${result.hasMore ? " Há mais: gere novamente." : ""}`,
      });
      rules.reload();
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(rule: RecurringRule) {
    setBusy(true);
    try {
      await api.patchRecurring(rule.id, { active: !rule.active });
      rules.reload();
    } catch (e) {
      setNotice({ kind: "error", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }
  void accounts;
  void categories;

  return (
    <section className="card" aria-labelledby="t-rec">
      <h2 id="t-rec">Recorrências</h2>
      <p className="muted">As contas das recorrências só são geradas quando você pede (botão abaixo). Nada é criado automaticamente.</p>
      <form className="form" onSubmit={(e) => void create(e)}>
        <div className="seg" role="group" aria-label="Tipo da recorrência">
          <button type="button" className={kind === "payable" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={kind === "payable"} onClick={() => setKind("payable")}>A pagar</button>
          <button type="button" className={kind === "receivable" ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={kind === "receivable"} onClick={() => setKind("receivable")}>A receber</button>
        </div>
        <label className="field"><span>Descrição</span><input value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} required /></label>
        <MoneyField label="Valor" value={amount} onChange={setAmount} />
        <label className="field"><span>Frequência</span>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringRule["frequency"])}>{FREQUENCIES.map((f) => (<option key={f} value={f}>{FREQ_LABELS[f]}</option>))}</select>
        </label>
        <label className="field"><span>Primeiro vencimento</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required /></label>
        <button type="submit" className="btn btn--primary" disabled={busy}>Criar recorrência</button>
      </form>
      <button type="button" className="btn" disabled={busy} onClick={() => void generate()}>Gerar contas dos próximos 60 dias</button>
      {notice ? <p className={notice.kind === "ok" ? "form-ok" : "form-error"} role={notice.kind === "ok" ? "status" : "alert"}>{notice.text}</p> : null}
      {rules.loading && !rules.data ? <LoadingState /> : null}
      {rules.error ? <ErrorState message={rules.error} onRetry={rules.reload} /> : null}
      {rules.data && rules.data.rules.length > 0 ? (
        <ul className="list">
          {rules.data.rules.map((r) => (
            <li key={r.id} className={r.active ? "row" : "row row--voided"}>
              <div className="row__main"><strong>{r.description}</strong><span className="muted">{FREQ_LABELS[r.frequency]} desde {formatDate(r.startDate)}{r.active ? "" : " · pausada"}</span></div>
              <div className="row__side"><button type="button" className="btn" disabled={busy} onClick={() => void toggle(r)}>{r.active ? "Pausar" : "Retomar"}</button></div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function PayablesPage() {
  const api = useApi();
  const [status, setStatus] = useState<string>("open");
  const refs = useLoad(async () => {
    const [accounts, categories] = await Promise.all([api.listAccounts(), api.listCategories()]);
    return { accounts: accounts.accounts, categories: categories.categories };
  }, []);
  const list = useLoad(() => api.listPayables({ status, limit: 100 }), [status]);

  if (refs.loading && !refs.data) return <LoadingState />;
  if (refs.error || !refs.data) return <ErrorState message={refs.error ?? "Erro ao carregar"} onRetry={refs.reload} />;

  return (
    <>
      <PayableForm accounts={refs.data.accounts} categories={refs.data.categories} onDone={list.reload} />
      <section className="card" aria-labelledby="t-pr-lista">
        <h2 id="t-pr-lista">Contas</h2>
        <div className="seg" role="group" aria-label="Filtro">
          {STATUS_FILTERS.map((f) => (
            <button key={f.label} type="button" className={status === f.value ? "seg__btn seg__btn--on" : "seg__btn"} aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>{f.label}</button>
          ))}
        </div>
        {list.loading && !list.data ? <LoadingState /> : null}
        {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : null}
        {list.data && list.data.items.length === 0 ? <EmptyState title="Nenhuma conta nesta lista" /> : null}
        {list.data && list.data.items.length > 0 ? (
          <ul className="list">
            {list.data.items.map((item) => (
              <PayableRow key={item.id} item={item} accounts={refs.data?.accounts ?? []} onChanged={() => { list.reload(); refs.reload(); }} />
            ))}
          </ul>
        ) : null}
      </section>
      <RecurringSection accounts={refs.data.accounts} categories={refs.data.categories} />
    </>
  );
}
