-- HubSpot sync runs: one row each time a sync finishes or fails (dry runs aren't recorded), so the
-- Integrations page can show the last run's time and counts. Replaces the parked
-- 20261120000000_add_sync_runs.sql, which was never run in this project (don't run that one).
-- Additive only: a new table. Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

create table if not exists sync_runs (
  id                text primary key default gen_random_uuid()::text,
  target            text not null default 'hubspot',
  scope             text not null check (scope in ('full', 'one')),  -- 'one' = a single account (--one, --account)
  account_id        text,                                            -- the account, for scope 'one'
  source            text not null check (source in ('button', 'cli')),
  status            text not null check (status in ('success', 'failed')),
  started_at        timestamptz not null,
  finished_at       timestamptz not null default now(),
  companies_synced  integer not null default 0,
  companies_created integer not null default 0,
  deals_synced      integer not null default 0,
  deals_created     integer not null default 0,
  contacts_synced   integer not null default 0,
  contacts_created  integer not null default 0,
  deals_left_out    integer not null default 0,                      -- Qualifying deals, which aren't in HubSpot's pipelines
  error             text                                             -- for failed runs
);
create index if not exists sync_runs_finished_idx on sync_runs (target, finished_at desc);

alter table sync_runs enable row level security;
grant select, insert on sync_runs to service_role;

notify pgrst, 'reload schema';
