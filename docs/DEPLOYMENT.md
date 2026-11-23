# DEPLOYMENT

> Estado (Fase 6): **nenhum deploy foi realizado** (não há contas Cloudflare/Supabase/Mercado Pago). Os workflows e
> scripts abaixo foram escritos e validados apenas quanto à sintaxe e, no caso do Worker, rodando-o localmente.

## O que existe

- **CI** (`.github/workflows/ci.yml`): `verify` (lint, typecheck, test com Postgres local, build), `supabase-integration` (suítes do Worker contra `supabase start`)
  e `supabase-recovery` (pg_dump → perda → pg_restore). Os dois últimos rodaram na CI e passaram (CI run 45264674894); `db push`/deploy reais nunca foram executados. Não faz deploy.
- **Deploy** (`.github/workflows/deploy.yml`): manual (`workflow_dispatch`), escolhe `staging` ou `production`;
  produção só a partir de `main`; reexecuta toda a verificação; aplica as migrações (`supabase db push`) → Worker → Pages; roda
  `scripts/smoke.sh`. **Nunca executado.**
- **Backup** (`.github/workflows/backup.yml`): `pg_dump` diário criptografado, só com `BACKUP_ENABLED=true`. **Nunca executado.**
- **Scripts:** `scripts/smoke.sh` (verificação pós-deploy), `scripts/backup-db.sh`, `scripts/restore-db.sh`, `scripts/test-integration.sh`.
- **Worker local:** `pnpm --filter @lifeflow/api exec wrangler dev --local` roda o Worker real (workerd); foi usado para
  conferir `/healthz`, `/readyz`, 401 sem token, CORS e webhook sem assinatura.

## Passo a passo

Ver [`RUNBOOK.md`](RUNBOOK.md) (primeiro deploy, rollback, monitoramento, incidentes) e
[`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md) (go/no-go). Variáveis e secrets: [`ENVIRONMENT.md`](ENVIRONMENT.md).

## Ambientes

Desenvolvimento (`supabase start`), **staging** e **produção**, cada um com seu projeto Supabase. Sem deploy automático em
produção; sem deploy com testes críticos falhando (o workflow reexecuta tudo).

## Backup e recuperação

Ver [`BACKUP_RECOVERY.md`](BACKUP_RECOVERY.md). Backup só é válido depois de restauração testada em staging.
