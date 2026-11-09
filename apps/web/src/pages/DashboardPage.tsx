import { useProfile } from "../app/ProfileProvider";
import { EmptyState } from "../components/States";

/**
 * Fase 1: estrutura do painel. Nenhum número é exibido aqui porque ainda não existem dados
 * financeiros ou de agenda no banco (todos os valores futuros virão do banco, nunca fixos).
 */
export function DashboardPage() {
  const { profile } = useProfile();

  return (
    <>
      <h1>Olá, {profile?.displayName ?? "bem-vindo"}</h1>
      <p className="muted">Seu painel será preenchido conforme as próximas funcionalidades forem liberadas.</p>

      <div className="grid">
        <section className="card" aria-labelledby="c-saldo">
          <h2 id="c-saldo">Saldo e resultado do mês</h2>
          <EmptyState title="Sem dados ainda">Contas e lançamentos chegam na Fase 2.</EmptyState>
        </section>
        <section className="card" aria-labelledby="c-contas">
          <h2 id="c-contas">Contas a vencer</h2>
          <EmptyState title="Sem dados ainda">Contas a pagar e receber chegam na Fase 2.</EmptyState>
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
