-- Pipeline agent: approved actions can be marked as reverted by `npm run agent:reset`.
-- Additive only: one new column and one more allowed outcome. No existing row changes.
-- Run in the Supabase SQL Editor of the Cockpit project (ID starts with htvo).

alter table agent_actions drop constraint if exists agent_actions_outcome_check;
alter table agent_actions add constraint agent_actions_outcome_check check (outcome in ('done', 'failed', 'reverted'));

alter table agent_actions add column if not exists reverted_at timestamptz;
alter table agent_actions drop constraint if exists agent_actions_reverted_check;
alter table agent_actions add constraint agent_actions_reverted_check check ((outcome is not distinct from 'reverted') =(reverted_at is not null));

notify pgrst, 'reload schema';
