-- LifeFlow AI — funções chamadas pelo Worker (PostgREST `/rest/v1/rpc/...`; D-011).
--
-- O Worker continua falando "documentos por caminho" (`users/{uid}/accounts/{id}`) e o banco traduz para as tabelas
-- relacionais. Estas funções são SECURITY INVOKER: rodam com o papel do chamador, então a RLS, os privilégios e os
-- gatilhos valem exatamente como valeriam num acesso direto à tabela. Nenhuma credencial de serviço é necessária
-- nas rotas normais — só o JWT do usuário.
--
-- Todo SQL dinâmico é montado com format(%I/%L) sobre uma LISTA FECHADA de tabelas e colunas existentes (nunca
-- sobre texto do cliente), então não há injeção de SQL.

-- ---------------------------------------------------------------------------------------------------------------
-- Registro de coleções
-- ---------------------------------------------------------------------------------------------------------------
-- (coleção do caminho) -> (tabela, escopo). Escopos: profile (users/{uid}), user (users/{uid}/{coleção}/{id}),
-- child (mensagens de uma conversa), sub (subscriptions/{uid}) e root (coleção global).
create or replace function public.lf_table_of(p_collection text)
returns table (tbl text, scope text)
language sql
immutable
set search_path = public, pg_temp
as $$
  select v.tbl, v.scope
  from (values
    ('users', 'profiles', 'profile'),
    ('preferences', 'preferences', 'user'),
    ('consents', 'consents', 'user'),
    ('accounts', 'accounts', 'user'),
    ('categories', 'categories', 'user'),
    ('transactions', 'transactions', 'user'),
    ('transfers', 'transfers', 'user'),
    ('payables', 'payables', 'user'),
    ('recurring', 'recurring', 'user'),
    ('events', 'events', 'user'),
    ('eventExceptions', 'event_exceptions', 'user'),
    ('tasks', 'tasks', 'user'),
    ('taskCategories', 'task_categories', 'user'),
    ('reminders', 'reminders', 'user'),
    ('notifications', 'notifications', 'user'),
    ('aiConversations', 'ai_conversations', 'user'),
    ('aiActions', 'ai_actions', 'user'),
    ('aiLogs', 'ai_logs', 'user'),
    ('aiUsage', 'ai_usage', 'user'),
    ('aiDaily', 'ai_daily', 'user'),
    ('billingPayments', 'billing_payments', 'user'),
    ('messages', 'ai_messages', 'child'),
    ('subscriptions', 'subscriptions', 'sub'),
    ('plans', 'plans', 'root'),
    ('webhookEvents', 'webhook_events', 'root'),
    ('adminLogs', 'admin_logs', 'root')
  ) as v (coll, tbl, scope)
  where v.coll = p_collection
$$;

create or replace function public.lf_invalid(p_what text)
returns void
language plpgsql
immutable
as $$
begin
  raise exception 'lf: %', p_what using errcode = '22023';
end
$$;

create or replace function public.lf_uuid(p_text text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_text::uuid;
exception when invalid_text_representation then
  raise exception 'lf: identificador de usuário inválido' using errcode = '22023';
end
$$;

-- Caminho -> (tabela, escopo, dono, id, id da conversa).
create or replace function public.lf_resolve(p_path text)
returns table (tbl text, scope text, owner uuid, id text, parent_id text, coll text)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  parts text[];
  n int;
  t record;
begin
  if p_path is null or p_path = '' or p_path ~ '(^/|//|/$)' then
    perform public.lf_invalid('caminho inválido');
  end if;
  parts := string_to_array(p_path, '/');
  n := array_length(parts, 1);

  if parts[1] = 'users' and n = 2 then
    return query select 'profiles'::text, 'profile'::text, public.lf_uuid(parts[2]), parts[2], null::text, 'users'::text;
  elsif parts[1] = 'users' and n = 4 then
    select * into t from public.lf_table_of(parts[3]) x where x.scope = 'user';
    if t.tbl is null then perform public.lf_invalid('coleção desconhecida'); end if;
    return query select t.tbl, t.scope, public.lf_uuid(parts[2]), parts[4], null::text, parts[3];
  elsif parts[1] = 'users' and n = 6 and parts[3] = 'aiConversations' and parts[5] = 'messages' then
    return query select 'ai_messages'::text, 'child'::text, public.lf_uuid(parts[2]), parts[6], parts[4], 'messages'::text;
  elsif n = 2 and parts[1] <> 'users' then
    select * into t from public.lf_table_of(parts[1]) x where x.scope in ('root', 'sub');
    if t.tbl is null then perform public.lf_invalid('coleção desconhecida'); end if;
    return query select t.tbl, t.scope,
      case when t.scope = 'sub' then public.lf_uuid(parts[2]) else null::uuid end, parts[2], null::text, parts[1];
  else
    perform public.lf_invalid('caminho inválido');
  end if;
end
$$;

-- Colunas graváveis do documento (exclui chaves, `version` e colunas geradas).
create or replace function public.lf_data_cols(p_tbl text)
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(a.attname::text order by a.attnum), '{}')
  from pg_attribute a
  where a.attrelid = ('public.' || quote_ident(p_tbl))::regclass
    and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
    and a.attname not in ('id', 'version', 'user_id')
