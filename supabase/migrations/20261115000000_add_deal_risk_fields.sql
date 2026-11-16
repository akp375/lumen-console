-- Cockpit (built for Lumen AI): deal-risk fields on opportunities.
-- Adds columns only. No existing rows, IDs or other tables change.
-- Columns are nullable so this runs safely on the table as it is today;
-- `npm run seed` then fills them for every deal.

alter table opportunities
  add column if not exists executive_sponsor  text,  -- null = no executive sponsor identified
  add column if not exists stage_entered_date date,  -- when the deal moved into its current stage
  add column if not exists last_activity_date date,  -- most recent call, email or meeting logged
  add column if not exists next_step          text;  -- null = no next step agreed

-- Row Level Security is already on for opportunities and stays on.
