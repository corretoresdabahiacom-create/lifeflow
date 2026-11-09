# DATABASE

> Banco: Firestore (decisão D-004). Substitui PostgreSQL/Supabase do contrato original.

## Coleções implementadas (Fase 1)

| Caminho | Campos | Operações do cliente (regras) |
|---|---|---|
| `users/{uid}` | `uid`, `displayName`, `locale`, `timezone`, `currency`, `createdAt`, `updatedAt` | get, create, update pelo dono; list e delete negados |
| `users/{uid}/preferences/{key}` | `uid`, `theme`, `confirmCreations`, `quietHoursStart`, `quietHoursEnd`, `updatedAt` | get, list, create, update, delete pelo dono |

Tudo que não está listado é negado por padrão (`match /{document=**} { allow read, write: if false; }`).

## Coleções previstas (Parte G, a implementar nas próximas fases)

accounts, categories, transactions, transfers, recurring_transactions, financial_reminders,
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
transações Firestore.
