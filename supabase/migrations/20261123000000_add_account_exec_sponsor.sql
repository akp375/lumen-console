-- Executive sponsor on accounts, for Cockpit (built for Lumen AI).
-- Additive only: new nullable columns, no existing value changes.
-- Filled for enterprise and mid-market customers only; SMB, prospects and churned accounts stay empty (not tracked).
-- Separate from opportunities.executive_sponsor (the deal-level sponsor), which is unchanged.
alter table accounts
  add column if not exists executive_sponsor_name  text,
  add column if not exists executive_sponsor_title text,
  add column if not exists sponsor_status          text check (sponsor_status in ('active', 'left', 'none')),
  add column if not exists sponsor_left_date       date;  -- only when sponsor_status = 'left'

notify pgrst, 'reload schema';
