# BACKUP E RECUPERAÇÃO

> Regra do projeto: **backup só vale depois de uma restauração testada.**

## Estado real

| Item | Estado |
|---|---|
| Mecanismo exportar → perda total → importar → conferir documento a documento (emulador) | **Testado na CI** (`pnpm --filter @lifeflow/firebase-rules test:recovery`, `firebase/scripts/recovery-test.sh`) |
| Backup gerenciado de produção (`scripts/backup-firestore.sh`, `.github/workflows/backup.yml`) | **Escrito, nunca executado** (não há projeto Firebase real) |
| Restauração de produção (`scripts/restore-firestore.sh`) | **Escrita, nunca executada** |
| Ensaio de restauração em staging com dados reais | **Pendente** — obrigatório antes do lançamento |
| Exportação do próprio usuário (`GET /v1/account/export`) | Testada; é **cópia para o titular**, **não** é mecanismo de restauração |

## O que se protege

- **Firestore** (todos os dados dos usuários, planos, assinaturas): exportação gerenciada para um bucket do Cloud Storage.
- **Firebase Auth** (logins): não está no export do Firestore. Exportar com `firebase auth:export` periodicamente
  (contém hashes de senha: guardar cifrado, acesso mínimo). **Não implementado/testado.**
- **Segredos do Worker** (`wrangler secret`): não há backup; mantenha a origem num cofre de senhas do operador.
- **Código e regras**: no Git.

## Procedimento de backup (produção)

1. Criar o bucket (`gs://lifeflow-backups-<ambiente>`), com versionamento, acesso uniforme e retenção (ex.: 35 dias).
2. Conta de serviço de backup com `roles/datastore.importExportAdmin` + escrita no bucket; chave em `BACKUP_SA_JSON`.
3. Variáveis do repositório: `FIREBASE_PROJECT_ID`, `BACKUP_BUCKET`; ligar `BACKUP_ENABLED=true`.
4. O workflow diário roda `scripts/backup-firestore.sh`; conferir `gcloud firestore operations list`.
5. Alertar se não houver exportação nova em 26 h.

## Procedimento de restauração (SEMPRE ensaiar em staging)

1. Escolher a exportação (`gsutil ls gs://…/firestore/`).
2. `GCP_PROJECT=<staging> scripts/restore-firestore.sh gs://…/firestore/<carimbo>`.
3. Conferir: contagem de usuários, uma conta de teste (saldo = saldo inicial + lançamentos via `/v1/reconcile`),
   assinaturas e planos, `GET /readyz`.
4. Em incidente real: o import **sobrescreve** documentos de mesmo caminho e **não apaga** os criados depois do backup.
   Decidir com cuidado entre restaurar sobre a produção (exige `CONFIRM_RESTORE_PROD=SIM-SOBRESCREVER`) ou restaurar num
   projeto novo e apontar o app para ele.
5. Registrar a duração (RTO) e a perda de dados (RPO = idade do backup) no ensaio.

## Metas (não validadas)

RPO ≤ 24 h (backup diário) e RTO a medir no primeiro ensaio. Para RPO menor, ativar a recuperação a um ponto no tempo
(PITR) do Firestore (custo adicional) — decisão do operador.

## Cuidados com a exclusão de conta

Um backup antigo **contém** dados de quem já pediu exclusão. Ao restaurar, reaplique as exclusões pedidas depois do
backup (mantenha um registro operacional dos pedidos) e defina um prazo máximo de retenção dos backups (LGPD).
