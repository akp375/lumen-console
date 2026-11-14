-- Lumen Console: core data model (11 tables).
-- Table and column names follow the project's Data model reference exactly.
-- Row Level Security is on for every table. No access policies are added, so
-- the public (anon) key can read nothing; server-side code uses the service
-- role key, which bypasses RLS.

-- 1. accounts: one row per company (prospect, customer or churned customer)
create table accounts (
  id                      text primary key,
  name                    text not null unique,
  status                  text not null check (status in ('prospect', 'customer', 'churned')),
  segment                 text not null check (segment in ('SMB', 'mid-market', 'enterprise')),
  -- plan, seats, start_date and renewal_date are empty for prospects;
  -- renewal_date is also empty for churned accounts.
  plan                    text,
  seats                   integer check (seats > 0),
  mrr_usd                 numeric(12, 2) not null check (mrr_usd >= 0),
  included_tokens_monthly bigint not null check (included_tokens_monthly >= 0),
  start_date              date,
  renewal_date            date,
  churn_date              date,
  owner                   text not null,
  -- Customers must have a plan, seats, start date and renewal date.
  constraint customer_has_contract check (
    status <> 'customer'
    or (plan is not null and seats is not null and start_date is not null and renewal_date is not null)
  ),
  -- churn_date is filled in for churned accounts and only for them.
  constraint churn_date_matches_status check ((status = 'churned') = (churn_date is not null))
);

-- 2. opportunities: one row per deal
create table opportunities (
  id                text primary key,
  account_id        text not null references accounts (id),
  type              text not null check (type in ('new', 'expansion', 'renewal')),
  source            text not null check (source in ('inbound', 'outbound', 'partner', 'existing customer')),
  stage             text not null check (stage in ('Discovery', 'Demo', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost')),
  forecast_category text not null check (forecast_category in ('Pipeline', 'Best Case', 'Commit', 'Closed', 'Omitted')),
  amount_usd        numeric(12, 2) not null check (amount_usd >= 0),
  created_date      date not null,
  close_date        date not null,
  probability       integer not null check (probability between 0 and 100)
);
create index opportunities_account_id_idx on opportunities (account_id);

-- 3. invoices: one row per account per month (month = first day of the month)
create table invoices (
  account_id text not null references accounts (id),
  month      date not null,
  amount_usd numeric(12, 2) not null check (amount_usd >= 0),
  status     text not null check (status in ('paid', 'open', 'overdue')),
  primary key (account_id, month)
);

-- 4. usage_daily: one row per account per day per feature per model
create table usage_daily (
  account_id    text not null references accounts (id),
  date          date not null,
  feature       text not null,
  model         text not null,
  requests      integer not null check (requests >= 0),
  input_tokens  bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  primary key (account_id, date, feature, model)
);

-- 5. model_prices: one row per model
create table model_prices (
  model                   text primary key,
  provider                text not null,
  input_usd_per_million   numeric(10, 4) not null check (input_usd_per_million >= 0),
  output_usd_per_million  numeric(10, 4) not null check (output_usd_per_million >= 0),
  as_of                   date not null
);

-- 6. support_tickets: one row per ticket
create table support_tickets (
  id         text primary key,
  account_id text not null references accounts (id),
  opened_at  timestamptz not null,
  closed_at  timestamptz,
  severity   text not null check (severity in ('low', 'medium', 'high', 'urgent')),
  status     text not null check (status in ('open', 'pending', 'closed'))
);
create index support_tickets_account_id_idx on support_tickets (account_id);

-- 7. nps_responses: one row per survey response
create table nps_responses (
  id           text primary key,
  account_id   text not null references accounts (id),
  responded_at timestamptz not null,
  score        integer not null check (score between 0 and 10),
  comment      text
);
create index nps_responses_account_id_idx on nps_responses (account_id);

-- 8. health_scores: one row per account per week (filled by the app, not the seed)
create table health_scores (
  account_id    text not null references accounts (id),
  week_start    date not null,
  score         numeric(5, 2) not null check (score between 0 and 100),
  usage_trend   numeric,
  capacity_used numeric,
  support_load  numeric,
  sentiment     numeric,
  primary key (account_id, week_start)
);

-- 9. expansion_plays: one row per drafted play (filled by the app, not the seed)
create table expansion_plays (
  id          text primary key default gen_random_uuid()::text,
  account_id  text not null references accounts (id),
  created_at  timestamptz not null default now(),
  why_now     text,
  offer       text,
  email_draft text,
  follow_up   text,
  status      text
);
create index expansion_plays_account_id_idx on expansion_plays (account_id);

-- 10. briefings: one row per daily briefing (filled by the app, not the seed)
create table briefings (
  id               text primary key default gen_random_uuid()::text,
  created_at       timestamptz not null default now(),
  content          text not null,
  -- List of account ids the briefing flagged.
  accounts_flagged text[] not null default '{}'
);

-- 11. llm_calls: one row per Claude API call the app makes (filled by the Claude wrapper)
create table llm_calls (
  id            text primary key default gen_random_uuid()::text,
  feature       text not null,
  model         text not null,
  input_tokens  integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  cost_usd      numeric(12, 6) not null check (cost_usd >= 0),
  latency_ms    integer not null check (latency_ms >= 0),
  created_at    timestamptz not null default now()
);

-- Row Level Security on for every table.
alter table accounts        enable row level security;
alter table opportunities   enable row level security;
alter table invoices        enable row level security;
alter table usage_daily     enable row level security;
alter table model_prices    enable row level security;
alter table support_tickets enable row level security;
alter table nps_responses   enable row level security;
alter table health_scores   enable row level security;
alter table expansion_plays enable row level security;
alter table briefings       enable row level security;
alter table llm_calls       enable row level security;

-- Make sure server-side code (service role) can read and write these tables.
grant select, insert, update, delete on
  accounts, opportunities, invoices, usage_daily, model_prices, support_tickets,
  nps_responses, health_scores, expansion_plays, briefings, llm_calls
  to service_role;
