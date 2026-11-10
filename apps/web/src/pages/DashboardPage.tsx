import { Link } from "react-router-dom";
import { useApi } from "../app/ApiProvider";
import { useProfile } from "../app/ProfileProvider";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { Bucket } from "../lib/api";
import { useMoney } from "../lib/money";
import { useLoad } from "../lib/useLoad";

function BucketLine({ label, bucket, tone }: { label: string; bucket: Bucket; tone: "in" | "out" }) {
  const money = useMoney();
  return (
    <li className="row">
      <div className="row__main">
        <strong>{label}</strong>
        <span className="muted">{bucket.count} {bucket.count === 1 ? "conta" : "contas"}</span>
      </div>
      <div className="row__side">
        <span className={tone === "in" ? "amount amount--in" : "amount amount--out"}>{money(bucket.totalCents)}</span>
      </div>
    </li>
  );
}

/** Painel: todos os números vêm da API (nada é fixo na interface). Agenda e tarefas chegam na Fase 3. */
export function DashboardPage() {
  const { profile } = useProfile();
  const api = useApi();
  const money = useMoney();
  const overview = useLoad(() => api.overview(), []);
  const data = overview.data;

  return (
    <>
      <h1>Olá, {profile?.displayName ?? "bem-vindo"}</h1>
      <p className="muted">Resumo das suas finanças. Agenda e tarefas chegam na próxima fase.</p>

      <div className="grid">
        <section className="card" aria-labelledby="c-saldo">
          <h2 id="c-saldo">Saldo total</h2>
          {overview.loading && !data ? <LoadingState /> : null}
          {overview.error ? <ErrorState message={overview.error} onRetry={overview.reload} /> : null}
          {data && data.accounts.length === 0 ? (
            <EmptyState title="Nenhuma conta ainda">
              <Link to="/financas/contas">Crie sua primeira conta</Link> para começar.
            </EmptyState>
          ) : null}
          {data && data.accounts.length > 0 ? (
            <>
              <p className={data.totalBalanceCents >= 0 ? "big amount--in" : "big amount--out"}>{money(data.totalBalanceCents)}</p>
              <ul className="list">
                {data.accounts.map((a) => (
                  <li key={a.id} className="row">
                    <span>{a.name}</span>
                    <span className="amount">{money(a.balanceCents)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <section className="card" aria-labelledby="c-mes">
          <h2 id="c-mes">Resultado do mês</h2>
          {data ? (
            <>
              <p className={data.monthSummary.netCents >= 0 ? "big amount--in" : "big amount--out"}>{money(data.monthSummary.netCents)}</p>
              <ul className="list">
                <li className="row"><span>Receitas</span><span className="amount amount--in">{money(data.monthSummary.incomeCents)}</span></li>
                <li className="row"><span>Despesas</span><span className="amount amount--out">{money(data.monthSummary.expenseCents)}</span></li>
              </ul>
              {data.monthSummary.truncated ? <p className="form-error">Resultado parcial: muitos lançamentos no mês.</p> : null}
              <Link to="/financas/relatorios">Ver relatórios</Link>
            </>
          ) : overview.loading ? <LoadingState /> : null}
        </section>

        <section className="card" aria-labelledby="c-contas">
          <h2 id="c-contas">Contas a vencer</h2>
          {data ? (
            <>
              <ul className="list">
                <BucketLine label="Vencidas a pagar" bucket={data.payables.overdueToPay} tone="out" />
                <BucketLine label="A pagar em 7 dias" bucket={data.payables.next7ToPay} tone="out" />
                <BucketLine label="Vencidas a receber" bucket={data.payables.overdueToReceive} tone="in" />
                <BucketLine label="A receber em 7 dias" bucket={data.payables.next7ToReceive} tone="in" />
              </ul>
              <Link to="/financas/pagar-receber">Ver contas a pagar e receber</Link>
            </>
          ) : overview.loading ? <LoadingState /> : null}
        </section>

        <section className="card" aria-labelledby="c-agenda">
          <h2 id="c-agenda">Próximos compromissos</h2>
          <EmptyState title="Sem dados ainda">A agenda chega na Fase 3.</EmptyState>
        </section>
        <section className="card" aria-labelledby="c-tarefas">
          <h2 id="c-tarefas">Tarefas pendentes</h2>
          <EmptyState title="Sem dados ainda">As tarefas chegam na Fase 3.</EmptyState>
        </section>
      </div>
    </>
  );
}
