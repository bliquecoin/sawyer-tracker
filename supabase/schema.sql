create extension if not exists pgcrypto;

create table if not exists public.sawyer_households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Sawyer Care',
  created_at timestamptz not null default now()
);

create table if not exists public.sawyer_household_members (
  household_id uuid not null references public.sawyer_households(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (household_id, email),
  constraint sawyer_household_members_email_lowercase check (email = lower(email))
);

create table if not exists public.sawyer_dogs (
  household_id uuid not null references public.sawyer_households(id) on delete cascade,
  id text not null,
  dog_id text not null default 'sawyer',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (household_id, id)
);

create table if not exists public.sawyer_care_schedules (
  household_id uuid not null references public.sawyer_households(id) on delete cascade,
  id text not null,
  dog_id text not null default 'sawyer',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (household_id, id)
);

create table if not exists public.sawyer_care_events (
  household_id uuid not null references public.sawyer_households(id) on delete cascade,
  id text not null,
  dog_id text not null default 'sawyer',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (household_id, id)
);

create index if not exists sawyer_dogs_household_updated_idx
  on public.sawyer_dogs (household_id, updated_at desc);

create index if not exists sawyer_care_schedules_household_updated_idx
  on public.sawyer_care_schedules (household_id, updated_at desc);

create index if not exists sawyer_care_events_household_updated_idx
  on public.sawyer_care_events (household_id, updated_at desc);

create schema if not exists private;

create table if not exists private.sawyer_household_access (
  household_id uuid primary key references public.sawyer_households(id) on delete cascade,
  access_key_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on private.sawyer_household_access from public, anon, authenticated;

create or replace function private.sawyer_request_access_key_hash()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  headers jsonb;
begin
  begin
    headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return null;
  end;

  return nullif(headers ->> 'x-sawyer-access-key', '');
end;
$$;

create or replace function private.sawyer_can_access_household(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select exists (
    select 1
    from public.sawyer_household_members member
    where member.household_id = target_household_id
      and member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  or exists (
    select 1
    from private.sawyer_household_access access
    where access.household_id = target_household_id
      and access.access_key_hash = private.sawyer_request_access_key_hash()
  );
$$;

revoke all on schema private from public;
grant usage on schema private to anon, authenticated;
revoke all on function private.sawyer_request_access_key_hash() from public;
grant execute on function private.sawyer_request_access_key_hash() to anon, authenticated;
revoke all on function private.sawyer_can_access_household(uuid) from public;
grant execute on function private.sawyer_can_access_household(uuid) to anon, authenticated;

alter table public.sawyer_households enable row level security;
alter table public.sawyer_household_members enable row level security;
alter table public.sawyer_dogs enable row level security;
alter table public.sawyer_care_schedules enable row level security;
alter table public.sawyer_care_events enable row level security;

drop policy if exists "sawyer members can read households" on public.sawyer_households;
create policy "sawyer members can read households"
  on public.sawyer_households
  for select
  to authenticated
  using ((select private.sawyer_can_access_household(id)));

drop policy if exists "sawyer members can read household members" on public.sawyer_household_members;
create policy "sawyer members can read household members"
  on public.sawyer_household_members
  for select
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read dogs" on public.sawyer_dogs;
create policy "sawyer members can read dogs"
  on public.sawyer_dogs
  for select
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert dogs" on public.sawyer_dogs;
create policy "sawyer members can insert dogs"
  on public.sawyer_dogs
  for insert
  to authenticated
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update dogs" on public.sawyer_dogs;
create policy "sawyer members can update dogs"
  on public.sawyer_dogs
  for update
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read schedules" on public.sawyer_care_schedules;
create policy "sawyer members can read schedules"
  on public.sawyer_care_schedules
  for select
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert schedules" on public.sawyer_care_schedules;
create policy "sawyer members can insert schedules"
  on public.sawyer_care_schedules
  for insert
  to authenticated
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update schedules" on public.sawyer_care_schedules;
create policy "sawyer members can update schedules"
  on public.sawyer_care_schedules
  for update
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read events" on public.sawyer_care_events;
create policy "sawyer members can read events"
  on public.sawyer_care_events
  for select
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert events" on public.sawyer_care_events;
create policy "sawyer members can insert events"
  on public.sawyer_care_events
  for insert
  to authenticated
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update events" on public.sawyer_care_events;
create policy "sawyer members can update events"
  on public.sawyer_care_events
  for update
  to authenticated
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));

grant usage on schema public to authenticated;
grant select on public.sawyer_households to authenticated;
grant select on public.sawyer_household_members to authenticated;
grant select, insert, update on public.sawyer_dogs to authenticated;
grant select, insert, update on public.sawyer_care_schedules to authenticated;
grant select, insert, update on public.sawyer_care_events to authenticated;

grant usage on schema public to anon;
grant select on public.sawyer_households to anon;
grant select, insert, update on public.sawyer_dogs to anon;
grant select, insert, update on public.sawyer_care_schedules to anon;
grant select, insert, update on public.sawyer_care_events to anon;

drop policy if exists "sawyer access key can read households" on public.sawyer_households;
create policy "sawyer access key can read households"
  on public.sawyer_households
  for select
  to anon
  using ((select private.sawyer_can_access_household(id)));

drop policy if exists "sawyer access key can read dogs" on public.sawyer_dogs;
create policy "sawyer access key can read dogs"
  on public.sawyer_dogs
  for select
  to anon
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can insert dogs" on public.sawyer_dogs;
create policy "sawyer access key can insert dogs"
  on public.sawyer_dogs
  for insert
  to anon
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can update dogs" on public.sawyer_dogs;
create policy "sawyer access key can update dogs"
  on public.sawyer_dogs
  for update
  to anon
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can read schedules" on public.sawyer_care_schedules;
create policy "sawyer access key can read schedules"
  on public.sawyer_care_schedules
  for select
  to anon
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can insert schedules" on public.sawyer_care_schedules;
create policy "sawyer access key can insert schedules"
  on public.sawyer_care_schedules
  for insert
  to anon
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can update schedules" on public.sawyer_care_schedules;
create policy "sawyer access key can update schedules"
  on public.sawyer_care_schedules
  for update
  to anon
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can read events" on public.sawyer_care_events;
create policy "sawyer access key can read events"
  on public.sawyer_care_events
  for select
  to anon
  using ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can insert events" on public.sawyer_care_events;
create policy "sawyer access key can insert events"
  on public.sawyer_care_events
  for insert
  to anon
  with check ((select private.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer access key can update events" on public.sawyer_care_events;
create policy "sawyer access key can update events"
  on public.sawyer_care_events
  for update
  to anon
  using ((select private.sawyer_can_access_household(household_id)))
  with check ((select private.sawyer_can_access_household(household_id)));
