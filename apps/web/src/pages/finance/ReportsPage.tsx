import { useState } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { formatDate, monthRange, useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

function Bars({ rows }: { rows: Array<{ key: string; label: string; cents: number }> }) {
  const money = useMoney();
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.key} className="row row--stack">
          <div className="row"><span>{r.label}</span><span className="amount">{money(r.cents)}</span></div>
          <div className="bar" aria-hidden="true"><div className="bar__fill" style={{ width: `${Math.round((r.cents / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function ReportsPage() {
  const api = useApi();
  const money = useMoney();
  const initial = monthRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = useLoad(() => api.summary(from, to), [from, to]);

  async function exportCsv() {
    setBusy(true);
    setExportError(null);
    try {
      const blob = await api.exportCsv(from, to);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `lifeflow-lancamentos-${from}_${to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const data = report.data;
  return (
    <>
      <section className="card" aria-labelledby="t-periodo">
        <h2 id="t-periodo">Período</h2>
        <div className="filters">
          <label className="field"><span>De</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field"><span>Até</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="button" className="btn" disabled={busy} onClick={() => void exportCsv()}>{busy ? "Exportando…" : "Exportar CSV"}</button>
        </div>
        {exportError ? <p className="form-error" role="alert">{exportError}</p> : null}
      </section>

      {report.loading && !data ? <LoadingState /> : null}
      {report.error ? <ErrorState message={report.error} onRetry={report.reload} /> : null}
      {data ? (
        <>
          {data.truncated ? <p className="form-error" role="alert">Há lançamentos demais no período; o relatório está incompleto. Reduza o período.</p> : null}
          <div className="grid">
            <section className="card"><h2>Receitas</h2><p className="big amount--in">{money(data.totals.incomeCents)}</p></section>
            <section className="card"><h2>Despesas</h2><p className="big amount--out">{money(data.totals.expenseCents)}</p></section>
            <section className="card"><h2>Resultado</h2><p className={data.totals.netCents >= 0 ? "big amount--in" : "big amount--out"}>{money(data.totals.netCents)}</p></section>
          </div>
          <p className="muted">Transferências entre contas ({money(data.totals.transferVolumeCents)}) não contam como receita nem despesa. Lançamentos estornados ficam fora. Período: {formatDate(data.from)} a {formatDate(data.to)}.</p>

          <section className="card" aria-labelledby="t-cat-desp">
            <h2 id="t-cat-desp">Despesas por categoria</h2>
            {data.byCategory.filter((c) => c.kind === "expense").length === 0 ? <EmptyState title="Sem despesas no período" /> : (
              <Bars rows={data.byCategory.filter((c) => c.kind === "expense").map((c) => ({ key: `e-${c.categoryId ?? "none"}`, label: `${c.name} (${c.count})`, cents: c.totalCents }))} />
            )}
          </section>
          <section className="card" aria-labelledby="t-cat-rec">
            <h2 id="t-cat-rec">Receitas por categoria</h2>
            {data.byCategory.filter((c) => c.kind === "income").length === 0 ? <EmptyState title="Sem receitas no período" /> : (
              <Bars rows={data.byCategory.filter((c) => c.kind === "income").map((c) => ({ key: `i-${c.categoryId ?? "none"}`, label: `${c.name} (${c.count})`, cents: c.totalCents }))} />
            )}
          </section>
          <section className="card" aria-labelledby="t-meses">
            <h2 id="t-meses">Por mês</h2>
            {data.byMonth.length === 0 ? <EmptyState title="Sem movimentação" /> : (
              <ul className="list">
                {data.byMonth.map((m) => (
                  <li key={m.month} className="row">
                    <div className="row__main"><strong>{m.month}</strong><span className="muted">Receitas {money(m.incomeCents)} · Despesas {money(m.expenseCents)}</span></div>
                    <div className="row__side"><span className={m.netCents >= 0 ? "amount amount--in" : "amount amount--out"}>{money(m.netCents)}</span></div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card" aria-labelledby="t-contas-rel">
            <h2 id="t-contas-rel">Movimento por conta</h2>
            {data.byAccount.length === 0 ? <EmptyState title="Sem movimentação" /> : (
              <ul className="list">
                {data.byAccount.map((a) => (
                  <li key={a.accountId} className="row">
                    <div className="row__main"><strong>{a.name}</strong><span className="muted">Receitas {money(a.incomeCents)} · Despesas {money(a.expenseCents)}</span></div>
                    <div className="row__side"><span className={a.netCents >= 0 ? "amount amount--in" : "amount amount--out"}>{money(a.netCents)}</span></div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
