#!/usr/bin/env bash
# Backup lógico do Postgres do Supabase de PRODUÇÃO (schemas `public` e a tabela `auth.users`), em formato custom do pg_dump.
# Requer: pg_dump com versão >= a do servidor; SUPABASE_DB_URL = string de conexão DIRETA (porta 5432) com a senha do banco.
# ATENÇÃO: NUNCA foi executado contra um projeto real (não havia credenciais). Valide com o ensaio de restauração
# (docs/BACKUP_RECOVERY.md) antes de confiar. O backup contém dados pessoais e financeiros: criptografe e restrinja o acesso.
set -euo pipefail
: "${SUPABASE_DB_URL:?defina SUPABASE_DB_URL (conexão direta, com senha)}"
OUT_DIR="${BACKUP_DIR:-backups}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
mkdir -p "$OUT_DIR"
pg_dump "$SUPABASE_DB_URL" -Fc --no-owner --no-privileges -n public -f "$OUT_DIR/lifeflow-public-$STAMP.dump"
pg_dump "$SUPABASE_DB_URL" -Fc --no-owner --no-privileges -t auth.users -t auth.identities -f "$OUT_DIR/lifeflow-auth-$STAMP.dump"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  for f in "$OUT_DIR"/lifeflow-*-"$STAMP".dump; do
    gpg --batch --yes --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$f.gpg" "$f" && rm -f "$f"
  done
fi
ls -l "$OUT_DIR"/*"$STAMP"*
