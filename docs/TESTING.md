# TESTING

## Regras

- Testes obrigatórios por fase são critério mínimo de aprovação (MASTER_PROMPT Parte M).
- Testes desejáveis são listados separadamente.
- Relatórios só afirmam testes **executados**, com comando e resultado reais. Arquivo de teste escrito
  não conta como teste executado.

## Comandos

| Comando | O que roda |
|---|---|
| `pnpm lint` | ESLint em todo o monorepo |
| `pnpm typecheck` | `tsc` em `shared`, `web`, `api` e `firebase` |
| `pnpm test` | Vitest: `shared`, `web` (jsdom), `api` (Worker com Firestore falso; exclui os testes de integração) |
| `pnpm build` | build do frontend (Vite) e do Worker (`wrangler --dry-run`) |
| `pnpm test:rules` | Security Rules no emulador do Firestore (exige Java 17+ e acesso a `storage.googleapis.com`) |
| `pnpm test:integration` | Mesma suíte financeira do Worker contra o emulador real, com as regras reais (mesmos requisitos) |

## Estado (Fase 3)

Resultados e mapa dos testes obrigatórios em `PHASE_03_AGENDA.md`. Resumo: lint, typecheck, test (274: shared 93,
web 57, api 124) e build passaram localmente; `test:rules` (113) e `test:integration` (75) rodaram **somente na CI**
(execução `42783050907` para o backend e as regras). A suíte da agenda (`agenda.suite.ts`, 47 testes) roda no
Firestore falso (47) e no emulador real (44; 3 testes `[falso]` verificam commit único, falha parcial e número de
chamadas). O relógio é injetável (`makeApp(..., clock)`; padrão 2026-11-09T12:00Z). Roteiro manual no navegador com
Firebase real: não executado.

## Estado (Fase 2)

Resultados e mapa dos testes obrigatórios em `PHASE_02_FINANCE.md`. Resumo: lint, typecheck, test (170: shared 62,
web 31, api 77) e build passaram localmente; `test:rules` (70) e `test:integration` (31) rodaram **somente na CI**
(o emulador não baixa no ambiente de desenvolvimento). Roteiro manual no navegador com Firebase real: não executado.

### Estratégia da suíte financeira

`workers/api/test/finance.suite.ts` define os testes uma vez e roda duas vezes: contra o **Firestore falso**
(`finance.fake.test.ts`, rápido, local) e contra o **emulador real** (`finance.integration.test.ts`, com as
Security Rules reais, na CI). Testes que dependem de espiar chamadas ou injetar falhas rodam só no falso
(4 testes). O falso foi escrito por mim e implementa só o que o Worker usa; por isso o emulador é a prova
real de commit atômico, pré-condições, incrementos, consultas e regras. `firestore.commit.test.ts` confere o
formato exato das chamadas REST (`documents:commit`, `runQuery`).

## Estado (Fase 1)

Resultados reais e pendências em `PHASE_01_FOUNDATION.md`. Resumo: lint, typecheck, test (57) e build
passaram localmente. `test:rules` **não pôde rodar no ambiente de desenvolvimento** (bloqueio de rede) e
foi executado na CI do GitHub: 19 testes aprovados (run 42659605727). O checklist manual não foi executado.

## Tipos de teste

- **Obrigatórios da Fase 1:** lint, typecheck, test, build, testes negativos de isolamento (regras).
- **Desejáveis (não obrigatórios):** teste ponta a ponta com navegador e projeto Firebase real;
  teste em dispositivo real da instalação e atualização da PWA; teste de carga do Worker.

## Limites dos mocks

Os testes do Worker usam um Firestore simulado e chaves geradas no teste. Eles provam o
comportamento do Worker (validação do token, caminhos usados, repasse do token), não o das regras do
Firestore nem a integração com o Google. Integração marcada como "testada com mocks", não como validada
em ambiente real.

## Estado (Fase 4)

Resultados e mapa dos testes obrigatórios em `PHASE_04_AI.md`. `pnpm test` = 354 (shared 97, web 70, api 187).
A suíte do assistente (`workers/api/test/ai.suite.ts`) roda no Firestore falso (53 testes) e, na CI, no emulador real.
O LLM e a transcrição são **simulados** (`ScriptedLLM`, `ScriptedSTT`): seguem um roteiro, incluindo um modelo que
obedece uma injeção de prompt. `ai.providers.test.ts` testa os adaptadores DeepSeek/Groq com `fetch` simulado
(formato do pedido, mapeamento de erros, timeout). `firebase/tests/ai.rules.test.ts` cobre as regras (só CI).
Nada disso exercita as APIs reais.
