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
| `pnpm test` | Vitest: `shared`, `web` (jsdom), `api` (Worker com mocks) |
| `pnpm build` | build do frontend (Vite) e do Worker (`wrangler --dry-run`) |
| `pnpm test:rules` | Security Rules no emulador do Firestore (exige Java 17+ e acesso a `storage.googleapis.com`) |

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
