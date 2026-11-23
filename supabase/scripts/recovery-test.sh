#!/usr/bin/env bash
# Ensaio de RECUPERAÇÃO: backup (pg_dump) -> perda total dos dados -> restauração (pg_restore) -> conferência linha a linha.
# Roda contra a pilha LOCAL (`supabase start`); usa o pg_dump/pg_restore de DENTRO do contêiner do Postgres (mesma versão do servidor).
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="supabase_db_lifeflow"
psql_() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -At "$@"; }
[ -f supabase/signing_keys.json ] || supabase gen signing-key --algorithm ES256 >/dev/null
supabase start --exclude studio,imgproxy,vector,edge-runtime,realtime,storage-api,logflare,inbucket,mailpit >/dev/null
trap 'supabase stop --no-backup >/dev/null 2>&1 || true' EXIT

UA="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
psql_ <<SQL
insert into auth.users (id, email) values ('$UA', 'recovery@example.com');
insert into public.profiles (user_id, display_name, locale, timezone, currency, created_at, updated_at)
  values ('$UA', 'Recuperação', 'pt-BR', 'America/Sao_Paulo', 'BRL', '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z');
insert into public.accounts (user_id, id, name, type, initial_balance_cents, balance_cents, archived, created_at, updated_at, request_hash)
  values ('$UA', 'a1', 'Conta', 'checking', 1000, 1000, false, '2026-11-09T12:00:00.000Z', '2026-11-09T12:00:00.000Z', 'h');
insert into public.plans (id, name) values ('pro', 'Pro');
SQL

digest() { psql_ -c "select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from (
  select user_id::text, display_name from public.profiles
  union all select user_id::text, id || name || balance_cents::text from public.accounts
  union all select id, name from public.plans) t"; }
BEFORE="$(digest)"

echo "1) backup"
docker exec "$DB" pg_dump -U postgres -Fc --no-owner -n public -f /tmp/lifeflow.dump postgres
docker exec "$DB" pg_dump -U postgres -Fc --no-owner -t auth.users -f /tmp/lifeflow-auth.dump postgres

echo "2) perda total"
psql_ -c "truncate public.plans, public.webhook_events, public.admin_logs; truncate auth.users cascade;"
[ "$(digest)" != "$BEFORE" ] || { echo "FALHA: os dados não foram apagados" >&2; exit 1; }

echo "3) restauração"
docker exec "$DB" pg_restore -U postgres --data-only --disable-triggers --no-owner -d postgres /tmp/lifeflow-auth.dump
docker exec "$DB" pg_restore -U postgres --data-only --disable-triggers --no-owner -d postgres /tmp/lifeflow.dump

AFTER="$(digest)"
[ "$BEFORE" = "$AFTER" ] && echo "OK: dados restaurados idênticos ($AFTER)" || { echo "FALHA: dados diferentes após a restauração" >&2; exit 1; }
