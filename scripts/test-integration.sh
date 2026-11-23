#!/usr/bin/env bash
# Suíte de INTEGRAÇÃO do Worker contra uma pilha Supabase REAL e LOCAL (GoTrue + PostgREST + Postgres com as migrações).
# Requer Docker e a Supabase CLI (https://supabase.com/docs/guides/local-development). Usada na CI.
# ATENÇÃO: nunca aponte para um projeto de produção; os testes criam e apagam usuários.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v supabase >/dev/null || { echo "Supabase CLI ausente (npm i -g supabase ou supabase/setup-cli)." >&2; exit 1; }

# Chave de assinatura ASSIMÉTRICA do GoTrue local (não versionada).
bash supabase/scripts/gen-signing-key.sh

supabase start --exclude studio,imgproxy,vector,edge-runtime,realtime,storage-api,logflare,inbucket,mailpit 2>&1 | tail -5
trap 'supabase stop --no-backup >/dev/null 2>&1 || true' EXIT

# Valores da pilha local (chaves LEGADAS em JWT, aceitas como `apikey`/Bearer; as sb_* novas servem só para `apikey`).
eval "$(supabase status -o env | sed 's/^/export /')"
export SUPABASE_URL="${API_URL:?API_URL ausente em supabase status}"
export SUPABASE_PUBLISHABLE_KEY="${ANON_KEY:-${PUBLISHABLE_KEY:?chave publicável ausente}}"
export SUPABASE_SECRET_KEY="${SERVICE_ROLE_KEY:-${SECRET_KEY:?chave secreta ausente}}"

pnpm --filter @lifeflow/api test:integration
