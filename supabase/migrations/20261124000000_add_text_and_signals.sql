-- Free text on tickets and CSM activities, and the topic tags Claude adds to it.
-- Additive only: two new nullable columns and one new table. Nothing existing changes.
-- Run in the Supabase SQL Editor of the Cockpit project (its ID starts with htvo).

-- 1. Short text on each support ticket and each CSM call, meeting, QBR and exec meeting (emails get none)
alter table support_tickets add column if not exists description text;
alter table cs_activities  add column if not exists note text;

-- 2. One tagging result per text (written by `npm run signals:tag`, never twice for the same text)
create table if not exists text_signals (
  id              text primary key,                -- e.g. sig_support_ticket_tkt_00012
  source          text not null check (source in ('support_ticket', 'cs_activity')),
  source_id       text not null,                   -- support_tickets.id or cs_activities.id
  account_id      text not null references accounts (id),
  date            date not null,                   -- when the ticket was opened or the activity happened
  topics          text[] not null default '{}',    -- any of: competitor_mention, switching_intent, pricing_complaint,
                                                   -- implementation_issue, reliability, feature_gap
  competitor_name text,
  sentiment       text not null check (sentiment in ('positive', 'neutral', 'negative')),
  quote           text,                            -- copied word for word from the text; empty if Claude's quote wasn't
  model           text not null,                   -- the Claude model that tagged it
  tagged_at       timestamptz not null default now(),
  unique (source, source_id)                       -- a text can only ever have one result
);
create index if not exists text_signals_account_date_idx on text_signals (account_id, date);
alter table text_signals enable row level security;
grant select, insert, update, delete on text_signals to service_role;

notify pgrst, 'reload schema';
