# DATABASE

> Estado: planejado. Nenhuma migration criada (Fase 0).

## Tabelas previstas (MASTER_PROMPT Parte G)

profiles, accounts, categories, transactions, transfers, recurring_transactions,
financial_reminders, events, event_reminders, tasks, task_categories, ai_conversations,
ai_messages, ai_action_logs, notifications, push_subscriptions, user_preferences, plans,
subscriptions, payments, usage_records, audit_logs.

## Padrões obrigatórios

UUID, foreign keys, constraints, índices, timestamps, RLS com políticas específicas por
operação, validação de integridade. Migrations versionadas em `supabase/migrations/`.
Nenhuma migration existente pode ser excluída sem autorização.
