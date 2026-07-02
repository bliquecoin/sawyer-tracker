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

create or replace function public.sawyer_can_access_household(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sawyer_household_members member
    where member.household_id = target_household_id
      and member.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.sawyer_can_access_household(uuid) from public;
grant execute on function public.sawyer_can_access_household(uuid) to authenticated;

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
  using ((select public.sawyer_can_access_household(id)));

drop policy if exists "sawyer members can read household members" on public.sawyer_household_members;
create policy "sawyer members can read household members"
  on public.sawyer_household_members
  for select
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read dogs" on public.sawyer_dogs;
create policy "sawyer members can read dogs"
  on public.sawyer_dogs
  for select
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert dogs" on public.sawyer_dogs;
create policy "sawyer members can insert dogs"
  on public.sawyer_dogs
  for insert
  to authenticated
  with check ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update dogs" on public.sawyer_dogs;
create policy "sawyer members can update dogs"
  on public.sawyer_dogs
  for update
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)))
  with check ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read schedules" on public.sawyer_care_schedules;
create policy "sawyer members can read schedules"
  on public.sawyer_care_schedules
  for select
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert schedules" on public.sawyer_care_schedules;
create policy "sawyer members can insert schedules"
  on public.sawyer_care_schedules
  for insert
  to authenticated
  with check ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update schedules" on public.sawyer_care_schedules;
create policy "sawyer members can update schedules"
  on public.sawyer_care_schedules
  for update
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)))
  with check ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can read events" on public.sawyer_care_events;
create policy "sawyer members can read events"
  on public.sawyer_care_events
  for select
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can insert events" on public.sawyer_care_events;
create policy "sawyer members can insert events"
  on public.sawyer_care_events
  for insert
  to authenticated
  with check ((select public.sawyer_can_access_household(household_id)));

drop policy if exists "sawyer members can update events" on public.sawyer_care_events;
create policy "sawyer members can update events"
  on public.sawyer_care_events
  for update
  to authenticated
  using ((select public.sawyer_can_access_household(household_id)))
  with check ((select public.sawyer_can_access_household(household_id)));

grant usage on schema public to authenticated;
grant select on public.sawyer_households to authenticated;
grant select on public.sawyer_household_members to authenticated;
grant select, insert, update on public.sawyer_dogs to authenticated;
grant select, insert, update on public.sawyer_care_schedules to authenticated;
grant select, insert, update on public.sawyer_care_events to authenticated;;
