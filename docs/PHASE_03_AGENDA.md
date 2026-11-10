# FASE 3 — AGENDA

**Status:** implementada; **aguardando aprovação do responsável**. A Fase 4 não foi iniciada.
Comandos obrigatórios e testes automatizados aprovados (inclusive no emulador real do Firestore, na CI).
**O checklist manual no navegador com Firebase real não foi executado** (ver "Checklist").
Decisões: `DECISIONS.md` D-007.

## O que foi entregue

| Item do contrato | Onde | Estado |
|---|---|---|
| Calendário (visões dia, semana, mês, lista) | `apps/web/src/pages/agenda/CalendarPage.tsx`, `calendar.ts` | Implementado; testes de componente; verificação visual com dados simulados |
| Eventos (criar, editar, excluir; tipo, local, contato, link, custo previsto, observações) | `workers/api/src/agenda/events.ts`, `packages/shared/src/agenda.ts` | Implementado e testado |
| Fuso horário (IANA, horário de verão) | `packages/shared/src/timezone.ts` | Implementado e testado |
| Recorrências (diária, semanal, mensal, anual, personalizada; fim por data ou contagem) | `packages/shared/src/agenda.ts` | Implementado e testado |
| Editar/excluir uma ocorrência, "esta e as próximas", "toda a série" | `agenda/events.ts` (`eventExceptions`, divisão de série) | Implementado e testado |
| Detecção de conflitos (aviso ao vivo e após salvar; nunca bloqueia) | `agenda/events.ts`, `EventForm.tsx` | Implementado e testado |
| Tarefas (prioridade, prazo, categoria, status, conclusão idempotente, atraso) | `agenda/tasks.ts`, `TasksPage.tsx` | Implementado e testado |
| Lembretes (de evento, de tarefa, avulsos) e notificações (central, ler, dispensar, horário silencioso) | `agenda/notifications.ts`, `NotificationsPage.tsx` | Implementado e testado |
| Agenda × financeiro: custo previsto vira despesa só por ação explícita | `POST /v1/events/{id}/expense` | Implementado e testado |
| Regras do Firestore + testes de isolamento | `firebase/firestore.rules`, `firebase/tests/agenda.rules.test.ts` | Implementado; 43 testes aprovados no emulador (CI) |

Endpoints: `API.md`. Modelo de dados: `DATABASE.md`.

## Como as garantias foram obtidas

- **Horário local + fuso:** o evento guarda data `AAAA-MM-DD`, hora `HH:MM` e fuso IANA. O instante UTC é derivado
  (`zonedToUtcMs`, via `Intl`). Um evento das 09:00 continua às 09:00 locais ao cruzar o horário de verão.
  Horário inexistente (salto) avança; horário repetido usa a primeira ocorrência.
- **Recorrência:** cada data é calculada a partir da data inicial (31/jan → 28/fev → 31/mar, sem "deriva").
  A contagem conta a partir do início.
- **Editar só uma ocorrência:** a série não é reescrita; grava-se uma exceção (`eventExceptions`) com os campos
  alterados ou `canceled`. As demais ocorrências vêm da regra e permanecem corretas.
- **"Esta e as próximas":** um único `documents:commit` encerra a série original na véspera e cria a nova série.
- **Conflitos:** intervalos `[início, fim)` em UTC; encostar não é conflito; dia inteiro fica de fora; só avisa.
- **Idempotência dos lembretes:** o id da notificação é determinístico
  (`evento + ocorrência + data/hora de início + antecedência`) e a criação usa `exists:false`. Gerar duas vezes,
  ou duas gerações simultâneas, produz uma única notificação. Mudar o horário do evento gera lembrete novo.
- **Sem despesa automática:** o custo previsto é só um número. A despesa real exige ação do usuário e é gravada
  em um commit (lançamento + saldo + vínculo). Segunda tentativa → `409 expense_already_linked`.
- **Isolamento:** caminhos derivados do `uid` do token; regras por dono; ids validados.

## Resultados reais

Node 22, pnpm 9.15.0. Códigos de saída capturados nesta sessão.

| Comando | Saída | Resultado |
|---|---|---|
| `pnpm lint` | 0 | sem erros |
| `pnpm typecheck` | 0 | sem erros |
| `pnpm test` | 0 | **274 testes**: shared 93, web 57, api 124 (inclui 47 da agenda no Firestore falso) |
| `pnpm build` | 0 | web: JS 483,8 kB (126,1 kB gzip); Worker: `wrangler deploy --dry-run` ok, 306,8 KiB (60,3 KiB gzip) |

