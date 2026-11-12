import type { PlanConfig, PlanConfigInput } from "@lifeflow/shared";
import { useState, type FormEvent } from "react";
import { useApi } from "../../app/ApiProvider";
import { useAuth } from "../../auth/context";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { useMoney } from "../../lib/money";
import { describeError, useLoad } from "../../lib/useLoad";

const TABS = [
  ["overview", "Visão geral"],
  ["plans", "Planos e limites"],
  ["subscriptions", "Assinaturas"],
  ["logs", "Logs"],
  ["integrations", "Integrações"],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * Painel administrativo. A exibição depende da claim `admin` do token, mas quem protege de verdade é o
 * servidor (403 em /v1/admin/*). O painel NÃO mostra dados financeiros dos clientes — só agregados.
 */
export default function AdminPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  if (!isAdmin) return <EmptyState title="Acesso restrito">Esta área é só para administradores.</EmptyState>;
  return (
    <div className="stack">
      <h1>Administração</h1>
      <div role="tablist" aria-label="Seções do painel" className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "btn" : "btn btn--ghost"} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <Overview /> : null}
      {tab === "plans" ? <Plans /> : null}
      {tab === "subscriptions" ? <Subscriptions /> : null}
      {tab === "logs" ? <Logs /> : null}
      {tab === "integrations" ? <Integrations /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card">
      <span className="muted">{label}</span>
      <strong style={{ display: "block", fontSize: "1.5rem" }}>{value}</strong>
    </div>
  );
}

function Overview() {
  const api = useApi();
  const money = useMoney();
  const { data, error, loading, reload } = useLoad(() => api.adminOverview(), []);
  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? "Erro"} onRetry={reload} />;
  const s = data.subscriptions;
  return (
    <div className="stack">
      <div className="grid">
        <Stat label="Usuários" value={data.users.total} />
        <Stat label="Assinaturas ativas" value={s.byStatus["active"] ?? 0} />
        <Stat label="Receita mensal recorrente (MRR)" value={money(s.mrrCents)} />
        <Stat label="Cancelamentos (30 dias)" value={s.canceledLast30d} />
        <Stat label="Usuários ativos na IA (mês)" value={data.ai.activeUsers} />
        <Stat label="Mensagens de IA (mês)" value={data.ai.messages} />
        <Stat label="Custo estimado de IA (US$)" value={data.ai.estimatedCostUsd.toFixed(2)} />
        <Stat label="Erros do provedor de IA (mês)" value={data.errors.aiProviderErrorsThisMonth} />
        <Stat label="Webhooks com falha" value={data.errors.failedWebhooks} />
      </div>
      <p className="muted">{data.ai.costNote} {data.notifications.note}</p>
      {s.truncated || data.ai.truncated ? <p className="muted">Números parciais: há mais registros que o limite de leitura.</p> : null}
    </div>
  );
}

function Plans() {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.adminPlans(), []);
  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? "Erro"} onRetry={reload} />;
  return (
    <div className="stack">
      <p className="muted">Mudanças valem para novas assinaturas e para os limites de uso imediatamente. Quem já assina paga o novo valor na próxima cobrança.</p>
      {data.plans.map((plan) => (
        <PlanForm key={plan.id} plan={plan} onSaved={reload} />
      ))}
    </div>
  );
}

function PlanForm({ plan, onSaved }: { plan: PlanConfig; onSaved: () => void }) {
  const api = useApi();
  const [form, setForm] = useState<PlanConfigInput>({
    name: plan.name,
    priceCents: plan.priceCents,
    aiMessagesPerMonth: plan.aiMessagesPerMonth,
    voiceMinutesPerMonth: plan.voiceMinutesPerMonth,
    reports: plan.reports,
    trialDays: plan.trialDays,
    active: plan.active,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const num = (key: "priceCents" | "aiMessagesPerMonth" | "voiceMinutesPerMonth" | "trialDays") => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: Number.isFinite(e.target.valueAsNumber) ? Math.trunc(e.target.valueAsNumber) : 0 }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.adminPutPlan(plan.id, form);
      setMessage("Plano salvo.");
      onSaved();
    } catch (e) {
      setError(describeError(e));
    }
  }
  const free = plan.id === "free";
  return (
    <form className="card form" onSubmit={(e) => void save(e)} aria-label={`Editar plano ${plan.name}`}>
      <h2>{plan.name}</h2>
      <label>Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Preço mensal (centavos)<input type="number" min={0} value={form.priceCents} disabled={free} onChange={num("priceCents")} /></label>
      <label>Mensagens de IA por mês<input type="number" min={0} value={form.aiMessagesPerMonth} onChange={num("aiMessagesPerMonth")} /></label>
      <label>Minutos de voz por mês<input type="number" min={0} value={form.voiceMinutesPerMonth} onChange={num("voiceMinutesPerMonth")} /></label>
      <label>Dias de teste gratuito<input type="number" min={0} value={form.trialDays} disabled={free} onChange={num("trialDays")} /></label>
      <label>
        Relatórios
        <select value={form.reports} onChange={(e) => setForm({ ...form, reports: e.target.value as PlanConfigInput["reports"] })}>
          <option value="basic">Básicos</option>
          <option value="full">Completos</option>
          <option value="smart">Inteligentes</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={form.active} disabled={free} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span>Disponível para novas assinaturas</span></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <button type="submit" className="btn">Salvar</button>
    </form>
  );
}

