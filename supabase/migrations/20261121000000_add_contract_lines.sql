-- Cockpit (built for Lumen AI): contract line items under accounts.
-- Adds one table and two nullable columns. No existing rows or numbers change.
-- `npm run contracts:backfill` fills them afterwards.

-- 1. contract_lines: one row per product on a contract (flat; no separate contracts table)
create table if not exists contract_lines (
  id                      text primary key,           -- e.g. ctr_0001-core
  account_id              text not null references accounts (id),
  contract_id             text not null,              -- e.g. ctr_0001 (one contract per account)
  product                 text not null check (product in ('Core', 'Extract', 'Code Review')),
  quantity                integer not null check (quantity > 0),
  unit_price_usd          numeric(12, 2) not null check (unit_price_usd >= 0),
  arr_usd                 numeric(12, 2) not null check (arr_usd >= 0),
  purchase_date           date not null,
  renewal_date            date not null,
  term_months             integer not null check (term_months > 0),
  auto_renew              boolean not null,
  status                  text not null check (status in ('active', 'expired', 'churned')),
  included_tokens_monthly bigint not null check (included_tokens_monthly >= 0),
  constraint contract_lines_account_contract_product_key unique (account_id, contract_id, product)
);
create index if not exists contract_lines_account_id_idx  on contract_lines (account_id);
create index if not exists contract_lines_contract_id_idx on contract_lines (contract_id);

alter table contract_lines enable row level security;
grant select, insert, update, delete on contract_lines to service_role;

-- 2. Daily active users per account, feature, model and day. When a feature
--    uses two models on a day, its users are split between the two rows by
--    tokens, so adding up rows gives the feature's users.
alter table usage_daily add column if not exists active_users integer check (active_users >= 0);

-- 3. Which contract a renewal deal renews. Null for new and expansion deals.
--    No database link to contract_lines (a contract has several lines);
--    `npm run contracts:check` confirms every linked contract exists.
alter table opportunities add column if not exists contract_id text;
create index if not exists opportunities_contract_id_idx on opportunities (contract_id);

-- 4. Tell Supabase's API to pick up the new table and columns straight away.
notify pgrst, 'reload schema';
