# CHANGELOG

## [Não lançado]

### Fase 3 — Agenda (2026-11-10)
- Calendário (dia/semana/mês/lista), eventos com fuso IANA, recorrências (diária, semanal, mensal, anual,
  personalizada), edição de uma ocorrência / esta e as próximas / toda a série, detecção de conflitos (só avisa).
- Tarefas com prioridade, prazo, categoria e atraso; lembretes avulsos; central de notificações com horário silencioso.
- Notificações idempotentes (ids determinísticos), geradas sob demanda; **sem Web Push nem agendador**.
- Custo previsto de evento vira despesa só por ação explícita, uma única vez.
- Regras do Firestore para 6 novas coleções; frontend em `/agenda`, `/agenda/tarefas`, `/agenda/notificacoes`.
- Testes: `pnpm test` = 274 (shared 93, web 57, api 124); emulador (CI) = 113 de regras + 75 de API.
- Decisão D-007. Limites em `PHASE_03_AGENDA.md`.

### Fase 2 — Financeiro (2026-11-09)
- Contas, categorias, receitas, despesas, transferências atômicas, estorno, contas a pagar/receber com baixa
  atômica e idempotente, recorrências sob demanda, relatórios, exportação CSV, conciliação de saldos e painel.
- Dinheiro em centavos inteiros; saldo por incremento atômico no mesmo commit do lançamento; idempotência por
  ids determinísticos (`Idempotency-Key` obrigatória nas criações); prevenção de duplicidade.
- Firestore Security Rules das 6 novas coleções (sem exclusão; imutabilidade; conta existente).
- Frontend: telas de lançamentos/transferências, contas e categorias, a pagar e receber, relatórios e painel com
  números reais da API.
- Testes: `pnpm test` = 170 (shared 62, web 31, api 77); emulador (CI) = 70 de regras + 31 de API.
- Ajuste em teste da Fase 1: `accounts` deixou de ser coleção "não declarada".
- Decisão D-006. Pendências e limites em `PHASE_02_FINANCE.md`.

### Fase 1 — Fundação (2026-11-09)
- Substituição do Supabase por Firebase (Firestore + Auth), D-004; modelo `deepseek-flash` registrado (D-005).
- Monorepo pnpm: `apps/web`, `workers/api`, `packages/shared`, `firebase`.
- Worker: validação de JWT do Firebase (RS256, `iss`, `aud`, `exp`, `sub`), cliente do Firestore por
  requisição com o token do usuário, rotas `/healthz`, `/v1/me`, `/v1/profile`, `/v1/preferences`.
- Firestore Security Rules por operação, negado por padrão, `uid` imutável.
- Frontend: login/cadastro/logout, rota protegida, layout responsivo, tema claro/escuro, PWA básica.
- Testes: 57 passando em `pnpm test`; 19 testes de regras aprovados no emulador (CI, run 42659605727);
  não executados na máquina de desenvolvimento por bloqueio de rede. Checklist manual pendente.
- CI no GitHub Actions (verify + firestore-rules).

### Fase 0 — Inspeção e inicialização (2026-11-09)
- Repositório encontrado vazio; relatório apresentado e inicialização autorizada.
- Esqueleto do monorepo e documentação permanente (Parte O). Nenhum código de aplicação.
