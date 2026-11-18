#!/usr/bin/env bash
# Backup do Firestore de PRODUÇÃO: exportação gerenciada para um bucket do Cloud Storage.
# Requer: gcloud autenticado com permissão `datastore.databases.export` e bucket já criado (versionamento ligado).
# ATENÇÃO: NUNCA foi executado contra um projeto real (não havia credenciais). Valide com `restore-drill` antes de confiar.
set -euo pipefail
: "${GCP_PROJECT:?defina GCP_PROJECT}"
: "${BACKUP_BUCKET:?defina BACKUP_BUCKET (ex.: gs://lifeflow-backups-prod)}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
DEST="${BACKUP_BUCKET%/}/firestore/${STAMP}"
echo "Exportando ${GCP_PROJECT} -> ${DEST}"
gcloud firestore export "$DEST" --project "$GCP_PROJECT" --async --format="value(name)"
echo "Exportação iniciada (assíncrona). Acompanhe: gcloud firestore operations list --project ${GCP_PROJECT}"
echo "$DEST"
