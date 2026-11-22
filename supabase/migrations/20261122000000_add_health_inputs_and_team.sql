-- Health-score inputs and ownership for Cockpit (built for Lumen AI).
-- Additive only: new tables and new nullable columns. No existing value changes.
-- The seed / backfill script fills the new columns afterwards.

-- Team: AEs, CSMs, ADRs and managers (fictional people)
create table if not exists team (
  id      text primary key,                 -- e.g. tm_01
  name    text not null unique,
  role    text not null check (role in ('AE', 'CSM', 'ADR', 'CS manager', 'sales manager')),
  segment text not null check (segment in ('enterprise', 'commercial', 'all'))  -- commercial = SMB + mid-market
);
alter table team enable row level security;
grant select, insert, update, delete on team to service_role;

-- Ownership. accounts.owner stays as the AE's name (it matches team.name).
alter table accounts      add column if not exists csm_id text references team (id);  -- null for prospects
alter table opportunities add column if not exists ae_id  text references team (id),  -- the account owner
                          add column if not exists adr_id text references team (id),  -- new deals sourced inbound or outbound only
                          add column if not exists csm_id text references team (id);  -- renewal and expansion deals only
create index if not exists accounts_csm_id_idx     on accounts (csm_id);
create index if not exists opportunities_ae_id_idx on opportunities (ae_id);

-- CSM activities (one row per touch)
create table if not exists cs_activities (
  id             text primary key,          -- e.g. csa_00001
  account_id     text not null references accounts (id),
  csm_id         text not null references team (id),
  activity_date  date not null,
  type           text not null check (type in ('call', 'email', 'meeting', 'QBR', 'exec meeting')),
  attendee_level text not null check (attendee_level in ('executive', 'manager', 'user'))
);
create index if not exists cs_activities_account_date_idx on cs_activities (account_id, activity_date);
alter table cs_activities enable row level security;
grant select, insert, update, delete on cs_activities to service_role;

-- CSAT on tickets (1-5, filled on closed tickets only)
alter table support_tickets add column if not exists csat_score smallint check (csat_score between 1 and 5);

-- Health score: points each category contributed
alter table health_scores
  add column if not exists behavioral_points   numeric(5, 2),
  add column if not exists relationship_points numeric(5, 2),
  add column if not exists feedback_points     numeric(5, 2),
  add column if not exists support_points      numeric(5, 2),
  add column if not exists financial_points    numeric(5, 2);

notify pgrst, 'reload schema';
