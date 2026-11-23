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
| `pnpm typecheck` | `tsc` em `shared`, `web`, `api` e `db` (`supabase/`) |
| `pnpm test` | Vitest: `shared`, `db` (RLS/gatilhos/funções no Postgres local), `web` (jsdom), `api` (Worker contra Postgres local; exclui a integração) |
| `pnpm build` | build do frontend (Vite) e do Worker (`wrangler --dry-run`) |
| `pnpm test:rules` | apenas os testes do banco (`@lifeflow/db`): RLS, gatilhos, CHECKs e funções `lf_*` |
| `pnpm test:integration` | Suítes do Worker (financeiro, agenda, IA, SaaS, conta, segurança) contra o **Supabase real local** (`supabase start`: GoTrue + PostgREST + RLS). Exige Docker e a Supabase CLI. **Só na CI** |
| `pnpm db:recovery` | Recuperação: semeia → `pg_dump` → perda total → `pg_restore` → compara (exige Docker; rodado só na CI, aprovado) |

## Estado (migração para o Supabase, D-011 — 2026-11-23)

Executado **nesta máquina** (sem Docker, sem projeto Supabase, sem rede para o Supabase):

| Comando | Resultado |
|---|---|
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | passaram |
| `pnpm test` | shared 100 + db 44 + web 90 + api 264 = **498 passaram** |

O que a suíte local prova e o que **não** prova:

- **Banco de verdade, PostgREST de mentira.** `supabase/harness` sobe o PostgreSQL real (PGlite, WebAssembly) com as MESMAS migrações
  de `supabase/migrations`, emula o que o Supabase fornece (papéis `anon/authenticated/service_role`, `auth.users`, `auth.uid()`) e uma
  versão mínima do PostgREST (`/rest/v1/rpc/lf_*`: papel e claims por requisição, mapeamento SQLSTATE → HTTP). A RLS, os gatilhos, os
  CHECKs, as FKs e as funções `lf_*` são **executados de verdade** em cada teste do Worker.
- `supabase/tests/api.test.ts` (21) e `rls.test.ts` (23) substituem os 137 testes das antigas Security Rules: isolamento A×B, acesso anônimo,
  campos imutáveis, transições, tabelas só de inclusão, DELETE proibido, tabelas só de serviço, `service_role`.
- O Worker é testado por `finance`/`agenda`/`ai`/`billing`/`account`/`security` `.suite.ts` (as mesmas suítes de antes) com `fakeSupabase()` em
  `workers/api/test/helpers.ts`; tokens de teste têm o formato do Supabase (`iss`, `aud=authenticated`, `role`, `app_metadata`, `amr`).
- **Só coberto na CI (não localmente):** verificação criptográfica do JWT pelo PostgREST, GoTrue (cadastro, login, `amr` real), cabeçalhos HTTP reais,
  chaves `sb_*`, `supabase db push`, `pg_dump`/`pg_restore` reais, Supabase hospedado. Isso depende da CI (`pnpm test:integration`,
  `pnpm db:recovery`), rodadas **apenas na CI** (CI run 45264674894): integração 186 aprovados / 5 pulados; recuperação OK. Nunca rodadas numa máquina de desenvolvimento nem contra um Supabase hospedado.
- Testes que forjam um token com `amr` antigo (login recente) rodam só no mundo local, pois o GoTrue real assina o próprio token.

## Estado (Fase 6, histórico: Firestore)

Resultados em `PHASE_06_LAUNCH.md`. Novas suítes (rodam no Firestore falso e no emulador real): `account.suite.ts`
(exportação e exclusão de conta) e `security.suite.ts` (segurança HTTP e isolamento entre usuários em todos os módulos);
`ops.test.ts` (saúde, prontidão e formato dos logs); `firebase/scripts/recovery-test.sh` (recuperação).
O Firestore falso passou a recusar filtro de desigualdade sem ordenação pelo mesmo campo (regra do Firestore real).

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
A suíte do assistente (`workers/api/test/ai.suite.ts`) roda no Firestore falso (53 testes) e, na CI, no emulador real (execução `43154951563`: regras 131, integração 127 + 1 ignorado).
O LLM e a transcrição são **simulados** (`ScriptedLLM`, `ScriptedSTT`): seguem um roteiro, incluindo um modelo que
obedece uma injeção de prompt. `ai.providers.test.ts` testa os adaptadores DeepSeek/Groq com `fetch` simulado
(formato do pedido, mapeamento de erros, timeout). `firebase/tests/ai.rules.test.ts` cobre as regras (só CI).
Nada disso exercita as APIs reais.

## Estado (Fase 5) — SaaS

`pnpm test` = shared 100 + web 82 + api 239 = 421 (local). Suíte `billing.suite.ts` (36) roda no Firestore falso e, na
CI, no emulador real com as regras reais; `mercadopago.test.ts` (HMAC real, `fetch` simulado), `system.test.ts` (JWT
RS256 real, endpoint simulado), `BillingPage`/`AdminPage` (componentes), `firebase/tests/billing.rules.test.ts` (CI).
O provedor de pagamento nos testes é `FakePayments`. **Nada exercita o Mercado Pago real nem um navegador real.**
