-- LifeFlow AI — esquema relacional (Supabase / PostgreSQL). Substitui o Firestore (D-011).
--
-- Convenções
--  * Toda tabela pessoal tem `user_id uuid` (FK para auth.users, ON DELETE CASCADE): apagar o usuário apaga tudo.
--  * Valores monetários são centavos inteiros (bigint). Datas locais e instantes seguem em TEXTO ISO-8601, como o
--    contrato da API (ordenar texto ISO equivale a ordenar no tempo); o formato é garantido pelos domínios abaixo.
--  * `version` é o contador de concorrência otimista (pré-condição "updateTime" do antigo Firestore).
--  * Nomes de coluna em snake_case; a API fala camelCase (a conversão é feita no Worker).
--
-- Este arquivo só cria tipos e tabelas. RLS, privilégios e gatilhos estão em 20261123000002_security.sql; as
-- funções chamadas pelo Worker, em 20261123000003_api.sql.

-- ---------------------------------------------------------------------------------------------------------------
-- Domínios reutilizáveis (equivalem aos validadores das antigas Security Rules)
-- ---------------------------------------------------------------------------------------------------------------
create domain public.lf_id as text
  constraint lf_id_format check (value ~ '^[A-Za-z0-9_-]{1,80}$');
create domain public.lf_date as text
  constraint lf_date_format check (value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
create domain public.lf_time as text
  constraint lf_time_format check (value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
create domain public.lf_ts as text
  constraint lf_ts_format check (value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$');
-- Centavos inteiros, limitados a R$ 1 bilhão (em módulo).
create domain public.lf_cents as bigint
  constraint lf_cents_range check (value between -100000000000 and 100000000000);
create domain public.lf_pos_cents as bigint
  constraint lf_pos_cents_range check (value > 0 and value <= 100000000000);

-- ---------------------------------------------------------------------------------------------------------------
-- Perfil e preferências
-- ---------------------------------------------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  id           text generated always as (user_id::text) stored,
  display_name text not null check (char_length(display_name) between 1 and 80),
  locale       text not null check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone     text not null check (char_length(timezone) between 1 and 64),
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  created_at   public.lf_ts not null,
  updated_at   public.lf_ts not null,
  version      bigint not null default 1
);

-- Um documento por chave: `app` (tema e horário silencioso) e `ai` (limites de automação do assistente).
create table public.preferences (
  user_id                uuid not null references auth.users (id) on delete cascade,
  id                     text not null check (id in ('app', 'ai')),
  theme                  text check (theme in ('light', 'dark', 'system')),
  confirm_creations      boolean,
  quiet_hours_start      public.lf_time,
  quiet_hours_end        public.lf_time,
  auto_actions_per_day   integer check (auto_actions_per_day between 0 and 100),
  auto_value_limit_cents bigint check (auto_value_limit_cents between 0 and 10000000),
  confirm_above_cents    bigint check (confirm_above_cents between 0 and 10000000),
  updated_at             public.lf_ts not null,
  version                bigint not null default 1,
  primary key (user_id, id),
  constraint preferences_shape check (
    (id = 'app' and theme is not null and confirm_creations is not null
       and quiet_hours_start is not null and quiet_hours_end is not null
       and auto_actions_per_day is null and auto_value_limit_cents is null and confirm_above_cents is null)
    or
    (id = 'ai' and auto_actions_per_day is not null and auto_value_limit_cents is not null
       and confirm_above_cents is not null
       and theme is null and confirm_creations is null and quiet_hours_start is null and quiet_hours_end is null)
  )
);

create table public.consents (
  user_id    uuid not null references auth.users (id) on delete cascade,
  id         text not null check (id = 'audio'),
  granted    boolean not null,
  updated_at public.lf_ts not null,
  version    bigint not null default 1,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Financeiro (Fase 2)
-- ---------------------------------------------------------------------------------------------------------------
create table public.accounts (
  user_id               uuid not null references auth.users (id) on delete cascade,
  id                    public.lf_id not null,
  name                  text not null check (char_length(name) between 1 and 60),
  type                  text not null check (type in ('checking', 'savings', 'cash', 'credit_card', 'investment')),
  initial_balance_cents public.lf_cents not null,
  balance_cents         bigint not null,
  archived              boolean not null,
  created_at            public.lf_ts not null,
  updated_at            public.lf_ts not null,
  request_hash          text not null,
  version               bigint not null default 1,
  primary key (user_id, id)
);

create table public.categories (
  user_id      uuid not null references auth.users (id) on delete cascade,
  id           public.lf_id not null,
  name         text not null check (char_length(name) between 1 and 60),
  kind         text not null check (kind in ('income', 'expense')),
  archived     boolean not null,
  created_at   public.lf_ts not null,
  updated_at   public.lf_ts not null,
  request_hash text not null,
  version      bigint not null default 1,
  primary key (user_id, id)
);

create table public.transactions (
  user_id        uuid not null references auth.users (id) on delete cascade,
  id             public.lf_id not null,
  account_id     public.lf_id not null,
  type           text not null check (type in ('income', 'expense', 'transfer_out', 'transfer_in')),
  amount_cents   public.lf_pos_cents not null,
  signed_cents   bigint not null,
  date           public.lf_date not null,
  category_id    public.lf_id,
  description    text not null check (char_length(description) between 1 and 140),
  notes          text check (char_length(notes) <= 500),
  status         text not null check (status in ('posted', 'voided')),
  transfer_id    public.lf_id,
  payable_id     public.lf_id,
  created_at     public.lf_ts not null,
  updated_at     public.lf_ts not null,
  voided_at      public.lf_ts,
  request_hash   text not null,
  origin         text check (origin in ('manual', 'ai')),
  ai_action_id   public.lf_id,
  version        bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts (user_id, id),
  constraint transactions_sign check (
    (type in ('income', 'transfer_in') and signed_cents = amount_cents)
    or (type in ('expense', 'transfer_out') and signed_cents = -amount_cents)
  )
);

create table public.transfers (
  user_id            uuid not null references auth.users (id) on delete cascade,
  id                 public.lf_id not null,
  from_account_id    public.lf_id not null,
  to_account_id      public.lf_id not null,
  amount_cents       public.lf_pos_cents not null,
  date               public.lf_date not null,
  description        text check (char_length(description) <= 140),
  status             text not null check (status in ('posted', 'voided')),
  out_transaction_id public.lf_id not null,
  in_transaction_id  public.lf_id not null,
  created_at         public.lf_ts not null,
  updated_at         public.lf_ts not null,
  voided_at          public.lf_ts,
  request_hash       text not null,
  version            bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, from_account_id) references public.accounts (user_id, id),
  foreign key (user_id, to_account_id) references public.accounts (user_id, id),
  constraint transfers_distinct_accounts check (from_account_id <> to_account_id)
);

create table public.payables (
  user_id           uuid not null references auth.users (id) on delete cascade,
  id                public.lf_id not null,
  kind              text not null check (kind in ('payable', 'receivable')),
  description       text not null check (char_length(description) between 1 and 140),
  amount_cents      public.lf_pos_cents not null,
  due_date          public.lf_date not null,
  account_id        public.lf_id,
  category_id       public.lf_id,
  status            text not null check (status in ('open', 'paid', 'canceled')),
  paid_date         public.lf_date,
  paid_amount_cents public.lf_pos_cents,
  transaction_id    public.lf_id,
  pay_count         integer not null check (pay_count >= 0),
  recurring_id      public.lf_id,
  created_at        public.lf_ts not null,
  updated_at        public.lf_ts not null,
  request_hash      text not null,
  pay_request_hash  text,
  version           bigint not null default 1,
  primary key (user_id, id),
  -- Paga = data, valor e lançamento preenchidos; não paga = tudo vazio.
  constraint payables_paid_shape check (
    case when status = 'paid'
      then paid_date is not null and paid_amount_cents is not null and transaction_id is not null
      else paid_date is null and paid_amount_cents is null and transaction_id is null
    end
  )
);

create table public.recurring (
  user_id                   uuid not null references auth.users (id) on delete cascade,
  id                        public.lf_id not null,
  kind                      text not null check (kind in ('payable', 'receivable')),
  description               text not null check (char_length(description) between 1 and 140),
  amount_cents              public.lf_pos_cents not null,
  frequency                 text not null check (frequency in ('weekly', 'monthly', 'yearly')),
  start_date                public.lf_date not null,
  end_date                  public.lf_date,
  account_id                public.lf_id,
  category_id               public.lf_id,
  active                    boolean not null,
  last_materialized_through public.lf_date,
  created_at                public.lf_ts not null,
  updated_at                public.lf_ts not null,
  request_hash              text not null,
  version                   bigint not null default 1,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Agenda e tarefas (Fase 3)
-- ---------------------------------------------------------------------------------------------------------------
create table public.events (
  user_id                uuid not null references auth.users (id) on delete cascade,
  id                     public.lf_id not null,
  title                  text not null check (char_length(title) between 1 and 120),
  kind                   text not null check (kind in ('personal', 'professional', 'medical', 'family', 'meeting', 'trip', 'other')),
  description            text check (char_length(description) <= 1000),
  start_date             public.lf_date not null,
  start_time             public.lf_time,
  duration_min           integer not null check (duration_min between 1 and 20160),
  time_zone              text not null check (char_length(time_zone) between 1 and 64),
  location               text check (char_length(location) <= 200),
  contact                text check (char_length(contact) <= 200),
  link                   text check (char_length(link) <= 500 and link ~ '^https?://[^ ]+$'),
  notes                  text check (char_length(notes) <= 1000),
  estimated_cost_cents   public.lf_pos_cents,
  reminders              text not null default '' check (reminders ~ '^([0-9]{1,5}(,[0-9]{1,5}){0,4})?$'),
  rec_frequency          text check (rec_frequency in ('daily', 'weekly', 'monthly', 'yearly', 'custom')),
  rec_interval           integer check (rec_interval between 1 and 99),
  rec_weekdays           text not null default '' check (rec_weekdays ~ '^([0-6](,[0-6]){0,6})?$'),
  rec_until              public.lf_date,
  rec_count              integer check (rec_count between 1 and 1000),
  expense_transaction_id public.lf_id,
  created_at             public.lf_ts not null,
  updated_at             public.lf_ts not null,
  request_hash           text not null check (char_length(request_hash) <= 100),
  version                bigint not null default 1,
  primary key (user_id, id)
);

-- Exceções de UMA ocorrência. Os campos de sobrescrita são ESPARSOS: "ausente" herda da série e "presente (mesmo
-- nulo)" sobrescreve. `present_fields` guarda quais foram informados (ver lf_doc_json em 20261123000003_api.sql).
create table public.event_exceptions (
  user_id                uuid not null references auth.users (id) on delete cascade,
  id                     public.lf_id not null,
  series_id              public.lf_id not null,
  original_date          public.lf_date not null,
  canceled               boolean not null,
  created_at             public.lf_ts not null,
  updated_at             public.lf_ts not null,
  start_date             public.lf_date,
  start_time             public.lf_time,
  duration_min           integer check (duration_min between 1 and 20160),
  title                  text check (char_length(title) between 1 and 120),
  kind                   text check (kind in ('personal', 'professional', 'medical', 'family', 'meeting', 'trip', 'other')),
  description            text check (char_length(description) <= 1000),
  location               text check (char_length(location) <= 200),
  contact                text check (char_length(contact) <= 200),
  link                   text check (char_length(link) <= 500 and link ~ '^https?://[^ ]+$'),
  notes                  text check (char_length(notes) <= 1000),
  estimated_cost_cents   public.lf_pos_cents,
  reminders              text check (reminders ~ '^([0-9]{1,5}(,[0-9]{1,5}){0,4})?$'),
  expense_transaction_id public.lf_id,
  present_fields         text[] not null default '{}',
  version                bigint not null default 1,
  primary key (user_id, id)
);

create table public.tasks (
  user_id          uuid not null references auth.users (id) on delete cascade,
  id               public.lf_id not null,
  title            text not null check (char_length(title) between 1 and 140),
  description      text check (char_length(description) <= 1000),
  priority         text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  category_id      public.lf_id,
  due_date         public.lf_date,
  due_time         public.lf_time,
  status           text not null check (status in ('pending', 'in_progress', 'completed', 'canceled')),
  reminder_minutes integer check (reminder_minutes between 0 and 40320),
  completed_at     public.lf_ts,
  created_at       public.lf_ts not null,
  updated_at       public.lf_ts not null,
  request_hash     text not null check (char_length(request_hash) <= 100),
  version          bigint not null default 1,
  primary key (user_id, id),
  constraint tasks_time_needs_date check (due_time is null or due_date is not null),
  constraint tasks_reminder_needs_date check (reminder_minutes is null or due_date is not null),
  constraint tasks_completed_shape check (status = 'completed' or completed_at is null)
);

create table public.task_categories (
  user_id      uuid not null references auth.users (id) on delete cascade,
  id           public.lf_id not null,
  name         text not null check (char_length(name) between 1 and 60),
  archived     boolean not null,
  created_at   public.lf_ts not null,
  updated_at   public.lf_ts not null,
  request_hash text not null,
  version      bigint not null default 1,
  primary key (user_id, id)
);

create table public.reminders (
  user_id      uuid not null references auth.users (id) on delete cascade,
  id           public.lf_id not null,
  title        text not null check (char_length(title) between 1 and 140),
  remind_at    text not null check (remind_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'),
  created_at   public.lf_ts not null,
  request_hash text not null,
  version      bigint not null default 1,
  primary key (user_id, id)
);

create table public.notifications (
  user_id        uuid not null references auth.users (id) on delete cascade,
  id             public.lf_id not null,
  type           text not null check (type in ('event_reminder', 'task_reminder', 'task_overdue', 'payable_due', 'reminder')),
  title          text not null check (char_length(title) between 1 and 200),
  body           text not null check (char_length(body) <= 300),
  source_type    text not null check (source_type in ('event', 'task', 'payable', 'reminder')),
  source_id      public.lf_id not null,
  occurrence_key text not null check (char_length(occurrence_key) between 1 and 120),
  trigger_at     public.lf_ts not null,
  silent         boolean not null,
  read           boolean not null,
  read_at        public.lf_ts,
  dismissed      boolean not null,
  created_at     public.lf_ts not null,
  version        bigint not null default 1,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Assistente de IA (Fase 4)
-- ---------------------------------------------------------------------------------------------------------------
create table public.ai_conversations (
  user_id    uuid not null references auth.users (id) on delete cascade,
  id         public.lf_id not null,
  title      text not null check (char_length(title) between 1 and 60),
  created_at public.lf_ts not null,
  updated_at public.lf_ts not null,
  version    bigint not null default 1,
  primary key (user_id, id)
);

create table public.ai_messages (
  user_id         uuid not null references auth.users (id) on delete cascade,
  id              public.lf_id not null,
  conversation_id public.lf_id not null,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) between 1 and 4000),
  created_at      public.lf_ts not null,
  version         bigint not null default 1,
  primary key (user_id, conversation_id, id),
  foreign key (user_id, conversation_id) references public.ai_conversations (user_id, id) on delete cascade
);

create table public.ai_actions (
  user_id         uuid not null references auth.users (id) on delete cascade,
  id              public.lf_id not null,
  conversation_id public.lf_id not null,
  message_id      public.lf_id not null,
  tool            text not null check (char_length(tool) between 1 and 40),
  kind            text not null check (kind in ('create', 'update', 'delete')),
  financial       boolean not null,
  args_json       text not null check (char_length(args_json) <= 4500),
  args_hash       text not null check (char_length(args_hash) = 64),
  summary         text not null check (char_length(summary) between 1 and 500),
  amount_cents    public.lf_pos_cents,
  reinforced      boolean not null,
  status          text not null check (status in ('pending', 'executing', 'done', 'failed', 'blocked', 'expired', 'rejected')),
  result_note     text check (char_length(result_note) <= 300),
  expires_at      public.lf_ts not null,
  created_at      public.lf_ts not null,
  updated_at      public.lf_ts not null,
  version         bigint not null default 1,
  primary key (user_id, id)
);

-- Trilha de auditoria: só inclusão.
create table public.ai_logs (
  user_id         uuid not null references auth.users (id) on delete cascade,
  id              public.lf_id not null,
  event           text not null check (event in ('proposed', 'auto_executed', 'confirmed', 'executed', 'failed', 'rejected', 'blocked', 'expired', 'unauthorized_tool', 'invalid_args', 'provider_error')),
  tool            text check (char_length(tool) between 1 and 60),
  action_id       public.lf_id,
  args_hash       text check (char_length(args_hash) between 1 and 64),
  detail          text not null check (char_length(detail) <= 300),
  conversation_id text check (char_length(conversation_id) between 1 and 80),
  created_at      public.lf_ts not null,
  version         bigint not null default 1,
  primary key (user_id, id)
);

-- Contadores que só crescem. `id` = mês (AAAA-MM) ou dia (AAAA-MM-DD).
create table public.ai_usage (
  user_id       uuid not null references auth.users (id) on delete cascade,
  id            text not null check (id ~ '^[0-9]{4}-[0-9]{2}$'),
  messages      bigint not null default 0 check (messages >= 0),
  voice_seconds bigint not null default 0 check (voice_seconds >= 0),
  input_tokens  bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  updated_at    public.lf_ts not null,
  version       bigint not null default 1,
  primary key (user_id, id)
);
create index ai_usage_updated_at_idx on public.ai_usage (updated_at);

create table public.ai_daily (
  user_id          uuid not null references auth.users (id) on delete cascade,
  id               public.lf_date not null,
  auto_actions     bigint not null default 0 check (auto_actions >= 0),
  auto_value_cents bigint not null default 0 check (auto_value_cents >= 0),
  updated_at       public.lf_ts not null,
  version          bigint not null default 1,
  primary key (user_id, id)
);

create index ai_logs_event_idx on public.ai_logs (event, created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- SaaS: planos, assinaturas e cobrança (Fase 5). Só o backend (service_role) escreve.
-- ---------------------------------------------------------------------------------------------------------------
create table public.plans (
  id                       text primary key check (id in ('free', 'pro', 'premium_ai')),
  name                     text,
  price_cents              bigint,
  ai_messages_per_month    bigint,
  voice_minutes_per_month  bigint,
  reports                  text,
  trial_days               bigint,
  active                   boolean,
  updated_at               public.lf_ts,
  updated_by               text,
  version                  bigint not null default 1
);

create table public.subscriptions (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  id                       text generated always as (user_id::text) stored,
  plan_id                  text,
  pending_plan_id          text,
  status                   text check (status in ('pending', 'active', 'past_due', 'canceled')),
  provider_subscription_id text,
  price_cents              bigint,
  current_period_end       public.lf_ts,
  grace_until              public.lf_ts,
  cancel_at_period_end     boolean,
  trial_ends_at            public.lf_ts,
  checkout_url             text,
  checkout_key_hash        text,
  created_at               public.lf_ts,
  updated_at               public.lf_ts,
  version                  bigint not null default 1
);
create index subscriptions_provider_idx on public.subscriptions (provider_subscription_id);
create index subscriptions_status_idx on public.subscriptions (status);

create table public.billing_payments (
  user_id         uuid not null references auth.users (id) on delete cascade,
  id              text not null check (char_length(id) between 1 and 128),
  plan_id         text,
  subscription_id text,
  amount_cents    bigint,
  status          text,
  created_at      public.lf_ts,
  updated_at      public.lf_ts,
  version         bigint not null default 1,
  primary key (user_id, id)
);

create table public.webhook_events (
  id           text primary key,
  provider     text,
  kind         text,
  resource_id  text,
  received_at  public.lf_ts,
  status       text,
  detail       text,
  processed_at public.lf_ts,
  version      bigint not null default 1
);
create index webhook_events_status_idx on public.webhook_events (status);

create table public.admin_logs (
  id         text primary key,
  admin_uid  text,
  action     text,
  target     text,
  detail     text,
  created_at public.lf_ts,
  version    bigint not null default 1
);