**No emulador real do Firestore (somente na CI):** execução `42783050907` (commit `14501a9`, `develop`), jobs verdes.
Essa execução cobre o backend e as regras; o commit final desta fase (frontend e documentação) tem execução própria,
registrada no `CHANGELOG.md`/relatório final.

| Suíte | Resultado |
|---|---|
| `pnpm test:rules` | **113 testes**: 19 da Fase 1 + 51 financeiros + 43 da agenda |
| `pnpm test:integration` | **75 testes**: 31 financeiros + 44 da agenda (a suíte da agenda no emulador real com as regras reais, menos 3 testes que dependem do banco falso) |

### Mapa dos testes obrigatórios (em `workers/api/test/agenda.suite.ts`, salvo indicação)

| Teste obrigatório | Testes |
|---|---|
| Criar evento | "cria evento com todos os campos e lê de volta"; "valida a entrada…"; "evento de dia inteiro…" |
| Editar evento | "edita um evento simples"; "toda a série: a mudança vale para todas…" |
| Excluir evento | "exclui um evento; depois ele não existe mais"; "excluir a série apaga também as exceções" |
| Recorrência | "recorrências diária, semanal, mensal, anual e personalizada"; "esta e as próximas…" (2); "exclui esta e as próximas, e depois a série inteira"; unitários em `packages/shared/src/agenda.test.ts` (31) |
| Fuso horário | "fuso horário: o mesmo horário de parede em fusos diferentes não conflita…"; "…instantes UTC corretos e horário local mantido ao cruzar o horário de verão"; "usa o fuso do perfil…"; unitários de `timezone` |
| Detecção de conflitos | "checklist: eventos sobrepostos geram alerta, mas não são impedidos"; "encostar… e dia inteiro não são conflito"; "check-conflicts avisa antes de criar…"; "conflitos de uma série recorrente…" |
| Idempotência dos lembretes | "lembrete de evento: dispara no horário certo e NÃO duplica ao repetir a geração"; "gerações simultâneas continuam sem duplicar"; "lembrete de tarefa e aviso de atraso: cada um uma única vez"; "alterar o horário do evento gera lembrete novo…"; "central de notificações… e não voltar a gerar" |
| Isolamento | "isolamento: um usuário não vê, edita, exclui nem recebe notificação de outro"; regras: `agenda.rules.test.ts` (43) |

## Checklist da fase

| Item | Estado |
|---|---|
| Criar eventos sobrepostos e confirmar o alerta | **Automatizado** ("checklist: eventos sobrepostos…") e visto na tela com dados simulados (selo "Conflito" e contagem). **Não** executado manualmente com Firebase real |
| Criar evento recorrente | **Automatizado**; visual com dados simulados. Manual real: não executado |
| Editar só uma ocorrência | **Automatizado** ("checklist: edita apenas UMA ocorrência e as demais permanecem corretas"); visual (selo "Editada"). Manual real: não executado |
| Confirmar que as demais permanecem corretas | **Automatizado** (mesmo teste) |

A verificação visual usou uma página temporária, não versionada, com cliente de API simulado: ela confirma o layout
(390 px de largura) e os selos, **não** o fluxo contra o backend real.

## Limites e pendências (honestos)

- **Sem Web Push (VAPID) e sem agendador.** Não há conta de serviço (D-004), então nada roda sozinho em segundo
  plano. As notificações são geradas quando o usuário abre a agenda e a cada 5 minutos enquanto ela está aberta.
  **Com o app fechado, nenhuma notificação é entregue.** Entrega com o app fechado exige Web Push + agendador
  (Cloudflare Cron + credencial restrita), a decidir.
- **Limite de subrequisições do Worker** (assumido 50, de memória) **não verificado**. `generate` é limitado e há
  teste do número de chamadas ao banco no Firestore falso (~10); o valor real do limite deve ser conferido.
- **Índices do Firestore não validados em projeto real.** As consultas usam um único filtro/ordenação e o resto é
  filtrado em memória; o emulador não valida índices.
- **Limite da Fase 2 permanece:** o cliente tem o próprio token, então um cliente malicioso poderia gravar saldo
  inconsistente no próprio usuário; detectável por `reconcile`.
- **Sem projeto Firebase real**, sem teste manual no navegador, `main` ainda sem proteção, CSP `connect-src` provisório.
- **Custo:** ver `COSTS.md` (leituras a cada 5 min por aba aberta).
