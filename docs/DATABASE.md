# DATABASE

> Banco: **Supabase (PostgreSQL + Supabase Auth)** — decisão D-011 (2026-11-23). Substitui o Firestore da D-004.
> Esquema, RLS, gatilhos e funções: `supabase/migrations/*.sql` (fonte da verdade, versionada no Git).

## Princípios

- Toda tabela pessoal tem `user_id uuid not null references auth.users(id) on delete cascade`; apagar o usuário apaga tudo.
- Colunas em `snake_case`; o Worker converte de/para `camelCase` na borda (`user_id` ↔ `uid`).
- Dinheiro: centavos em `bigint` (domínios `lf_cents` ≥/≤ ±10^11 e `lf_pos_cents` > 0). Sem `float`.
- Datas e horas: `text` com domínios (`lf_date` AAAA-MM-DD, `lf_time` HH:MM, `lf_ts` ISO-8601 UTC) — o mesmo formato da API.
- `version bigint`: incrementado por gatilho a cada alteração; é o antigo `updateTime` (pré-condição de escrita otimista).
- Ids de documento: `^[A-Za-z0-9_-]{1,80}$` (CHECK), determinísticos nas criações (idempotência, D-006).
- **RLS ligada em todas as tabelas**, negado por padrão. O cliente nunca recebe `DELETE` onde a regra antiga o proibia.

## Tabelas (26)

| Grupo | Tabelas | Observações |
|---|---|---|
| Perfil | `profiles`, `preferences` (`app`, `ai`), `consents` (`audio`) | perfil sem DELETE; `created_at` imutável; consentimento sem DELETE |
| Financeiro | `accounts`, `categories`, `transactions`, `transfers`, `payables`, `recurring` | nenhuma permite DELETE; lançamento/transferência só mudam por estorno (`posted→voided`) ou metadados; FK composta lançamento→conta do mesmo dono |
| Agenda | `events`, `event_exceptions`, `tasks`, `task_categories`, `reminders`, `notifications` | eventos, exceções, tarefas e lembretes podem ser excluídos; notificações só avançam `read/dismissed` e nunca são apagadas |
| IA | `ai_conversations`, `ai_messages`, `ai_actions`, `ai_logs`, `ai_usage`, `ai_daily` | mensagens imutáveis; ação nasce `pending`; só `status`, `result_note` e `updated_at` mudam, e só a partir de `pending`/`executing` (de `executing` apenas para `done`/`failed`/`blocked`); estados finais são imutáveis; `ai_logs` só inclusão; contadores só crescem |
| SaaS | `plans`, `subscriptions`, `billing_payments`, `webhook_events`, `admin_logs` | o dono só LÊ assinatura/cobranças; planos legíveis por usuários logados; webhooks e logs administrativos só para `service_role` |

`overdue` (vencida) **não é gravado**: é derivado na leitura. Lançamentos têm `origin` (`manual|ai`) e `ai_action_id`.

### Eventos e exceções (esparsas)
`event_exceptions` guarda só o que a ocorrência sobrescreve. A coluna `present_fields text[]` distingue "herda da série" (ausente) de
"sobrescrito com nulo" (presente). O Worker/`lf_get` devolvem apenas os campos presentes.

## Camada de acesso (`lf_*`)

O Worker fala "documentos com caminho" (`users/{uid}/accounts/{id}`, `subscriptions/{uid}`, `plans/{id}`…) e as funções traduzem para as tabelas:

| Função | Faz |
|---|---|
| `lf_get(path)` | devolve `{data, version}` ou `null` (id de usuário que nem é UUID → `null`) |
| `lf_commit(ops)` | **uma transação**: `fields`, `merge`, `increments` (atômicos), `precondition` (`exists` / `updateTime`=`version`), `delete` |
| `lf_query(parent, collection, spec)` | filtros (`EQUAL`, `>=`, `<=`), ordenação (+ desempate por id), cursor `after`, limite (≤ 5000), consulta de grupo |
| `lf_count(collection, filters)` | contagem |
| `lf_erase_user(uid)` | exclusão de conta (só `service_role`) |

Todas são `SECURITY INVOKER` (a RLS vale), com `EXECUTE` só para `authenticated` e `service_role`. Erros: `PT409` pré-condição (HTTP 409),
`PT403` gatilho negou, `42501` RLS (403), `22023`/`22xxx`/`23514` dado inválido (400). O Worker traduz 400/403/409 de regra em `403 forbidden`
e `PT409` em `PreconditionFailedError`.

## Ordenação e comparação

Como no Firestore: texto comparado em colação `C` (bytes), NULL primeiro em ASC e último em DESC. Filtros de data parcial (`>= '2026-11'`)
funcionam porque a comparação é feita como texto, sem validar o domínio.

## Índices

Chaves primárias `(user_id, id)` atendem a maior parte das consultas. Índices adicionais: `ai_usage(updated_at)`, `ai_logs(event, created_at)`,
`subscriptions(provider_subscription_id)`, `subscriptions(status)`, `webhook_events(status)`. **Não foram medidos em volume real.** Com
mais dados, criar índices compostos por `(user_id, date)` etc. via nova migração.

## Migrações

`supabase/migrations/AAAAMMDDhhmmss_nome.sql`, ordem cronológica, **só aditivas depois de publicadas** (nunca editar uma migração já aplicada
em staging/produção). Aplicar com `supabase db push` (workflow Deploy). Testar localmente: `pnpm test` (PGlite) e `pnpm test:integration`
(`supabase start`).

| Migração | Conteúdo |
|---|---|
| `…000001_schema.sql` | domínios, 26 tabelas, CHECKs, FKs, índices |
| `…000002_security.sql` | gatilhos (versão, imutabilidade, transições, contadores), RLS, políticas, privilégios |
| `…000003_api.sql` | funções `lf_*` e `lf_erase_user` |

## Integridade

Garantida pelo próprio banco: tipos, domínios, CHECKs, FKs (inclusive compostas), gatilhos e RLS — além da validação no Worker.
Continua valendo o limite conhecido (D-006): o cliente, com o próprio JWT, pode escrever nos próprios dados fora do Worker dentro do que a
RLS/gatilhos permitem; o saldo é conferido por `/v1/reconcile`.
