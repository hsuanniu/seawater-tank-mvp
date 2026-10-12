create table if not exists public.user_app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_app_state add column if not exists revision bigint not null default 0;

alter table public.user_app_state enable row level security;

drop policy if exists "Users can read own app state" on public.user_app_state;
create policy "Users can read own app state"
on public.user_app_state
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own app state" on public.user_app_state;
create policy "Users can insert own app state"
on public.user_app_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own app state" on public.user_app_state;
create policy "Users can update own app state"
on public.user_app_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Writes go through atomic functions so stale clients cannot bypass revision checks.
revoke insert, update, delete on public.user_app_state from public, anon, authenticated;
grant select on public.user_app_state to authenticated;

create or replace function public.reef_initialize_app_state(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.user_app_state%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or jsonb_typeof(p_data->'tanks') is distinct from 'array' then
    raise exception 'INVALID_STATE';
  end if;
  if jsonb_array_length(p_data->'tanks') = 0 then
    raise exception 'EMPTY_INITIAL_STATE';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_data->'tanks') as t(value)
    where jsonb_typeof(t.value->'id') is distinct from 'string'
       or jsonb_typeof(t.value->'tank') is distinct from 'object'
       or jsonb_typeof(t.value->'records') is distinct from 'array'
  ) then
    raise exception 'INVALID_STATE';
  end if;
  insert into public.user_app_state(user_id, data, revision, updated_at)
    values (v_user_id, p_data, 1, now())
    on conflict (user_id) do nothing
    returning * into v_row;
  if not found then
    raise exception 'CLOUD_ALREADY_INITIALIZED';
  end if;
  return jsonb_build_object('data', v_row.data, 'revision', v_row.revision, 'updated_at', v_row.updated_at);
end;
$$;

create or replace function public.reef_save_app_state(p_data jsonb, p_expected_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.user_app_state%rowtype;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or jsonb_typeof(p_data->'tanks') is distinct from 'array' then
    raise exception 'INVALID_STATE';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_data->'tanks') as t(value)
    where jsonb_typeof(t.value->'id') is distinct from 'string'
       or jsonb_typeof(t.value->'tank') is distinct from 'object'
       or jsonb_typeof(t.value->'records') is distinct from 'array'
  ) then
    raise exception 'INVALID_STATE';
  end if;
  update public.user_app_state
    set data = p_data, revision = revision + 1, updated_at = now()
    where user_id = v_user_id and revision = p_expected_revision
    returning * into v_row;
  if not found then
    raise exception 'CLOUD_REVISION_CONFLICT';
  end if;
  return jsonb_build_object('data', v_row.data, 'revision', v_row.revision, 'updated_at', v_row.updated_at);
end;
$$;

revoke all on function public.reef_initialize_app_state(jsonb) from public, anon;
revoke all on function public.reef_save_app_state(jsonb, bigint) from public, anon;
grant execute on function public.reef_initialize_app_state(jsonb) to authenticated;
grant execute on function public.reef_save_app_state(jsonb, bigint) to authenticated;
