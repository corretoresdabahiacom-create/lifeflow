# BACKUP E RECUPERAÇÃO

> Regra do projeto: **backup só vale depois de uma restauração testada.**
> Banco: Supabase/Postgres (D-011). O Supabase também faz backups gerenciados conforme o plano contratado (diários nos planos pagos;
> PITR é um complemento pago) — **verifique no painel o que o seu plano inclui**; os scripts abaixo são a cópia INDEPENDENTE.

## Estado real

| Item | Estado |
|---|---|
| Mecanismo `pg_dump` → perda total → `pg_restore` → conferência (pilha local) | **Escrito (`supabase/scripts/recovery-test.sh`, `pnpm db:recovery`, job `supabase-recovery` da CI), ainda não executado** |
| Backup de produção (`scripts/backup-db.sh`, `.github/workflows/backup.yml`) | **Escrito, nunca executado** (não há projeto Supabase real) |
| Restauração (`scripts/restore-db.sh`) | **Escrita, nunca executada**; recusa banco de destino não vazio |
| Ensaio de restauração em staging com dados reais | **Pendente** — obrigatório antes do lançamento |
| Exportação do próprio usuário (`GET /v1/account/export`) | Testada; é **cópia para o titular**, **não** é mecanismo de restauração |

## O que se protege

- **Schema `public`** (dados dos usuários, planos, assinaturas, cobranças, logs) e **`auth.users` + `auth.identities`** (logins, com hashes de
  senha: o backup é criptografado com `BACKUP_PASSPHRASE`, acesso mínimo, retenção curta).
- **Segredos do Worker** (`wrangler secret`): não há backup; mantenha a origem num cofre de senhas do operador.
- **Código, migrações e configuração**: no Git. O esquema se recria com `supabase db push`; os dados vêm do backup.

## Procedimento de backup (produção)

1. Segredos do repositório (ambiente `production`): `SUPABASE_DB_URL` (conexão **direta**, porta 5432, com a senha do banco) e `BACKUP_PASSPHRASE`.
   Variável: `BACKUP_ENABLED=true` (só depois do ensaio de restauração).
2. O workflow diário instala `pg_dump` 17 (versão ≥ a do servidor), roda `scripts/backup-db.sh` e guarda os `.gpg` como artefato por 30 dias.
   Para retenção maior ou fora do GitHub, envie os arquivos para um bucket privado com versionamento.
3. Alertar se não houver backup novo em 26 h.

## Procedimento de restauração (SEMPRE ensaiar em staging)

1. Criar um projeto Supabase VAZIO (ou limpar o de staging), aplicar as migrações (`supabase db push`).
2. Baixar e descriptografar o backup (`gpg --decrypt`).
3. `SUPABASE_DB_URL=<destino> scripts/restore-db.sh <dump-auth> <dump-public>`.
4. Conferir: contagem de usuários, um login real, uma conta de teste (saldo = saldo inicial + lançamentos via `/v1/reconcile`), assinaturas,
   planos e `GET /readyz`.
5. Em incidente real, prefira restaurar num projeto novo e apontar o app para ele (`SUPABASE_URL`/chaves), em vez de sobrescrever a produção.
6. Registrar a duração (RTO) e a perda de dados (RPO = idade do backup) no ensaio.

## Metas (não validadas)

RPO ≤ 24 h (backup diário) e RTO a medir no primeiro ensaio. Para RPO menor, contratar o PITR do Supabase — decisão do operador.

## Cuidados com a exclusão de conta

Um backup antigo **contém** dados de quem já pediu exclusão (a exclusão apaga o usuário e, em cascata, tudo dele). Ao restaurar, reaplique as
exclusões pedidas depois do backup (mantenha um registro operacional dos pedidos; o log `account_deleted` do Worker ajuda) e defina um prazo
máximo de retenção dos backups (LGPD).