$$;

create or replace function public.lf_is_text(p_tbl text, p_col text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select t.typcategory = 'S'
                   from pg_attribute a join pg_type t on t.oid = a.atttypid
                   where a.attrelid = ('public.' || quote_ident(p_tbl))::regclass and a.attname = p_col), false)
$$;

-- Linha da tabela -> documento da API. Esparsos: campos de sobrescrita ausentes não aparecem.
create or replace function public.lf_doc_json(p_tbl text, p_row jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  doc jsonb := p_row - 'version' - 'id';
  c text;
  present text[];
begin
  if p_tbl = 'event_exceptions' then
    present := array(select jsonb_array_elements_text(p_row -> 'present_fields'));
    foreach c in array array['start_date', 'start_time', 'duration_min', 'title', 'kind', 'description', 'location',
                              'contact', 'link', 'notes', 'estimated_cost_cents', 'reminders', 'expense_transaction_id'] loop
      if not (c = any (present)) then doc := doc - c; end if;
    end loop;
    doc := doc - 'present_fields';
  end if;
  return doc;
end
$$;

create or replace function public.lf_key_where(p_scope text, p_owner uuid, p_id text, p_parent text)
returns text
language sql
immutable
as $$
  select case p_scope
    when 'profile' then format('t.user_id = %L::uuid', p_owner)
    when 'sub'     then format('t.user_id = %L::uuid', p_owner)
    when 'user'    then format('t.user_id = %L::uuid and t.id = %L', p_owner, p_id)
    when 'child'   then format('t.user_id = %L::uuid and t.conversation_id = %L and t.id = %L', p_owner, p_parent, p_id)
    else format('t.id = %L', p_id)
  end
$$;

create or replace function public.lf_path_expr(p_scope text, p_coll text)
returns text
language sql
immutable
as $$
  select case p_scope
    when 'profile' then $q$'users/' || t.user_id::text$q$
    when 'user'    then format($q$'users/' || t.user_id::text || '/%s/' || t.id$q$, p_coll)
    when 'child'   then $q$'users/' || t.user_id::text || '/aiConversations/' || t.conversation_id || '/messages/' || t.id$q$
    when 'sub'     then $q$'subscriptions/' || t.id$q$
    else format($q$'%s/' || t.id$q$, p_coll)
  end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Leitura de um documento
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.lf_get(p_path text)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  r record;
  result jsonb;
begin
  begin
    select * into r from public.lf_resolve(p_path);
  exception when sqlstate '22023' then
    -- Um id de usuário que nem é UUID não pode existir: leitura => "não encontrado" (as escritas seguem recusando).
    if sqlerrm like '%identificador de usuário inválido%' then return null; end if;
    raise;
  end;
  execute format('select jsonb_build_object(''data'', public.lf_doc_json(%L, to_jsonb(t)), ''version'', t.version::text) from public.%I t where %s',
                 r.tbl, r.tbl, public.lf_key_where(r.scope, r.owner, r.id, r.parent_id))
    into result;
  return result;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Escrita atômica: aplica todas as operações ou nenhuma (uma função = uma transação).
--   op = { path, fields?, merge?, increments?, precondition?: {exists}|{updateTime}, delete? }
-- Pré-condição não satisfeita => SQLSTATE PT409 (HTTP 409 no PostgREST), e nada é gravado.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.lf_apply(op jsonb)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  r record;
  v_fields jsonb := coalesce(op -> 'fields', '{}'::jsonb);
  v_incr jsonb := coalesce(op -> 'increments', '{}'::jsonb);
  v_pre jsonb := op -> 'precondition';
  v_merge boolean := coalesce((op ->> 'merge')::boolean, false) or v_incr <> '{}'::jsonb;
  v_cols text[];
  v_keys text[];
  v_ikeys text[];
  v_sparse boolean;
  v_where text;
  v_vcond text := '';
  k text;
  v_sets text[] := '{}';
  v_icols text[] := '{}';
  v_ivals text[] := '{}';
  v_n bigint;
  v_sql text;
  v_json jsonb;
  v_present text;
  v_tries int := 0;
begin
  select * into r from public.lf_resolve(op ->> 'path');
  v_where := public.lf_key_where(r.scope, r.owner, r.id, r.parent_id);
  if v_pre ? 'updateTime' then
    v_vcond := format(' and t.version = %L::bigint', v_pre ->> 'updateTime');
  end if;

  -- Exclusão.
  if coalesce((op ->> 'delete')::boolean, false) then
    execute format('delete from public.%I t where %s%s', r.tbl, v_where, v_vcond);
    get diagnostics v_n = row_count;
    if v_pre is not null and v_n = 0 then
      raise exception 'precondition_failed' using errcode = 'PT409';
    end if;
    return;
  end if;

  v_cols := public.lf_data_cols(r.tbl);
  v_sparse := r.tbl = 'event_exceptions';

  -- `user_id`/`conversation_id` vêm do CAMINHO; o corpo, se os trouxer, tem de concordar.
  if v_fields ? 'user_id' and r.owner is not null and (v_fields ->> 'user_id') is distinct from r.owner::text then
    raise exception 'uid do documento diferente do caminho' using errcode = 'PT403';
  end if;
  if r.scope = 'child' and v_fields ? 'conversation_id' and (v_fields ->> 'conversation_id') is distinct from r.parent_id then
    raise exception 'conversa do documento diferente do caminho' using errcode = 'PT403';
  end if;
  v_fields := v_fields - 'user_id';
  if r.scope = 'child' then v_fields := v_fields - 'conversation_id'; end if;

  v_keys := array(select jsonb_object_keys(v_fields));
  v_ikeys := array(select jsonb_object_keys(v_incr));
  foreach k in array v_keys || v_ikeys loop
    if not (k = any (v_cols)) or k = 'present_fields' or (r.scope = 'child' and k = 'conversation_id') then
      raise exception 'lf: campo desconhecido: %', k using errcode = '22023';
    end if;
  end loop;

  v_json := v_fields || v_incr;  -- no INSERT o incremento é o valor inicial (campo ausente conta como 0)
  v_present := format('%L::text[]', v_keys);

  -- Atribuições do UPDATE.
  if v_merge then
    foreach k in array v_keys loop
      v_sets := v_sets || format('%I = d.%I', k, k);
    end loop;
    foreach k in array v_ikeys loop
      v_sets := v_sets || format('%I = coalesce(t.%I, 0) + %L::bigint', k, k, v_incr ->> k);
    end loop;
    if v_sparse then
      v_sets := v_sets || format('present_fields = (select coalesce(array_agg(distinct x), ''{}'') from unnest(t.present_fields || %s) x)', v_present);
    end if;
  else
    -- Substituição integral: colunas não informadas voltam ao padrão.
    foreach k in array v_cols loop
      if k = 'present_fields' then continue; end if;
      v_sets := v_sets || case when k = any (v_keys) then format('%I = d.%I', k, k) else format('%I = default', k) end;
    end loop;
    if v_sparse then v_sets := v_sets || format('present_fields = %s', v_present); end if;
  end if;
  if cardinality(v_sets) = 0 then
    -- Nada a alterar (ex.: `fields` vazio): só verifica existência/pré-condição.
    v_sets := array['version = t.version'];
  end if;

  -- Colunas/valores do INSERT.
  v_icols := case r.scope
    when 'profile' then array['user_id'] when 'sub' then array['user_id']
    when 'user' then array['user_id', 'id'] when 'child' then array['user_id', 'conversation_id', 'id']
    else array['id'] end;
  v_ivals := case r.scope
    when 'profile' then array[format('%L::uuid', r.owner)] when 'sub' then array[format('%L::uuid', r.owner)]
    when 'user' then array[format('%L::uuid', r.owner), format('%L', r.id)]
    when 'child' then array[format('%L::uuid', r.owner), format('%L', r.parent_id), format('%L', r.id)]
    else array[format('%L', r.id)] end;
  foreach k in array v_keys || v_ikeys loop
    v_icols := v_icols || format('%I', k);
    v_ivals := v_ivals || format('d.%I', k);
  end loop;
  if v_sparse then
    v_icols := v_icols || 'present_fields'::text;
    v_ivals := v_ivals || v_present;
  end if;

  if v_pre ? 'exists' and not (v_pre ->> 'exists')::boolean then
    -- Só cria.
    begin
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) d',
                     r.tbl, array_to_string(v_icols, ', '), array_to_string(v_ivals, ', '), r.tbl) using v_json;
    exception when unique_violation then
      raise exception 'precondition_failed' using errcode = 'PT409';
    end;
    return;
  end if;

  v_sql := format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) d where %s%s',
                  r.tbl, array_to_string(v_sets, ', '), r.tbl, v_where, v_vcond);

  if v_pre is not null then
    -- exists:true ou updateTime: só altera o que existe (e, no segundo caso, não mudou desde a leitura).
    execute v_sql using v_json;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'precondition_failed' using errcode = 'PT409'; end if;
    return;
  end if;

  -- Sem pré-condição: upsert (altera; se não existir, cria; trata corrida com outra transação).
  loop
    v_tries := v_tries + 1;
    if v_tries > 3 then
      -- Existe, mas o UPDATE não alcança a linha (RLS): não é uma corrida, é um documento que não podemos alterar.
      raise exception 'documento não pode ser alterado' using errcode = 'PT403';
    end if;
    execute v_sql using v_json;
    get diagnostics v_n = row_count;
    exit when v_n > 0;
    begin
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) d',
                     r.tbl, array_to_string(v_icols, ', '), array_to_string(v_ivals, ', '), r.tbl) using v_json;
      exit;
    exception when unique_violation then
      null; -- outra transação criou no meio: tenta o UPDATE de novo
    end;
  end loop;
