-- ADR manager on the team, and saved AI memos in briefings.
-- Additive only: one new team role and one new team row, new nullable columns on briefings.
-- No existing row changes. Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

-- 1. ADR manager (fictional): the person the ADR memo is written for.
alter table team drop constraint if exists team_role_check;
alter table team add constraint team_role_check
  check (role in ('AE', 'CSM', 'ADR', 'ADR manager', 'CS manager', 'sales manager'));
insert into team (id, name, role, segment, territory)
values ('tm_16', 'Nadia Haddad', 'ADR manager', 'all', null)
on conflict (id) do nothing;

-- 2. briefings holds every saved AI write-up: the daily briefing (kind 'daily') and the ADR memo
--    (kind 'adr_memo'). Existing rows become 'daily'.
alter table briefings
  add column if not exists kind       text not null default 'daily' check (kind in ('daily', 'adr_memo')),
  add column if not exists as_of_date date,           -- AS_OF_DATE the summary was computed for
  add column if not exists model      text,           -- the model that answered
  add column if not exists cost_usd   numeric(12, 6) check (cost_usd >= 0),
  add column if not exists input      jsonb,          -- the exact summary sent to Claude
  add column if not exists grounding  jsonb;          -- numbers in the write-up not found in the input
create index if not exists briefings_kind_created_idx on briefings (kind, created_at desc);

-- RLS is already on for team and briefings (no change).
notify pgrst, 'reload schema';
