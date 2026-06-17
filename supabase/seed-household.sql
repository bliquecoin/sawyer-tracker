-- Run this after schema.sql.
-- Run this after schema.sql.
-- Replace the two email values with the emails that will sign in on each iPhone.

with created_household as (
  insert into public.sawyer_households (name)
  values ('Sawyer Care')
  returning id
),
members as (
  insert into public.sawyer_household_members (household_id, email, role)
  select id, lower('YOUR_EMAIL@example.com'), 'owner'
  from created_household
  union all
  select id, lower('PARTNER_EMAIL@example.com'), 'member'
  from created_household
  returning household_id
)
select household_id
from members
limit 1;
