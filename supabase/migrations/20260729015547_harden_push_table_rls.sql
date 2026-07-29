drop policy if exists "push subscriptions are server managed" on public.sawyer_push_subscriptions;
create policy "push subscriptions are server managed"
  on public.sawyer_push_subscriptions
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "push deliveries are server managed" on public.sawyer_push_deliveries;
create policy "push deliveries are server managed"
  on public.sawyer_push_deliveries
  for all
  to anon, authenticated
  using (false)
  with check (false);
