create schema if not exists private;

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
  );
$$;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on function private.sawyer_can_access_household(uuid) from public, anon;
grant execute on function private.sawyer_can_access_household(uuid) to authenticated;

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

drop function if exists public.sawyer_can_access_household(uuid);;
