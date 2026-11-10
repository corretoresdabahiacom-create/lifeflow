# FASE 2 — FINANCEIRO

**Status:** implementada; **aguardando aprovação do responsável**. A Fase 3 não foi iniciada.
Comandos obrigatórios e testes automatizados aprovados (inclusive no emulador real do Firestore, na CI).
**O checklist manual no navegador com Firebase real não foi executado** (ver "Checklist"). Decisões: `DECISIONS.md` D-006.

## O que foi entregue

| Item do contrato | Onde | Estado |
|---|---|---|
| Contas (corrente, poupança, dinheiro, cartão, investimento), saldo inicial, arquivamento | `workers/api/src/finance/accounts.ts` | Implementado e testado |
| Categorias de receita e despesa | idem | Implementado e testado |
| Receitas e despesas (livro-razão), edição de metadados, estorno | `finance/ledger.ts` | Implementado e testado |
| Transferências atômicas e estorno de transferência | `finance/ledger.ts` | Implementado e testado |
| Contas a pagar/receber, vencidas (derivado), baixa atômica e idempotente, cancelamento | `finance/payables.ts` | Implementado e testado |
| Recorrências (semanal, mensal, anual), geração sob demanda sem duplicidade | `finance/payables.ts`, `packages/shared/src/recurrence.ts` | Implementado e testado |
| Relatórios (período, por categoria/conta/mês), exportação CSV | `finance/reports.ts`, `summary.ts` | Implementado e testado |
| Conciliação de saldos | `finance/reports.ts` | Implementado e testado |
| Regras do Firestore + testes de isolamento | `firebase/firestore.rules`, `firebase/tests/finance.rules.test.ts` | Implementado; 51 testes aprovados no emulador (CI) |
| Frontend: lançamentos, transferências, contas e categorias, a pagar/receber, recorrências, relatórios, painel | `apps/web/src/pages/**` | Implementado; testes de componente; **não verificado visualmente com dados reais** |

Endpoints: ver `API.md`. Modelo de dados: `DATABASE.md`.

## Como as garantias foram obtidas

- **Saldos consistentes:** `balanceCents` muda só por incremento atômico no servidor, no mesmo `documents:commit`
  do lançamento. Estorno reverte com o mesmo mecanismo. `GET /v1/reconcile` confere `saldo inicial + soma dos
  lançamentos efetivados` contra o saldo guardado.
- **Transferência atômica:** um único commit com 5 gravações (transferência, 2 pernas, 2 saldos).
- **Idempotência:** id do documento derivado de `Idempotency-Key`; gravação com `exists=false`; repetição devolve o
  original; chave reutilizada com outro conteúdo → 422; simultâneas → um único efeito.
- **Prevenção de duplicidade:** além da idempotência, lançamento igual com chave diferente → 409 até o usuário confirmar.
- **Baixa:** commit único com pré-condição de `updateTime` + lançamento com id determinístico + saldo.
- **Isolamento:** caminhos derivados do `uid` do token; regras por dono; ids validados; sem exclusão.

## Resultados reais

Código-fonte da fase em `develop`. Node 22, pnpm 9.15.0. Códigos de saída capturados.

| Comando | Saída | Resultado |
|---|---|---|
| `pnpm lint` | 0 | sem erros |
| `pnpm typecheck` | 0 | 4 pacotes sem erros |
| `pnpm test` | 0 | **170 testes**: shared 62, web 31, api 77 (inclui 35 testes financeiros no Firestore falso) |
| `pnpm build` | 0 | web: JS 448 kB (117 kB gzip); Worker: `wrangler deploy --dry-run` ok, 245 KiB (47,7 KiB gzip) |

**No emulador real do Firestore (somente na CI do GitHub; o emulador não baixa no ambiente de desenvolvimento):**
Execução de CI do GitHub Actions `42780665654` (commit `a9a4ddf`, branch `develop`; a anterior `42700833811` também passou): todos os jobs verdes.

| Suíte | Resultado |
|---|---|
| `pnpm test:rules` | **70 testes**: 19 da Fase 1 + 51 financeiros (isolamento A×B, ausência de exclusão, formato, imutabilidade, conta existente, estorno, baixa, recorrência) |
| `pnpm test:integration` | **31 testes** do Worker contra o emulador com as regras reais (a mesma suíte financeira do Firestore falso, menos 4 testes que dependem do banco falso) |

