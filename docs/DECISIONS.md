# DECISIONS

Registro de decisões arquiteturais. Alterações em decisões fundamentais exigem:
Problema, Alternativas, Justificativa, Impacto, Aprovação.

## D-001 — Stack inicial definida pelo contrato mestre

- **Data:** 2026-11-09
- **Decisão:** React + TypeScript + Vite (Cloudflare Pages), Cloudflare Workers, Supabase
  (PostgreSQL, Auth, RLS), Cloudflare R2 sob demanda, pnpm.
- **Origem:** MASTER_PROMPT Parte A (decisões definitivas).
- **Aprovação:** Definida pelo contrato; aprovada pelo responsável.

## D-002 — Estrutura de monorepo pnpm

- **Data:** 2026-11-09
- **Problema:** Organizar frontend, worker, painel admin, provedores e migrations.
- **Alternativas:** Repositórios separados; monorepo pnpm workspaces.
- **Justificativa:** Tipos e validações compartilhados, CI único, versionamento conjunto de
  migrations e API.
- **Impacto:** Um único pipeline; pacotes `shared` e `providers` reutilizados por web, admin e worker.
- **Aprovação:** Autorizada pelo responsável em 2026-11-09 ("autorizo iniciar").

## D-003 — Fluxo de branches

- **Data:** 2026-11-09
- **Decisão:** `main` protegida; trabalho em `develop`.
- **Aprovação:** Sugerida no relatório da Fase 0; autorizada junto com a inicialização.

## Pendências a confirmar

- Identificador exato do modelo LLM ("deepseek-flash"): confirmar na documentação oficial
  antes da Fase 4. Nenhuma chamada paga sem autorização.
