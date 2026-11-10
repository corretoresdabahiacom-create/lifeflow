# LifeFlow AI

SaaS de gestão financeira pessoal, agenda, tarefas e assistente inteligente.

**Status:** Fase 2 (financeiro) implementada, aguardando aprovação. Resultados e pendências em
[`docs/PHASE_02_FINANCE.md`](docs/PHASE_02_FINANCE.md). A Fase 1 está em
[`docs/PHASE_01_FOUNDATION.md`](docs/PHASE_01_FOUNDATION.md).

## Contrato do produto

Contrato mestre: [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md). Decisões e adaptações:
[`docs/DECISIONS.md`](docs/DECISIONS.md) (o Supabase foi substituído por Firebase, D-004).

## Stack

- Frontend: React + TypeScript + Vite (PWA), Cloudflare Pages
- Backend: Cloudflare Workers
- Banco e autenticação: Firebase (Firestore + Firebase Auth), com Security Rules
- Arquivos: Cloudflare R2, somente quando necessário
- Pacotes: pnpm (monorepo)

## Estrutura

```
apps/web/            Frontend PWA
workers/api/         Cloudflare Worker (API)
packages/shared/     Schemas e tipos compartilhados
firebase/            Regras do Firestore, índices e testes de regras
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
pnpm test:rules    # regras do Firestore no emulador (precisa de Java e internet)
```

## Fluxo de branches

Trabalho em `develop`; `main` deve ser protegida no GitHub.

## Segurança

Nenhuma credencial real é versionada. `.env.example` lista só nomes de variáveis. O Worker não possui
credencial de conta de serviço: ele valida o ID token do Firebase e o repassa ao Firestore, que aplica as regras.
