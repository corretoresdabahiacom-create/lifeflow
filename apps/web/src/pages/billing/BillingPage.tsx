import type { PaidPlanId, PlanConfig, SubscriptionView } from "@lifeflow/shared";
import { useEffect, useRef, useState } from "react";
import { useApi } from "../../app/ApiProvider";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { newIdempotencyKey } from "../../lib/idempotency";
import { useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

const STATUS_LABEL: Record<string, string> = {
  none: "Sem assinatura",
  pending: "Aguardando pagamento",
  active: "Ativa",
  past_due: "Pagamento pendente",
  canceled: "Cancelada",
};
const PAYMENT_LABEL: Record<string, string> = { approved: "Aprovado", rejected: "Recusado", pending: "Pendente", refunded: "Estornado" };
const dateBr = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "—");

/** Planos, assinatura, pagamentos e consumo. O plano só muda quando o provedor confirma o pagamento (webhook). */
export function BillingPage() {
  const api = useApi();
  const money = useMoney();
  const plans = useLoad(() => api.billingPlans(), []);
  const current = useLoad(() => api.billingSubscription(), []);
  const history = useLoad(() => api.billingHistory(), []);
  const usage = useLoad(() => api.aiUsage(), []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const keys = useRef(new Map<string, string>());

  const reloadAll = () => {
    plans.reload();
    current.reload();
    history.reload();
    usage.reload();
  };

  // Ao voltar do checkout (?retorno=1) o webhook pode ainda não ter chegado: consulta o provedor e repete algumas vezes.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("retorno")) return;
    let tries = 0;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      tries += 1;
      try {
        const { subscription } = await api.billingSync();
        if (subscription.status === "active" || tries >= 5) {
          reloadAll();
          if (subscription.status === "active") setMessage("Pagamento confirmado. Seu plano já está ativo.");
          return;
        }
      } catch {
        if (tries >= 5) return;
      }
      setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      reloadAll();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function subscribe(planId: PaidPlanId) {
    // A mesma chave enquanto a tentativa não termina evita assinatura duplicada em duplo clique/rede ruim.
    const key = keys.current.get(planId) ?? newIdempotencyKey();
    keys.current.set(planId, key);
    void run(async () => {
      const reply = await api.billingCheckout(planId, key);
      keys.current.delete(planId);
      if (reply.checkoutUrl) window.location.assign(reply.checkoutUrl);
      else setMessage("Assinatura criada. Aguardando a confirmação do pagamento.");
    });
  }

  const change = (planId: PaidPlanId) =>
    void run(async () => {
      const reply = await api.billingChange(planId);
      setMessage(reply.effective === "next_renewal" ? "Troca agendada para a próxima renovação." : "Plano alterado.");
    });

  const cancel = () =>
    void run(async () => {
      const reply = await api.billingCancel();
      setConfirmCancel(false);
      setMessage(reply.message ?? "Assinatura cancelada.");
    });

  if (plans.loading || current.loading) return <LoadingState />;
  if (plans.error || current.error || !plans.data || !current.data) {
    return <ErrorState message={plans.error ?? current.error ?? "Erro desconhecido"} onRetry={reloadAll} />;
  }
  const sub: SubscriptionView = current.data.subscription;
  const paid = sub.status === "active" || sub.status === "past_due";
  const u = usage.data?.usage;

  return (
    <div className="stack">
      <header>
        <h1>Assinatura</h1>
        <p className="muted">Seu plano muda assim que o pagamento é confirmado pelo provedor.</p>
      </header>

      {message ? <p className="banner" role="status">{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <section className="card" aria-labelledby="bill-current">
        <h2 id="bill-current">Seu plano</h2>
        <p>
          <strong>{plans.data.plans.find((p) => p.id === sub.plan)?.name ?? sub.plan}</strong>{" "}
          <span className="badge">{STATUS_LABEL[sub.status] ?? sub.status}</span>
        </p>
        {sub.status === "past_due" ? <p className="form-error">Não conseguimos cobrar. Seu plano segue até {dateBr(sub.graceUntil)}; atualize o pagamento no provedor.</p> : null}
        {sub.status === "pending" && sub.checkoutUrl ? (
          <p>
            Pagamento ainda não confirmado. <a href={sub.checkoutUrl}>Concluir pagamento</a>
          </p>
        ) : null}
        {sub.currentPeriodEnd ? <p className="muted">{sub.status === "canceled" ? "Acesso até" : "Próxima cobrança em"} {dateBr(sub.currentPeriodEnd)}</p> : null}
        {sub.pendingPlan ? <p className="muted">Troca agendada para o plano {plans.data.plans.find((p) => p.id === sub.pendingPlan)?.name ?? sub.pendingPlan} na próxima renovação.</p> : null}
        {u ? (
          <p className="muted">
            Uso em {u.month}: {u.messages} de {u.messagesLimit} mensagens
            {u.voiceSecondsLimit > 0 ? ` · voz ${Math.ceil(u.voiceSeconds / 60)} de ${Math.floor(u.voiceSecondsLimit / 60)} min` : " · voz não incluída"}
          </p>
        ) : null}
        {paid && sub.status === "active" && !sub.cancelAtPeriodEnd ? (
          confirmCancel ? (
            <div role="group" aria-label="Confirmar cancelamento">
              <p>Cancelar a assinatura? Você mantém o plano até o fim do período já pago.</p>
              <button type="button" className="btn btn--danger" disabled={busy} onClick={cancel}>Sim, cancelar</button>{" "}
              <button type="button" className="btn btn--ghost" onClick={() => setConfirmCancel(false)}>Voltar</button>
            </div>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmCancel(true)}>Cancelar assinatura</button>
          )
        ) : null}
      </section>

      <section aria-labelledby="bill-plans">
        <h2 id="bill-plans">Planos</h2>
        <div className="grid">
          {plans.data.plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} current={plan.id === sub.contractedPlan && sub.status !== "none"} paid={paid} busy={busy} price={money(plan.priceCents)} onSubscribe={subscribe} onChange={change} />
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="bill-history">
        <h2 id="bill-history">Pagamentos</h2>
        {history.loading ? <LoadingState /> : null}
        {history.data && history.data.payments.length === 0 ? <EmptyState title="Nenhum pagamento ainda" /> : null}
        {history.data && history.data.payments.length > 0 ? (
          <table className="table">
            <thead><tr><th>Data</th><th>Valor</th><th>Situação</th></tr></thead>
            <tbody>
              {history.data.payments.map((p) => (
                <tr key={p.id}><td>{dateBr(p.createdAt)}</td><td>{money(p.amountCents)}</td><td>{PAYMENT_LABEL[p.status] ?? p.status}</td></tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}

function PlanCard(props: {
  plan: PlanConfig;
  current: boolean;
  paid: boolean;
  busy: boolean;
  price: string;
  onSubscribe: (id: PaidPlanId) => void;
  onChange: (id: PaidPlanId) => void;
}) {
  const { plan } = props;
  const isFree = plan.id === "free";
  return (
    <article className="card" aria-label={`Plano ${plan.name}`}>
      <h3>{plan.name}</h3>
      <p><strong>{isFree ? "Grátis" : `${props.price}/mês`}</strong></p>
      <ul>
        <li>{plan.aiMessagesPerMonth} mensagens de IA por mês</li>
        <li>{plan.voiceMinutesPerMonth > 0 ? `${plan.voiceMinutesPerMonth} min de voz por mês` : "Sem voz"}</li>
        <li>Relatórios {plan.reports === "basic" ? "básicos" : plan.reports === "full" ? "completos" : "inteligentes"}</li>
        {plan.trialDays > 0 && !props.paid ? <li>{plan.trialDays} dias grátis na primeira assinatura</li> : null}
      </ul>
      {props.current ? (
        <span className="badge">Plano atual</span>
      ) : isFree ? null : props.paid ? (
        <button type="button" className="btn" disabled={props.busy} onClick={() => props.onChange(plan.id as PaidPlanId)}>Trocar para {plan.name}</button>
      ) : (
        <button type="button" className="btn" disabled={props.busy} onClick={() => props.onSubscribe(plan.id as PaidPlanId)}>Assinar {plan.name}</button>
      )}
    </article>
  );
}
