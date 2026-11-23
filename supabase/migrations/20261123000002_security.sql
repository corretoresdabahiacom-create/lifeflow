-- LifeFlow AI — RLS, privilégios e gatilhos (portam as antigas Security Rules do Firestore; D-011).
--
-- Princípios (os mesmos de antes):
--  * negado por padrão: RLS ligada em TODA tabela, privilégios mínimos por papel;
--  * o dono (auth.uid() = user_id) é o único que acessa dado pessoal;
--  * permissões separadas por operação (select / insert / update / delete);
--  * campos imutáveis e transições de estado válidas ficam em gatilhos (o banco não confia no cliente);
--  * planos, assinaturas, pagamentos, webhooks e auditoria administrativa: só o backend (service_role) escreve.

-- ---------------------------------------------------------------------------------------------------------------
-- Funções-gatilho genéricas
-- ---------------------------------------------------------------------------------------------------------------

-- Chaves que mudaram entre duas linhas (ignora o contador de versão).
create or replace function public.lf_changed_keys(p_old jsonb, p_new jsonb)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(n.key order by n.key), '{}')
  from jsonb_each(p_new) n
  where n.key <> 'version' and n.value is distinct from (p_old -> n.key)
$$;

create or replace function public.lf_bump_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.version := old.version + 1;
  return new;
end
$$;

-- Campos listados em TG_ARGV não podem mudar.
create or replace function public.lf_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c text;
begin
  foreach c in array tg_argv loop
    if to_jsonb(new) -> c is distinct from to_jsonb(old) -> c then
      raise exception 'campo imutável: %', c using errcode = 'PT403';
    end if;
  end loop;
  return new;
end
$$;

-- Só os campos listados em TG_ARGV podem mudar.
create or replace function public.lf_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  foreach k in array public.lf_changed_keys(to_jsonb(old), to_jsonb(new)) loop
    if not (k = any (tg_argv)) then
      raise exception 'campo não pode ser alterado: %', k using errcode = 'PT403';
    end if;
  end loop;
  return new;
end
$$;

-- Tabelas só de inclusão (mensagens, trilha de auditoria): nenhuma alteração.
create or replace function public.lf_deny_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'registro imutável' using errcode = 'PT403';
end
$$;

-- Contadores que só crescem (TG_ARGV = colunas).
create or replace function public.lf_grow()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c text;
begin
  foreach c in array tg_argv loop
    if (to_jsonb(new) ->> c)::numeric < (to_jsonb(old) ->> c)::numeric then
      raise exception 'contador não pode diminuir: %', c using errcode = 'PT403';
    end if;
  end loop;
  return new;
end
$$;

-- Lançamento: só estorno (posted -> voided) ou edição de metadados; valor, conta, tipo, data e vínculos são imutáveis.
create or replace function public.lf_guard_transaction()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  changed text[] := public.lf_changed_keys(to_jsonb(old), to_jsonb(new));
begin
  if old.status <> 'posted' then
    raise exception 'lançamento estornado não pode ser alterado' using errcode = 'PT403';
  end if;
  if new.status = 'voided' then
    if new.voided_at is null or not (changed <@ array['status', 'voided_at', 'updated_at']) then
      raise exception 'estorno só altera status, voided_at e updated_at' using errcode = 'PT403';
    end if;
  elsif not (changed <@ array['description', 'notes', 'category_id', 'updated_at']) then
    raise exception 'lançamento só aceita edição de descrição, observações e categoria' using errcode = 'PT403';
  end if;
  return new;
end
$$;

create or replace function public.lf_guard_transfer()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'posted' or new.status <> 'voided' or new.voided_at is null
     or not (public.lf_changed_keys(to_jsonb(old), to_jsonb(new)) <@ array['status', 'voided_at', 'updated_at']) then
    raise exception 'transferência só pode ser estornada' using errcode = 'PT403';
  end if;
  return new;
end
$$;

-- Notificação: só muda o estado de leitura/dispensa, e só para frente ("dispensar" esconde, não apaga).
create or replace function public.lf_guard_notification()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not (public.lf_changed_keys(to_jsonb(old), to_jsonb(new)) <@ array['read', 'read_at', 'dismissed'])
     or (old.read and not new.read) or (old.dismissed and not new.dismissed) then
    raise exception 'notificação só avança read/dismissed' using errcode = 'PT403';
  end if;
  return new;
end
$$;

