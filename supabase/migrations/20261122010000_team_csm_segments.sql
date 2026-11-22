-- CSM coverage by account segment (agreed with the owner, 22 Nov 2026):
-- Aisha Bello = enterprise, Jonas Weber = mid-market, Maya Fernandes and Liam O'Connor = SMB pool.
-- team.segment now also allows 'mid-market' and 'SMB'. AEs and ADRs keep enterprise / commercial.
-- Changes the allowed values only; no rows change here (the backfill updates the four CSMs).
alter table team drop constraint if exists team_segment_check;
alter table team add constraint team_segment_check
  check (segment in ('enterprise', 'mid-market', 'SMB', 'commercial', 'all'));

notify pgrst, 'reload schema';
