-- Clicks on sequence emails, so email metrics can be reported per email sent (open, click-through,
-- reply and bounce rates). Additive only: one new column with a default of 0.
-- `npm run adr:backfill` fills it afterwards (and re-seeds sequence engagement; meetings booked stay as they are).
-- Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

alter table sequence_enrollments
  add column if not exists clicks integer not null default 0 check (clicks >= 0);

-- A click needs an opened email.
alter table sequence_enrollments drop constraint if exists sequence_enrollments_clicks_le_opens;
alter table sequence_enrollments add constraint sequence_enrollments_clicks_le_opens check (clicks <= opens);

notify pgrst, 'reload schema';
-- RLS is already on for sequence_enrollments (no change).
