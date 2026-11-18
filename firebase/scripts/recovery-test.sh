#!/usr/bin/env bash
# Teste de recuperação com o emulador do Firestore: backup -> perda total -> restauração -> conferência.
# Valida o MECANISMO de exportar/importar e a conferência de integridade; NÃO valida o backup gerenciado de produção
# (ver docs/BACKUP_RECOVERY.md).
set -euo pipefail
cd "$(dirname "$0")/.."
BACKUP="$(mktemp -d)/backup"
export RECOVERY_EXPECTED="$(mktemp -d)/expected.json"
FIREBASE="pnpm exec firebase emulators:exec --only firestore --project demo-lifeflow"

echo "== 1/3 semear dados e gerar o backup (export ao sair)"
$FIREBASE --export-on-exit "$BACKUP" "node scripts/recovery.mjs seed"

echo "== 2/3 perda total: emulador novo, SEM importar o backup -> nada pode existir"
$FIREBASE "node scripts/recovery.mjs expect-empty"

echo "== 3/3 restaurar o backup e conferir documento a documento"
$FIREBASE --import "$BACKUP" "node scripts/recovery.mjs verify"

echo "RECUPERAÇÃO OK"
