#!/usr/bin/env bash
# Restauração do Firestore a partir de uma exportação. NUNCA restaure direto na produção sem ensaio:
# o import SOBRESCREVE documentos de mesmo caminho. Faça o ensaio em um projeto de staging (docs/BACKUP_RECOVERY.md).
# Uso: GCP_PROJECT=lifeflow-staging scripts/restore-firestore.sh gs://bucket/firestore/<carimbo>
# ATENÇÃO: NUNCA foi executado contra um projeto real.
set -euo pipefail
: "${GCP_PROJECT:?defina GCP_PROJECT (staging para ensaio)}"
SRC="${1:?informe o caminho da exportação (gs://.../firestore/<carimbo>)}"
if [[ "${GCP_PROJECT}" == *prod* && "${CONFIRM_RESTORE_PROD:-}" != "SIM-SOBRESCREVER" ]]; then
  echo "Recusado: o projeto parece ser de PRODUÇÃO. Para continuar, defina CONFIRM_RESTORE_PROD=SIM-SOBRESCREVER." >&2
  exit 2
fi
echo "Importando ${SRC} -> ${GCP_PROJECT}"
gcloud firestore import "$SRC" --project "$GCP_PROJECT"
