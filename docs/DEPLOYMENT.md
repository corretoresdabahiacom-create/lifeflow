# DEPLOYMENT

> Estado (Fase 6): **nenhum deploy foi realizado** (não há contas Cloudflare/Firebase/Mercado Pago). Os workflows e
> scripts abaixo foram escritos e validados apenas quanto à sintaxe e, no caso do Worker, rodando-o localmente.

## O que existe

- **CI** (`.github/workflows/ci.yml`): `verify` (lint, typecheck, test, build) e `firestore-rules` (regras, integração
  com o emulador e teste de recuperação). Não faz deploy.
- **Deploy** (`.github/workflows/deploy.yml`): manual (`workflow_dispatch`), escolhe `staging` ou `production`;
  produção só a partir de `main`; reexecuta toda a verificação; publica regras/índices → Worker → Pages; roda
  `scripts/smoke.sh`. **Nunca executado.**
- **Backup** (`.github/workflows/backup.yml`): exportação diária do Firestore, só com `BACKUP_ENABLED=true`. **Nunca executado.**
- **Scripts:** `scripts/smoke.sh` (verificação pós-deploy), `scripts/backup-firestore.sh`, `scripts/restore-firestore.sh`.
- **Worker local:** `pnpm --filter @lifeflow/api exec wrangler dev --local` roda o Worker real (workerd); foi usado para
  conferir `/healthz`, `/readyz`, 401 sem token, CORS e webhook sem assinatura.

## Passo a passo

Ver [`RUNBOOK.md`](RUNBOOK.md) (primeiro deploy, rollback, monitoramento, incidentes) e
[`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md) (go/no-go). Variáveis e secrets: [`ENVIRONMENT.md`](ENVIRONMENT.md).

## Ambientes

Desenvolvimento (emuladores), **staging** e **produção**, cada um com seu projeto Firebase. Sem deploy automático em
produção; sem deploy com testes críticos falhando (o workflow reexecuta tudo).

## Backup e recuperação

Ver [`BACKUP_RECOVERY.md`](BACKUP_RECOVERY.md). Backup só é válido depois de restauração testada em staging.
