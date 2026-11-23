-- SUPERSEDED (24 Nov 2026): don't run this file. It was never run in the Cockpit project; use
-- 20261129000000_sync_runs.sql instead, which adds status, source, created counts and failures.
--
-- Cockpit (built for Lumen AI): one row each time `npm run hubspot:sync` finishes
-- (dry runs are not recorded), so the Integrations page can show when HubSpot
-- was last synced and how many records were sent.
create table if not exists sync_runs (
  id         text primary key default gen_random_uuid()::text,
  target     text not null default 'hubspot',
  scope      text not null check (scope in ('full', 'one')), -- 'one' = the --one test run
  synced_at  timestamptz not null default now(),
  companies  integer not null,
  deals      integer not null,
  contacts   integer not null
);

alter table sync_runs enable row level security;
grant select, insert on sync_runs to service_role;
