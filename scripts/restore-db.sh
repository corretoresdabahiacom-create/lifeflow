#!/usr/bin/env bash
# Restauração dos backups de scripts/backup-db.sh em um banco VAZIO (use SEMPRE um projeto/banco de teste primeiro).
# Uso: SUPABASE_DB_URL=... scripts/restore-db.sh backups/lifeflow-auth-X.dump backups/lifeflow-public-X.dump
# Não restaura por cima de dados existentes: recusa se `public.profiles` ou `auth.users` já tiverem linhas.
set -euo pipefail
: "${SUPABASE_DB_URL:?defina SUPABASE_DB_URL}"
AUTH_DUMP="${1:?dump de auth}"; PUBLIC_DUMP="${2:?dump de public}"
n="$(psql "$SUPABASE_DB_URL" -At -c "select (select count(*) from auth.users) + (select count(*) from public.profiles)")"
[ "$n" = "0" ] || { echo "Recusado: o banco de destino não está vazio ($n linhas)." >&2; exit 1; }
pg_restore --data-only --disable-triggers --no-owner -d "$SUPABASE_DB_URL" "$AUTH_DUMP"
pg_restore --data-only --disable-triggers --no-owner -d "$SUPABASE_DB_URL" "$PUBLIC_DUMP"
echo "Restauração concluída. Confira contagens e um usuário real antes de reabrir o tráfego."
