-- ADR (account development) data: leads, sequences, Stage 0.1, account tags, ADR-AE pairing.
-- Additive only: new tables and nullable columns, plus Stage 0.1 added to the allowed deal stages.
-- No existing row changes. Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

-- 1. Territories and ADR-AE pairing
alter table team add column if not exists territory text;
create table if not exists adr_ae_pairings (
  adr_id         text not null references team (id),
  ae_id          text not null references team (id),
  territory      text not null,
  effective_from date not null,              -- deals created before this aren't judged against the pairing
  primary key (adr_id, ae_id)
);

-- 2. Account tags
alter table accounts
  add column if not exists icp_tier smallint check (icp_tier in (1, 2, 3)),
  add column if not exists target_account boolean,
  add column if not exists territory text;

-- 3. Leads
create table if not exists leads (
  id                text primary key,
  account_id        text not null references accounts (id),
  contact_name      text not null,
  contact_title     text,
  contact_email     text not null unique,     -- fictional, at <company>.example.com
  lead_source       text not null check (lead_source in ('inbound demo request', 'content download', 'webinar', 'outbound', 'partner', 'event')),
  lifecycle_stage   text not null check (lifecycle_stage in ('lead', 'MQL', 'SQL', 'disqualified')),
  created_at        timestamptz not null,
  mql_at            timestamptz,
  first_touch_at    timestamptz,
  sql_at            timestamptz,
  assigned_adr_id   text references team (id),
  disqualify_reason text,
  opportunity_id    text references opportunities (id)  -- the deal this lead became, if any
);
create index if not exists leads_account_idx on leads (account_id);
create index if not exists leads_adr_idx on leads (assigned_adr_id);

-- 4. Sequences and enrollments
create table if not exists sequences (
  id         text primary key,
  name       text not null,
  audience   text not null,
  step_count integer not null check (step_count > 0),
  owner_id   text not null references team (id),
  created_at date not null
);
create table if not exists sequence_enrollments (
  id                text primary key,
  sequence_id       text not null references sequences (id),
  lead_id           text not null references leads (id),
  adr_id            text references team (id),
  enrolled_at       timestamptz not null,
  finished_at       timestamptz,
  status            text not null check (status in ('active', 'finished', 'replied', 'bounced', 'unsubscribed')),
  emails_sent       integer not null default 0 check (emails_sent >= 0),
  opens             integer not null default 0 check (opens >= 0),
  replies           integer not null default 0 check (replies >= 0),
  bounces           integer not null default 0 check (bounces >= 0),
  meeting_booked    boolean not null default false,
  meeting_booked_at timestamptz
);
create index if not exists sequence_enrollments_lead_idx on sequence_enrollments (lead_id);

-- 5. Stage 0.1 as the first New business stage (existing deals keep their stages)
alter table opportunities drop constraint if exists opportunities_stage_check;
alter table opportunities add constraint opportunities_stage_check
  check (stage in ('Stage 0.1', 'Discovery', 'Demo', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'));

-- 6. Row Level Security on every new table
alter table adr_ae_pairings      enable row level security;
alter table leads                enable row level security;
alter table sequences            enable row level security;
alter table sequence_enrollments enable row level security;
grant select, insert, update, delete on adr_ae_pairings, leads, sequences, sequence_enrollments to service_role;

notify pgrst, 'reload schema';
