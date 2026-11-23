-- Pipeline agent: saved runs, proposed actions and their decisions, and a paused state for sequences.
-- Additive only: new tables and new columns with defaults. No existing row changes meaning.
-- Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

-- 1. Sequences can be paused (every existing sequence starts active)
alter table sequences
  add column if not exists status text not null default 'active' check (status in ('active', 'paused')),
  add column if not exists paused_at timestamptz;

-- 2. One row per agent run
create table if not exists agent_runs (
  id           text primary key default gen_random_uuid()::text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  agent        text not null check (agent in ('pipeline')),
  as_of_date   date not null,
  goal         text not null,
  status       text not null check (status in ('running', 'finished', 'stopped', 'failed')),
  stop_reason  text,                         -- e.g. 'tool_limit', 'cost_limit', 'daily_budget', the error
  model        text,
  tool_calls   jsonb not null default '[]',  -- [{name, input, summary}] in order
  summary      text,
  grounding    jsonb,
  claude_calls integer not null default 0 check (claude_calls >= 0),
  cost_usd     numeric(12, 6) not null default 0 check (cost_usd >= 0)
);
create index if not exists agent_runs_created_idx on agent_runs (agent, created_at desc);

-- 3. One row per proposed action, with its decision
create table if not exists agent_actions (
  id          text primary key default gen_random_uuid()::text,
  run_id      text not null references agent_runs (id),
  created_at  timestamptz not null default now(),
  type        text not null check (type in ('reassign_leads', 'pause_sequence', 'create_hubspot_task')),
  details     jsonb not null,
  reason      text not null,
  status      text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  decided_by  text references team (id),
  decided_at  timestamptz,
  outcome     text check (outcome in ('done', 'failed')),  -- approved actions only
  result      jsonb,                                       -- previous ADR per lead, HubSpot task id, or the error
  check ((status = 'proposed') = (decided_at is null)),
  check ((status = 'proposed') = (decided_by is null)),
  check (outcome is null or status = 'approved')
);
create index if not exists agent_actions_run_idx on agent_actions (run_id);

-- 4. Row Level Security on every new table
alter table agent_runs    enable row level security;
alter table agent_actions enable row level security;
grant select, insert, update on agent_runs, agent_actions to service_role;

notify pgrst, 'reload schema';