### Mapa dos testes obrigatórios da fase

| Teste obrigatório | Testes (em `workers/api/test/finance.suite.ts`, salvo indicação) |
|---|---|
| Consistência dos saldos | "checklist: duas contas, receita, despesa, transferência e saldos conferem" (inclui `reconcile`); estornos e baixas verificam o saldo e a conciliação |
| Transferência atômica | destino inexistente não grava nada; mesma conta rejeitada; repetição não move duas vezes; simultâneas com a mesma chave; estorno devolve os dois saldos; **(banco falso)** é um único commit com 5 gravações e falha no commit não deixa estado parcial |
| Idempotência | repetição devolve o original; chave reutilizada com conteúdo diferente → 422; chave obrigatória e válida; 6 requisições simultâneas → 1 criação + 5 repetições; contas, categorias e transferências idempotentes; mesma chave em usuários diferentes não colide; frontend reenvia a mesma chave após erro (`TransactionForm.test.tsx`) |
| Prevenção de duplicidade | 409 `possible_duplicate`, confirmação com `allowDuplicate`; baixa dupla (sequencial e 5 simultâneas) → 1 sucesso |
| Baixa de contas | vencida → baixa → saldo e lançamento; repetição idempotente; outra chave → 409; simultâneas; a receber credita; estorno reabre e permite nova baixa; conta inexistente/arquivada/cancelada |
| Isolamento (RLS) | A×B em todas as rotas (listar, ler por id, alterar, estornar, movimentar, baixar) e nas regras (51 testes) |

## Checklist da fase

| Passo | Evidência |
|---|---|
| Criar duas contas | Automatizado: "checklist: duas contas…" (API, fake e emulador) |
| Registrar receita | idem |
| Registrar despesa | idem |
| Transferir dinheiro | idem |
| Conferir saldos | idem (`+500,00 − 200,00 − 300,00` na origem; `300,00` no destino; total e `reconcile` ok) |
| Repetir a requisição com a mesma chave | Automatizado: "idempotência: repetir a mesma requisição…" |
| Confirmar que não duplicou | Automatizado: 1 lançamento na listagem e saldo igual |

**Não executado:** o roteiro manual pela interface, no navegador, com Firebase real (login, tela de lançamentos,
mobile e desktop). Faltam um projeto Firebase real e o Worker publicado. As telas financeiras **não foram
inspecionadas visualmente**; só testadas por componente (jsdom).

## Limites e pendências (honestos)

1. **Saldo × cliente mal-intencionado:** as regras não provam que o saldo bate com os lançamentos (D-006); há
   conciliação. Reforço (regras com `getAfter` ou conta de serviço restrita) a decidir.
2. **Índices compostos não existem** e não foram validados em produção: consultas por período ordenam por um campo
   e filtram o resto em memória (até 2000 documentos varridos por chamada). O emulador não valida índices.
3. **Volume:** relatórios, exportação, painel e conciliação leem até 5000 lançamentos (acima disso `truncated`).
   Sem agregados pré-calculados; avaliar na Fase 6.
4. **Recorrência não é automática.** Só gera contas quando o usuário pede; agendamento fica para a Fase 3.
5. **Moeda única** (a do perfil); sem conversão cambial. **Sem importação** de extratos (OFX/CSV) nem anexos.
6. **Fuso:** "hoje" (vencidas, painel, padrão de datas da API) usa o fuso do perfil; o formulário do navegador
   sugere a data do fuso do dispositivo.
7. **Subrequisições do Worker:** limite assumido de memória (50), não verificado. Conferir antes do deploy.
8. **Pendências herdadas da Fase 1:** checklist manual com Firebase real; proteção da `main` no GitHub; projetos
   Firebase de staging/produção; CSP `connect-src` provisória.
9. **Rate limiting e auditoria** continuam pendentes (fases seguintes).
10. Um teste da Fase 1 foi ajustado: `accounts` deixou de ser a coleção "não declarada" (usa-se `subscriptions`).

## Fora do escopo (não implementado)

Agenda, tarefas, notificações, IA, voz, assinaturas, painel admin, importação de extratos, orçamento/metas.
