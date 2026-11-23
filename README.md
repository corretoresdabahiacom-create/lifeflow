# LifeFlow AI

SaaS de gestão financeira pessoal, agenda, tarefas e assistente inteligente.

**Status:** Fase 6 (lançamento) implementada, aguardando aprovação; as Fases 3 (agenda), 4 (IA) e 5 (SaaS) também aguardam aprovação. **Nada foi implantado**: ver `docs/PRODUCTION_CHECKLIST.md`.
Resultados e pendências em [`docs/PHASE_04_AI.md`](docs/PHASE_04_AI.md) e
[`docs/PHASE_03_AGENDA.md`](docs/PHASE_03_AGENDA.md). A Fase 2 (financeiro, aprovada) está em
[`docs/PHASE_02_FINANCE.md`](docs/PHASE_02_FINANCE.md) e a Fase 1 em
[`docs/PHASE_01_FOUNDATION.md`](docs/PHASE_01_FOUNDATION.md).

## Contrato do produto

Contrato mestre: [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md). Decisões e adaptações:
[`docs/DECISIONS.md`](docs/DECISIONS.md) (o projeto voltou ao Supabase na D-011; Firebase foi usado nas Fases 1–6).

## Stack

- Frontend: React + TypeScript + Vite (PWA), Cloudflare Pages
- Backend: Cloudflare Workers
- Banco e autenticação: Supabase (PostgreSQL + Supabase Auth), com RLS
- Arquivos: Cloudflare R2, somente quando necessário
- Pacotes: pnpm (monorepo)

## Estrutura

```
apps/web/            Frontend PWA
workers/api/         Cloudflare Worker (API)
packages/shared/     Schemas e tipos compartilhados
supabase/            Migrações SQL (esquema, RLS, funções), config da pilha local e testes do banco
docs/                Documentação permanente
```

`apps/admin` e `packages/providers` serão criados nas fases 4 e 5.

## Comandos

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test          # unitários e Worker (mocks)
pnpm build
pnpm test:rules    # testes do banco (RLS/gatilhos/funções) em Postgres local, sem Docker
pnpm test:integration  # Worker contra o Supabase local real (Docker + Supabase CLI; rodado na CI)
```

## Fluxo de branches

Trabalho em `develop`; `main` deve ser protegida no GitHub.

## Segurança

Nenhuma credencial real é versionada. `.env.example` lista só nomes de variáveis. O Worker não possui
credencial privilegiada nas requisições de usuário: ele valida o JWT do Supabase e o repassa ao PostgREST, e a RLS do Postgres aplica as regras. A chave secreta só é usada em operações de sistema restritas.