-- Ação da IA: parâmetros imutáveis; estados terminais não mudam mais; executing só termina em done/failed/blocked.
create or replace function public.lf_guard_ai_action()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status not in ('pending', 'executing')
     or (old.status = 'executing' and new.status not in ('done', 'failed', 'blocked'))
     or not (public.lf_changed_keys(to_jsonb(old), to_jsonb(new)) <@ array['status', 'result_note', 'updated_at']) then
    raise exception 'transição inválida da ação do assistente' using errcode = 'PT403';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Gatilhos por tabela
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Versão (concorrência otimista) em toda tabela.
  foreach t in array array[
    'profiles', 'preferences', 'consents', 'accounts', 'categories', 'transactions', 'transfers', 'payables',
    'recurring', 'events', 'event_exceptions', 'tasks', 'task_categories', 'reminders', 'notifications',
    'ai_conversations', 'ai_messages', 'ai_actions', 'ai_logs', 'ai_usage', 'ai_daily', 'plans', 'subscriptions',
    'billing_payments', 'webhook_events', 'admin_logs'
  ] loop
    execute format('create trigger lf_a_bump before update on public.%I for each row execute function public.lf_bump_version()', t);
  end loop;
end
$$;

create trigger lf_frozen_profiles before update on public.profiles
  for each row execute function public.lf_frozen('created_at');
create trigger lf_frozen_accounts before update on public.accounts
  for each row execute function public.lf_frozen('type', 'initial_balance_cents', 'created_at', 'request_hash');
create trigger lf_frozen_categories before update on public.categories
  for each row execute function public.lf_frozen('kind', 'created_at', 'request_hash');
create trigger lf_guard_transactions before update on public.transactions
  for each row execute function public.lf_guard_transaction();
create trigger lf_guard_transfers before update on public.transfers
  for each row execute function public.lf_guard_transfer();
create trigger lf_frozen_payables before update on public.payables
  for each row execute function public.lf_frozen('kind', 'created_at', 'request_hash', 'recurring_id');
create trigger lf_frozen_recurring before update on public.recurring
  for each row execute function public.lf_frozen('kind', 'frequency', 'start_date', 'created_at', 'request_hash');
create trigger lf_frozen_events before update on public.events
  for each row execute function public.lf_frozen('created_at', 'request_hash');
create trigger lf_frozen_event_exceptions before update on public.event_exceptions
  for each row execute function public.lf_frozen('series_id', 'original_date', 'created_at');
create trigger lf_frozen_tasks before update on public.tasks
  for each row execute function public.lf_frozen('created_at', 'request_hash');
create trigger lf_frozen_task_categories before update on public.task_categories
  for each row execute function public.lf_frozen('created_at', 'request_hash');
create trigger lf_only_reminders before update on public.reminders
  for each row execute function public.lf_only('title', 'remind_at');
create trigger lf_guard_notifications before update on public.notifications
  for each row execute function public.lf_guard_notification();
create trigger lf_only_ai_conversations before update on public.ai_conversations
  for each row execute function public.lf_only('updated_at');
create trigger lf_guard_ai_actions before update on public.ai_actions
  for each row execute function public.lf_guard_ai_action();
create trigger lf_deny_ai_messages before update on public.ai_messages
  for each row execute function public.lf_deny_update();
create trigger lf_deny_ai_logs before update on public.ai_logs
  for each row execute function public.lf_deny_update();
create trigger lf_grow_ai_usage before update on public.ai_usage
  for each row execute function public.lf_grow('messages', 'voice_seconds', 'input_tokens', 'output_tokens');
create trigger lf_grow_ai_daily before update on public.ai_daily
  for each row execute function public.lf_grow('auto_actions', 'auto_value_cents');

-- ---------------------------------------------------------------------------------------------------------------
-- RLS: ligada em tudo
-- ---------------------------------------------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.preferences       enable row level security;
alter table public.consents          enable row level security;
alter table public.accounts          enable row level security;
alter table public.categories        enable row level security;
alter table public.transactions      enable row level security;
alter table public.transfers         enable row level security;
alter table public.payables          enable row level security;
alter table public.recurring         enable row level security;
alter table public.events            enable row level security;
alter table public.event_exceptions  enable row level security;
alter table public.tasks             enable row level security;
alter table public.task_categories   enable row level security;
alter table public.reminders         enable row level security;
alter table public.notifications     enable row level security;
alter table public.ai_conversations  enable row level security;
alter table public.ai_messages       enable row level security;
alter table public.ai_actions        enable row level security;
alter table public.ai_logs           enable row level security;
alter table public.ai_usage          enable row level security;
alter table public.ai_daily          enable row level security;
alter table public.plans             enable row level security;
alter table public.subscriptions     enable row level security;
alter table public.billing_payments  enable row level security;
alter table public.webhook_events    enable row level security;
alter table public.admin_logs        enable row level security;

-- Leitura pelo dono (todas as tabelas pessoais + assinatura e histórico de cobrança, somente leitura).
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'preferences', 'consents', 'accounts', 'categories', 'transactions', 'transfers', 'payables',
    'recurring', 'events', 'event_exceptions', 'tasks', 'task_categories', 'reminders', 'notifications',
    'ai_conversations', 'ai_messages', 'ai_actions', 'ai_logs', 'ai_usage', 'ai_daily', 'subscriptions',
    'billing_payments'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      t || '_select_own', t);
  end loop;
