# LifeFlow AI

SaaS de gestão financeira pessoal, agenda, tarefas e assistente inteligente.

**Status:** Fase 0 concluída (repositório inicializado, sem código de aplicação).
A Fase 1 só começa com aprovação expressa do responsável pelo produto.

## Contrato do produto

O contrato mestre está em [`docs/MASTER_PROMPT.md`](docs/MASTER_PROMPT.md). Toda decisão
arquitetural fica registrada em [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Stack (definida no contrato, Parte A)

- Frontend: React + TypeScript + Vite, hospedado no Cloudflare Pages
- Backend: Cloudflare Workers
- Banco e autenticação: Supabase (PostgreSQL, Auth, RLS)
- Arquivos: Cloudflare R2, somente quando necessário
- Gerenciador de pacotes: pnpm

## Estrutura

```
apps/web/            Frontend PWA
apps/admin/          Painel administrativo (Fase 5)
workers/api/         Cloudflare Worker (API)
packages/shared/     Tipos e validações compartilhados
packages/providers/  Interfaces e adaptadores de provedores externos
supabase/migrations/ Migrations versionadas e políticas RLS
supabase/tests/      Testes de isolamento
docs/                Documentação permanente
```

## Segurança

Nenhuma credencial real deve ser versionada. Use apenas `.env.example` como referência de
nomes de variáveis; valores reais ficam em secrets do ambiente.
