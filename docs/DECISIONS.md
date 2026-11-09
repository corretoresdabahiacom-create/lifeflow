# DECISIONS

Registro de decisões arquiteturais. Alterações em decisões fundamentais exigem:
Problema, Alternativas, Justificativa, Impacto, Aprovação.

## D-001 — Stack inicial definida pelo contrato mestre

- **Data:** 2026-11-09
- **Decisão:** React + TypeScript + Vite (Cloudflare Pages), Cloudflare Workers, Supabase
  (PostgreSQL, Auth, RLS), Cloudflare R2 sob demanda, pnpm.
- **Origem:** MASTER_PROMPT Parte A (decisões definitivas).
- **Status:** **Parcialmente substituída por D-004** (banco e autenticação). Demais itens vigentes.

## D-002 — Estrutura de monorepo pnpm

- **Data:** 2026-11-09
- **Problema:** Organizar frontend, worker, painel admin, provedores e regras do banco.
- **Alternativas:** Repositórios separados; monorepo pnpm workspaces.
- **Justificativa:** Tipos e validações compartilhados, CI único, versionamento conjunto de
  regras de segurança e API.
- **Impacto:** Um único pipeline; pacotes `shared` e `providers` reutilizados por web, admin e worker.
- **Aprovação:** Autorizada pelo responsável em 2026-11-09 ("autorizo iniciar").

## D-003 — Fluxo de branches

- **Data:** 2026-11-09
- **Decisão:** `main` protegida; trabalho em `develop`.
- **Aprovação:** Confirmada pelo responsável em 2026-11-09.
- **Observação:** a proteção de `main` precisa ser ativada nas configurações do GitHub
  (branch protection); o repositório por si só não a impõe.

## D-004 — Supabase substituído por Firebase (Firestore + Firebase Auth)

- **Data:** 2026-11-09
- **Problema:** O responsável solicitou trocar o Supabase por Firebase. A decisão A1/A2 do
  contrato mestre exige justificativa e autorização para trocar tecnologias.
- **Alternativas:**
  1. **Firestore + Firebase Auth + Security Rules** (escolhida): plano gratuito (Spark) e sem
     servidor próprio de banco; autorização por regras declarativas.
  2. Firebase Data Connect (PostgreSQL gerenciado): mantém modelo relacional, mas depende de
     Cloud SQL, que é infraestrutura paga. Conflita com o princípio A5 (custo inicial ~zero).
  3. Manter Supabase: contrariaria a instrução do responsável.
- **Justificativa:** Firestore é a opção Firebase compatível com custo inicial próximo de zero
  e com o contrato A2 (token do usuário repassado ao banco, que aplica as regras).
  Cotas gratuitas podem mudar; nenhuma gratuidade é prometida como permanente.
- **Impacto (mapeamento do contrato):**
  - PostgreSQL → Firestore (NoSQL, documentos em `users/{uid}/...`). Não há JOINs nem
    constraints relacionais; integridade passa a ser garantida por Security Rules, validação
    no Worker (schemas compartilhados) e transações do Firestore.
  - **Migrations SQL → regras e índices versionados** (`firestore.rules`,
    `firestore.indexes.json`) mais schemas de validação em `packages/shared`.
    Mudanças de formato de dados exigirão scripts de migração de dados versionados.
  - **RLS → Firestore Security Rules**, com permissões separadas por operação
    (`get`, `list`, `create`, `update`, `delete`). `auth.uid()` → `request.auth.uid`.
  - **Supabase Auth → Firebase Auth.** O Worker valida o ID token (assinatura RS256 via JWKS do
    Google, `iss`, `aud`, `exp`) e o repassa ao Firestore REST, que aplica as regras.
    O Worker não usa conta de serviço nas requisições de usuário e não guarda refresh token.
  - A Fase 2 (financeiro) exige atenção: saldos e transferências precisam de transações
    Firestore (limite de operações por transação) e a idempotência será por IDs de documento
    determinísticos. Relatórios e agregações são mais limitados que em SQL.
  - Custo do Firestore é por leitura/escrita/armazenamento; a Fase 6 deve monitorar cotas.
  - Documentos afetados e atualizados: ARCHITECTURE, SECURITY, DATABASE, ENVIRONMENT, COSTS,
    TESTING, `.env.example`, README.
- **Aprovação:** Solicitada pelo responsável em 2026-11-09 ("substitua o supabase por firebase").
  A escolha do Firestore em vez do Data Connect foi minha; o responsável pode pedir a
  alternativa 2 antes da Fase 2.

## D-005 — Modelo LLM: deepseek-flash

- **Data:** 2026-11-09
- **Decisão:** Manter `deepseek-flash` como modelo inicial do `LLMProvider` (Fase 4),
  configurável por ambiente.
- **Origem:** Confirmação do responsável. O identificador não foi verificado por mim na
  documentação oficial da DeepSeek; será conferido com uma chamada autorizada na Fase 4.
  Nenhuma chamada paga sem autorização.

## Pendências

- Ativar proteção da branch `main` no GitHub.
- Criar projetos Firebase de staging e produção (a Fase 1 usa apenas o emulador local e o
  projeto de demonstração `demo-lifeflow`, sem credenciais reais).