end
$$;

-- Planos: qualquer usuário autenticado lê o catálogo.
create policy plans_select_authenticated on public.plans for select to authenticated using (true);

-- Atualização pelo dono nas tabelas que aceitam update (os gatilhos acima restringem O QUE pode mudar).
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'preferences', 'consents', 'accounts', 'categories', 'transactions', 'transfers', 'payables',
    'recurring', 'events', 'event_exceptions', 'tasks', 'task_categories', 'reminders', 'notifications',
    'ai_conversations', 'ai_actions', 'ai_usage', 'ai_daily'
  ] loop
    execute format(
      'create policy %I on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      t || '_update_own', t);
  end loop;
end
$$;

-- Inclusão pelo dono, com as condições iniciais de cada tabela (antes: `allow create` das regras).
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy preferences_insert_own on public.preferences for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy consents_insert_own on public.consents for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy accounts_insert_own on public.accounts for insert to authenticated
  with check (user_id = (select auth.uid()) and balance_cents = initial_balance_cents and archived = false);
create policy categories_insert_own on public.categories for insert to authenticated
  with check (user_id = (select auth.uid()) and archived = false);
create policy transactions_insert_own on public.transactions for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'posted' and voided_at is null);
create policy transfers_insert_own on public.transfers for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'posted' and voided_at is null);
create policy payables_insert_own on public.payables for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'open' and pay_count = 0);
create policy recurring_insert_own on public.recurring for insert to authenticated
  with check (user_id = (select auth.uid()) and last_materialized_through is null);
create policy events_insert_own on public.events for insert to authenticated
  with check (user_id = (select auth.uid()) and expense_transaction_id is null);
create policy event_exceptions_insert_own on public.event_exceptions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy tasks_insert_own on public.tasks for insert to authenticated
  with check (user_id = (select auth.uid()) and completed_at is null and status in ('pending', 'in_progress'));
create policy task_categories_insert_own on public.task_categories for insert to authenticated
  with check (user_id = (select auth.uid()) and archived = false);
create policy reminders_insert_own on public.reminders for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy notifications_insert_own on public.notifications for insert to authenticated
  with check (user_id = (select auth.uid()) and read = false and read_at is null and dismissed = false);
create policy ai_conversations_insert_own on public.ai_conversations for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_messages_insert_own on public.ai_messages for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_actions_insert_own on public.ai_actions for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending' and result_note is null);
create policy ai_logs_insert_own on public.ai_logs for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_usage_insert_own on public.ai_usage for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ai_daily_insert_own on public.ai_daily for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Exclusão pelo dono: só onde as regras antigas permitiam (eventos, exceções, tarefas, lembretes, conversas,
-- mensagens e preferências). Finanças, notificações, auditoria e contadores NUNCA são apagados pelo cliente.
create policy events_delete_own on public.events for delete to authenticated using (user_id = (select auth.uid()));
create policy event_exceptions_delete_own on public.event_exceptions for delete to authenticated using (user_id = (select auth.uid()));
create policy tasks_delete_own on public.tasks for delete to authenticated using (user_id = (select auth.uid()));
create policy reminders_delete_own on public.reminders for delete to authenticated using (user_id = (select auth.uid()));
create policy ai_conversations_delete_own on public.ai_conversations for delete to authenticated using (user_id = (select auth.uid()));
create policy ai_messages_delete_own on public.ai_messages for delete to authenticated using (user_id = (select auth.uid()));
create policy preferences_delete_own on public.preferences for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- Privilégios (defesa em profundidade: sem GRANT, a operação nem chega à RLS)
-- ---------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update on
  public.profiles, public.preferences, public.consents, public.accounts, public.categories, public.transactions,
  public.transfers, public.payables, public.recurring, public.events, public.event_exceptions, public.tasks,
  public.task_categories, public.reminders, public.notifications, public.ai_conversations, public.ai_actions,
  public.ai_usage, public.ai_daily
  to authenticated;
-- Mensagens e trilha de auditoria são só de inclusão. O UPDATE é concedido porque o upsert do Worker tenta
-- atualizar antes de criar; sem política de UPDATE a RLS não alcança nenhuma linha e o gatilho lf_deny_update
-- bloqueia qualquer tentativa residual.
grant select, insert, update on public.ai_messages, public.ai_logs to authenticated;
grant delete on
  public.events, public.event_exceptions, public.tasks, public.reminders, public.ai_conversations,
  public.ai_messages, public.preferences
  to authenticated;
-- Somente leitura para o cliente (escrita só pelo backend).
grant select on public.plans, public.subscriptions, public.billing_payments to authenticated;

-- O backend usa service_role (ignora a RLS no Supabase). Sem acesso do cliente a webhook_events/admin_logs.
grant all on all tables in schema public to service_role;
