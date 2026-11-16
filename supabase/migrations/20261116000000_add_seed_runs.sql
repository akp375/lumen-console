-- Cockpit (built for Lumen AI): one row each time `npm run seed` finishes,
-- so the Integrations page can show when the demo data was last loaded.
create table if not exists seed_runs (
  id         text primary key default gen_random_uuid()::text,
  seeded_at  timestamptz not null default now(),
  as_of_date date not null
);

alter table seed_runs enable row level security;
grant select, insert on seed_runs to service_role;
