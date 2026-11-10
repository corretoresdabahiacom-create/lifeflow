# DATABASE

> Banco: Firestore (decisão D-004). Substitui PostgreSQL/Supabase do contrato original.

## Coleções implementadas (Fase 1)

| Caminho | Campos | Operações do cliente (regras) |
|---|---|---|
| `users/{uid}` | `uid`, `displayName`, `locale`, `timezone`, `currency`, `createdAt`, `updatedAt` | get, create, update pelo dono; list e delete negados |
| `users/{uid}/preferences/{key}` | `uid`, `theme`, `confirmCreations`, `quietHoursStart`, `quietHoursEnd`, `updatedAt` | get, list, create, update, delete pelo dono |

### Fase 2 — financeiro (todas sob `users/{uid}/`)

Valores em centavos inteiros. Todos os campos existem sempre (nulos quando vazios). Campos internos
`requestHash`/`payRequestHash` (idempotência) não são devolvidos pela API. **Nenhuma coleção permite `delete`**.

| Caminho | Campos principais | Regras de escrita (resumo) |
|---|---|---|
| `accounts/{id}` | `name`, `type` (checking, savings, cash, credit_card, investment), `initialBalanceCents`, `balanceCents`, `archived` | criar com saldo = inicial e não arquivada; alterar nome, arquivamento e saldo (incremento); `uid`, `type`, `initialBalanceCents`, `createdAt`, `requestHash` imutáveis |
| `categories/{id}` | `name`, `kind` (income, expense), `archived` | `kind` imutável |
| `transactions/{id}` | `accountId`, `type` (income, expense, transfer_out, transfer_in), `amountCents` (>0), `signedCents`, `date`, `categoryId`, `description`, `notes`, `status` (posted, voided), `transferId`, `payableId`, `voidedAt` | criar só `posted`, com conta existente e sinal coerente; só 2 updates: estorno (`posted→voided`) ou metadados (`description`, `notes`, `categoryId`) |
| `transfers/{id}` | `fromAccountId`, `toAccountId` (diferentes), `amountCents`, `date`, `description`, `status`, `outTransactionId`, `inTransactionId`, `voidedAt` | criar só `posted` com as duas contas existentes; único update: estorno |
| `payables/{id}` | `kind` (payable, receivable), `description`, `amountCents`, `dueDate`, `accountId`, `categoryId`, `status` (open, paid, canceled), `paidDate`, `paidAmountCents`, `transactionId`, `payCount`, `recurringId` | criar `open` com `payCount` 0; `paid` exige data, valor e lançamento; não paga exige tudo vazio |
| `recurring/{id}` | `kind`, `description`, `amountCents`, `frequency` (weekly, monthly, yearly), `startDate`, `endDate`, `accountId`, `categoryId`, `active`, `lastMaterializedThrough` | `frequency`, `startDate`, `kind` imutáveis |

`overdue` (vencida) **não é gravado**: é derivado na leitura (`status=open` e `dueDate` < hoje no fuso do perfil).

IDs: `^[A-Za-z0-9_-]{1,80}$` (validado na API, nas regras e nas rotas, o que impede manipulação de caminho).
IDs de criação são determinísticos (idempotência); ver `DECISIONS.md` D-006.

### Agenda (Fase 3)

Sob `users/{uid}/`: `events` (série ou evento simples), `eventExceptions` (alterações/cancelamentos de uma
ocorrência), `tasks`, `taskCategories`, `reminders` (avulsos), `notifications`, `preferences/app` (horário silencioso).
Documentos planos; datas locais + fuso IANA. Eventos e tarefas podem ser excluídos; categorias de tarefa não
(arquivam); notificações só mudam `read`, `readAt`, `dismissed` e apenas para frente. Detalhes em `DECISIONS.md` D-007.

### Índices

`firebase/firestore.indexes.json` continua **vazio de propósito**: todas as consultas usam apenas índices
de campo único (`date`, `dueDate`) e filtram o resto em memória. Limite: listagens com filtro por conta,
categoria ou tipo varrem até 2000 documentos por chamada (com cursor para continuar). Com volume maior,
criar índices compostos (ex.: `accountId` + `date`). O emulador **não** valida índices; isso só pode ser
confirmado em um projeto Firestore real.

Tudo que não está listado é negado por padrão (`match /{document=**} { allow read, write: if false; }`).

## Coleções previstas (Parte G, a implementar nas próximas fases)

events, event_reminders, tasks, task_categories, ai_conversations, ai_messages,
ai_action_logs, notifications, push_subscriptions, plans, subscriptions, payments,
usage_records, audit_logs. As pessoais ficarão em `users/{uid}/...`; as administrativas
(plans, audit_logs etc.) terão regras próprias, sem acesso de cliente.

## Controle de versão do "esquema"

Firestore não tem migrations SQL. O versionamento é feito por:
- `firebase/firestore.rules` e `firebase/firestore.indexes.json` (no Git, revisados em PR);
- schemas de validação em `packages/shared` (usados pelo Worker);
- scripts de migração de dados versionados em `firebase/migrations/` quando o formato mudar
  (nenhum necessário na Fase 1).

## Integridade

Sem constraints relacionais. A integridade é garantida por: regras (tipo, campos permitidos,
`uid` igual ao do caminho e imutável), validação no Worker e, nas fases financeiras,
commits atômicos do Firestore (Fase 2: `documents:commit` com pré-condições e incrementos).
