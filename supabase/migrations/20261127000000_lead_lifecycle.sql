-- New lead lifecycle: New, Engaged, MQL, Sales accepted, Sales qualified, Meeting booked,
-- then Converted, Disqualified or Nurture. Additive only: new nullable columns.
-- Existing columns (lifecycle_stage, mql_at, first_touch_at, sql_at, disqualify_reason) keep their values;
-- `npm run adr:backfill` fills the new ones afterwards.
-- Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

alter table leads
  add column if not exists lead_stage text check (lead_stage in
    ('new', 'engaged', 'mql', 'sales_accepted', 'sales_qualified', 'meeting_booked',
     'converted', 'disqualified', 'nurture')),
  add column if not exists engaged_at         timestamptz,
  add column if not exists sales_accepted_at  timestamptz,
  add column if not exists sales_qualified_at timestamptz,
  add column if not exists meeting_booked_at  timestamptz,  -- the Qualifying deal is created at this point
  add column if not exists converted_at       timestamptz,
  add column if not exists disqualified_at    timestamptz,
  add column if not exists nurtured_at        timestamptz;

-- Stages are reached in order (a stage not reached stays null).
alter table leads drop constraint if exists leads_stage_order_check;
alter table leads add constraint leads_stage_order_check check (
  (engaged_at         is null or engaged_at         >= created_at) and
  (mql_at             is null or engaged_at is null or mql_at >= engaged_at) and
  (sales_accepted_at  is null or sales_accepted_at  >= mql_at) and
  (sales_qualified_at is null or sales_qualified_at >= sales_accepted_at) and
  (meeting_booked_at  is null or sales_qualified_at is null or meeting_booked_at >= sales_qualified_at) and
  (converted_at       is null or converted_at       >= meeting_booked_at)
);
create index if not exists leads_lead_stage_idx on leads (lead_stage);

comment on column leads.lifecycle_stage is 'Legacy (before 23 Nov 2026), kept unchanged. The app uses lead_stage.';
comment on column leads.sql_at is 'Legacy. For leads with a deal it equals meeting_booked_at; for the rest it is the time of the ADR''s qualifying call.';

notify pgrst, 'reload schema';
-- RLS is already on for leads (no change).