end
$$;

create or replace function public.lf_commit(p_ops jsonb)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  op jsonb;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    perform public.lf_invalid('ops deve ser uma lista');
  end if;
  for op in select value from jsonb_array_elements(p_ops) loop
    perform public.lf_apply(op);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Consulta: filtros, ordenação, cursor e limite.
--   spec = { filters: [{field, op: EQUAL|GREATER_THAN_OR_EQUAL|LESS_THAN_OR_EQUAL, value}],
--            orderBy: {field, direction}, after: {value, id}, limit, group }
-- Ordem: nulos primeiro na ordem crescente (como o Firestore); desempate pelo id; texto em colação "C" (bytes).
-- ---------------------------------------------------------------------------------------------------------------
-- Valor do filtro como literal SQL do tipo certo, SEM passar pelas validações dos domínios (um filtro `>= '2026-11-01'`
-- é uma data parcial, inválida como `lf_ts`, mas legítima como limite de faixa).
create or replace function public.lf_literal(p_tbl text, p_col text, p_value jsonb)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p_value) = 'null' or p_value is null then 'null'
    when (select t.typcategory from pg_attribute a join pg_type t on t.oid = a.atttypid
          where a.attrelid = ('public.' || quote_ident(p_tbl))::regclass and a.attname = p_col) = 'S'
      then quote_literal(p_value #>> '{}') || ' collate "C"'
    when (select t.typcategory from pg_attribute a join pg_type t on t.oid = a.atttypid
          where a.attrelid = ('public.' || quote_ident(p_tbl))::regclass and a.attname = p_col) = 'B'
      then quote_literal(p_value #>> '{}') || '::boolean'
    else quote_literal(p_value #>> '{}') || '::numeric'
  end
$$;

-- Expressão da coluna para comparação: texto em colação "C" (bytes, como o Firestore), sem validar o domínio.
create or replace function public.lf_col_expr(p_tbl text, p_col text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case when public.lf_is_text(p_tbl, p_col) then format('t.%I::text collate "C"', p_col) else format('t.%I', p_col) end
$$;

create or replace function public.lf_build_where(p_tbl text, p_filters jsonb)
returns text[]
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  f jsonb;
  col text;
  cols text[] := public.lf_data_cols(p_tbl) || array['id', 'user_id', 'conversation_id'];
  op text;
  out text[] := '{}';
begin
  for f in select value from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) loop
    col := f ->> 'field';
    if not (col = any (cols)) then perform public.lf_invalid('campo de filtro desconhecido: ' || coalesce(col, 'null')); end if;
    op := case f ->> 'op' when 'EQUAL' then '=' when 'GREATER_THAN_OR_EQUAL' then '>=' when 'LESS_THAN_OR_EQUAL' then '<='
          else null end;
    if op is null then perform public.lf_invalid('operador inválido'); end if;
    out := out || format('%s %s %s', public.lf_col_expr(p_tbl, col), op, public.lf_literal(p_tbl, col, f -> 'value'));
  end loop;
  return out;
end
$$;

create or replace function public.lf_query(p_parent text, p_collection text, p_spec jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  t record;
  v_group boolean := coalesce((p_spec ->> 'group')::boolean, false);
  v_where text[];
  v_order_col text := coalesce(p_spec #>> '{orderBy,field}', 'id');
  v_dir text := case when p_spec #>> '{orderBy,direction}' = 'DESCENDING' then 'DESC' else 'ASC' end;
  v_after jsonb := p_spec -> 'after';
  v_cols text[];
  v_limit int := least(greatest(coalesce((p_spec ->> 'limit')::int, 100), 1), 5000);
  v_cmp text;
  v_val text;
  v_aid text;
  v_ocol text;
  v_text boolean;
  v_parent_parts text[];
  v_result jsonb;
begin
  select * into t from public.lf_table_of(p_collection);
  if t.tbl is null or t.scope = 'profile' then perform public.lf_invalid('coleção desconhecida'); end if;
  v_cols := public.lf_data_cols(t.tbl) || array['id'];
  v_where := public.lf_build_where(t.tbl, p_spec -> 'filters');

  if v_group then
    if coalesce(p_parent, '') <> '' or t.scope not in ('user', 'child') then perform public.lf_invalid('consulta de grupo inválida'); end if;
  elsif t.scope in ('user') then
    v_parent_parts := string_to_array(coalesce(p_parent, ''), '/');
    if cardinality(v_parent_parts) <> 2 or v_parent_parts[1] <> 'users' then perform public.lf_invalid('parent inválido'); end if;
    v_where := v_where || format('t.user_id = %L::uuid', public.lf_uuid(v_parent_parts[2]));
  elsif t.scope = 'child' then
    v_parent_parts := string_to_array(coalesce(p_parent, ''), '/');
    if cardinality(v_parent_parts) <> 4 or v_parent_parts[1] <> 'users' or v_parent_parts[3] <> 'aiConversations' then
      perform public.lf_invalid('parent inválido');
    end if;
    v_where := v_where || format('t.user_id = %L::uuid', public.lf_uuid(v_parent_parts[2]))
                       || format('t.conversation_id = %L', v_parent_parts[4]);
  else
    if coalesce(p_parent, '') <> '' then perform public.lf_invalid('parent inválido'); end if;
  end if;

  if not (v_order_col = any (v_cols)) then perform public.lf_invalid('campo de ordenação desconhecido'); end if;
  v_text := public.lf_is_text(t.tbl, v_order_col);
  v_ocol := public.lf_col_expr(t.tbl, v_order_col);

  if v_after is not null and v_after <> 'null'::jsonb then
    v_aid := v_after ->> 'id';
    v_cmp := case when v_dir = 'ASC' then '>' else '<' end;
    if v_order_col = 'id' then
      v_where := v_where || format('t.id collate "C" %s %L', v_cmp, v_aid);
    elsif (v_after -> 'value') is null or jsonb_typeof(v_after -> 'value') = 'null' then
      v_where := v_where || case when v_dir = 'ASC'
        then format('(t.%I is not null or t.id collate "C" > %L)', v_order_col, v_aid)
        else format('(t.%I is null and t.id collate "C" < %L)', v_order_col, v_aid) end;
    else
      v_val := public.lf_literal(t.tbl, v_order_col, v_after -> 'value');
      v_where := v_where || case when v_dir = 'ASC'
        then format('(%s > %s or (%s = %s and t.id collate "C" > %L))', v_ocol, v_val, v_ocol, v_val, v_aid)
        else format('(%s < %s or (%s = %s and t.id collate "C" < %L) or t.%I is null)', v_ocol, v_val, v_ocol, v_val, v_aid, v_order_col) end;
    end if;
  end if;

  execute format(
    'select coalesce(jsonb_agg(q.x), ''[]''::jsonb) from (
       select jsonb_build_object(''id'', t.id, ''path'', %s, ''version'', t.version::text,
                                 ''data'', public.lf_doc_json(%L, to_jsonb(t))) as x
       from public.%I t
       where %s
       order by %s %s %s, t.id collate "C" %s
       limit %s) q',
    public.lf_path_expr(t.scope, p_collection), t.tbl, t.tbl,
    case when cardinality(v_where) = 0 then 'true' else array_to_string(v_where, ' and ') end,
    v_ocol, v_dir, case when v_dir = 'ASC' then 'nulls first' else 'nulls last' end, v_dir, v_limit)
    into v_result;
  return v_result;
end
$$;

create or replace function public.lf_count(p_collection text, p_filters jsonb default '[]'::jsonb)
returns bigint
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  t record;
  v_where text[];
  v_n bigint;
begin
  select * into t from public.lf_table_of(p_collection);
  if t.tbl is null then perform public.lf_invalid('coleção desconhecida'); end if;
  v_where := public.lf_build_where(t.tbl, p_filters);
  execute format('select count(*) from public.%I t where %s', t.tbl,
                 case when cardinality(v_where) = 0 then 'true' else array_to_string(v_where, ' and ') end)
    into v_n;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Exclusão de conta (LGPD): remove o usuário de auth.users; as FKs `on delete cascade` apagam TODO o resto.
-- Só o backend (service_role) executa; o Worker já exigiu login recente e cancelou a cobrança no provedor.
-- Devolve quantos registros foram apagados (inclui o usuário). Idempotente: usuário inexistente => 0.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.lf_erase_user(p_uid uuid)
returns bigint
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  t text;
  n bigint;
  total bigint := 0;
begin
  if p_uid is null then perform public.lf_invalid('uid obrigatório'); end if;
  foreach t in array array[
    'profiles', 'preferences', 'consents', 'accounts', 'categories', 'transactions', 'transfers', 'payables',
    'recurring', 'events', 'event_exceptions', 'tasks', 'task_categories', 'reminders', 'notifications',
    'ai_conversations', 'ai_messages', 'ai_actions', 'ai_logs', 'ai_usage', 'ai_daily', 'subscriptions',
    'billing_payments'
  ] loop
    execute format('select count(*) from public.%I where user_id = $1', t) into n using p_uid;
    total := total + n;
  end loop;
  delete from auth.users where id = p_uid;
  get diagnostics n = row_count;
  return total + n;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Privilégios das funções (o Supabase concede EXECUTE a anon/authenticated por padrão: revogamos e damos o mínimo).
-- ---------------------------------------------------------------------------------------------------------------
revoke all on function
  public.lf_table_of(text), public.lf_invalid(text), public.lf_uuid(text), public.lf_resolve(text),
  public.lf_data_cols(text), public.lf_is_text(text, text), public.lf_doc_json(text, jsonb),
  public.lf_key_where(text, uuid, text, text), public.lf_path_expr(text, text), public.lf_get(text),
  public.lf_apply(jsonb), public.lf_commit(jsonb), public.lf_build_where(text, jsonb),
  public.lf_query(text, text, jsonb), public.lf_count(text, jsonb), public.lf_erase_user(uuid),
  public.lf_literal(text, text, jsonb), public.lf_col_expr(text, text), public.lf_deny_update(),
  public.lf_changed_keys(jsonb, jsonb), public.lf_bump_version(), public.lf_frozen(), public.lf_only(),
  public.lf_grow(), public.lf_guard_transaction(), public.lf_guard_transfer(), public.lf_guard_notification(),
  public.lf_guard_ai_action()
  from public, anon, authenticated;

-- Auxiliares e porta de entrada do usuário autenticado e do backend.
grant execute on function
  public.lf_table_of(text), public.lf_invalid(text), public.lf_uuid(text), public.lf_resolve(text),
  public.lf_data_cols(text), public.lf_is_text(text, text), public.lf_doc_json(text, jsonb),
  public.lf_key_where(text, uuid, text, text), public.lf_path_expr(text, text), public.lf_get(text),
  public.lf_apply(jsonb), public.lf_commit(jsonb), public.lf_build_where(text, jsonb),
  public.lf_query(text, text, jsonb), public.lf_count(text, jsonb), public.lf_changed_keys(jsonb, jsonb),
  public.lf_literal(text, text, jsonb), public.lf_col_expr(text, text)
  to authenticated, service_role;
-- Gatilhos rodam com o papel do chamador e precisam poder chamar lf_changed_keys.
-- A exclusão de conta é EXCLUSIVA do backend.
grant execute on function public.lf_erase_user(uuid) to service_role;