function Subscriptions() {
  const api = useApi();
  const money = useMoney();
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [uid, setUid] = useState<string | null>(null);
  const list = useLoad(() => api.adminSubscriptions({ ...(plan ? { plan } : {}), ...(status ? { status } : {}) }), [plan, status]);
  const detail = useLoad(() => (uid ? api.adminSubscription(uid) : Promise.resolve(null)), [uid]);
  return (
    <div className="stack">
      <div className="form">
        <label>Plano<select value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">Todos</option><option value="pro">Pro</option><option value="premium_ai">Premium AI</option></select></label>
        <label>Situação<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todas</option><option value="active">Ativa</option><option value="pending">Pendente</option><option value="past_due">Inadimplente</option><option value="canceled">Cancelada</option></select></label>
      </div>
      {list.loading ? <LoadingState /> : null}
      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : null}
      {list.data && list.data.subscriptions.length === 0 ? <EmptyState title="Nenhuma assinatura" /> : null}
      {list.data && list.data.subscriptions.length > 0 ? (
        <table className="table">
          <thead><tr><th>Usuário</th><th>Plano</th><th>Situação</th><th>Valor</th><th>Período até</th><th /></tr></thead>
          <tbody>
            {list.data.subscriptions.map((s) => (
              <tr key={s.uid}>
                <td title={s.uid}>{s.uid.slice(0, 8)}…</td><td>{s.planId}</td><td>{s.status}</td><td>{money(s.priceCents)}</td>
                <td>{s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString("pt-BR") : "—"}</td>
                <td><button type="button" className="btn btn--ghost" onClick={() => setUid(s.uid)}>Detalhes</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {uid && detail.data ? (
        <section className="card" aria-label="Detalhe da assinatura">
          <h2>Pagamentos de {uid.slice(0, 8)}…</h2>
          {detail.data.payments.length === 0 ? <p className="muted">Sem pagamentos.</p> : (
            <ul>{detail.data.payments.map((p) => <li key={p.id}>{new Date(p.createdAt).toLocaleDateString("pt-BR")} — {money(p.amountCents)} — {p.status}</li>)}</ul>
          )}
          <button type="button" className="btn btn--ghost" onClick={() => setUid(null)}>Fechar</button>
        </section>
      ) : null}
    </div>
  );
}

function Logs() {
  const api = useApi();
  const [kind, setKind] = useState<"admin" | "webhooks">("admin");
  const { data, error, loading, reload } = useLoad(() => api.adminLogs(kind), [kind]);
  return (
    <div className="stack">
      <div role="group" aria-label="Tipo de log">
        <button type="button" className={kind === "admin" ? "btn" : "btn btn--ghost"} onClick={() => setKind("admin")}>Ações do painel</button>{" "}
        <button type="button" className={kind === "webhooks" ? "btn" : "btn btn--ghost"} onClick={() => setKind("webhooks")}>Webhooks</button>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState message={error} onRetry={reload} /> : null}
      {data && data.logs.length === 0 ? <EmptyState title="Sem registros" /> : null}
      {data && data.logs.length > 0 ? (
        <ul className="stack">
          {data.logs.map((l) => (
            <li key={l.id} className="card"><code>{JSON.stringify({ ...l, id: undefined })}</code></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Integrations() {
  const api = useApi();
  const { data, error, loading, reload } = useLoad(() => api.adminIntegrations(), []);
  if (loading) return <LoadingState />;
  if (error || !data) return <ErrorState message={error ?? "Erro"} onRetry={reload} />;
  return (
    <div className="stack">
      <ul>{data.integrations.map((i) => <li key={i.name}>{i.name}: <strong>{i.configured ? "configurado" : "não configurado"}</strong>{typeof i["note"] === "string" ? ` — ${i["note"]}` : ""}</li>)}</ul>
      <p className="muted">{data.note}</p>
    </div>
  );
}
