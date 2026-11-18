#!/usr/bin/env bash
# Verificação rápida pós-deploy (somente leitura, sem credenciais).
# Uso: scripts/smoke.sh https://api.exemplo.com https://app.exemplo.com
set -uo pipefail
API="${1:?URL da API}"; WEB="${2:?URL do app web}"
fail=0
check() { # descrição, condição(0=ok)
  if [ "$2" -eq 0 ]; then echo "OK   $1"; else echo "FALHA $1"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
hdr()  { curl -sI --max-time 15 "$1" | tr -d '\r'; }

[ "$(code "$API/healthz")" = "200" ]; check "API /healthz = 200" $?
[ "$(code "$API/readyz")" = "200" ];  check "API /readyz = 200 (configuração de produção completa)" $?
[ "$(code "$API/v1/me")" = "401" ];   check "API exige token (/v1/me sem token = 401)" $?
[ "$(code "$API/v1/admin/overview")" = "401" ]; check "Painel admin exige token (= 401)" $?
[ "$(code -X POST "$API/webhooks/mercadopago" -d '{}')" = "401" ]; check "Webhook rejeita chamada sem assinatura (= 401)" $?
hdr "$API/healthz" | grep -qi '^x-content-type-options: nosniff'; check "API envia X-Content-Type-Options" $?
[ "$(code -H 'Origin: https://evil.example' "$API/healthz")" = "200" ]; 
hdr "$WEB/" | grep -qi '^content-security-policy:'; check "Web envia Content-Security-Policy" $?
hdr "$WEB/" | grep -qi "frame-ancestors 'none'"; check "Web proíbe iframes (frame-ancestors none)" $?
[ "$(code "$WEB/manifest.webmanifest")" = "200" ]; check "PWA: manifest acessível" $?
[ "$(code "$WEB/sw.js")" = "200" ]; check "PWA: service worker acessível" $?
[ "$(code "$WEB/offline.html")" = "200" ]; check "PWA: página offline acessível" $?
[ "$(code "$WEB/ajustes")" = "200" ]; check "SPA: rota profunda responde 200 (fallback)" $?
if curl -s --max-time 15 -H 'Origin: https://evil.example' -D - -o /dev/null "$API/healthz" | grep -qi '^access-control-allow-origin: https://evil.example'; then check "CORS não aceita origem alheia" 1; else check "CORS não aceita origem alheia" 0; fi
exit $fail
