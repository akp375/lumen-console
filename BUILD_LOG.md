# Build Log: Lumen Console

## 2026-11-13 (Friday)

## Highlights

### 1. Getting past the GitHub login

**The challenge.** The project was ready on this Mac, but the first `git push` to GitHub (`akp375/lumen-console`) needed us to sign in from the command line. GitHub no longer accepts an account password for `git push`, so typing the normal GitHub password fails even when it is correct.

**How we solved it.**

1. **Generated a personal access token** inside the GitHub account settings.
2. **Saved the token in Passwords** (the Mac password manager), so it is stored safely and never sits in a project file or chat.
3. **Connected through the Terminal:** when `git push` asked for a password, we pasted the token instead of the GitHub password.
4. Git on this Mac stores that sign-in in the **macOS Keychain** (`osxkeychain`), so later pushes go through without asking again.
5. Both pushes worked. `main` and `dev` are on GitHub, and each local branch is linked to its GitHub copy.

**Lesson.** If a push ever asks for a password again, the token has probably expired or been revoked. Make a new token on GitHub and enter it when asked. Never paste the token into chat or into a project file.

### 2. Setting up and seeding Supabase

**The challenge.** Lumen Console needs a realistic, repeatable demo dataset in the live Supabase database. The data had to hit specific targets: 150 customers, about $3M ARR, 90 days of usage, planted at-risk accounts and a believable pipeline. It also had to be identical every time it is loaded, and get there without new installs or exposing any secret keys.

**How we solved it.**

1. **Planned before building.** We agreed the data model, then made changes before any code was written: prospects and churned accounts, revenue movement for NRR, the deal stages and forecast categories, and stable record IDs.
2. **Created the tables by hand in Supabase.** We pasted the migration file (`supabase/migrations/20261113000000_create_core_tables.sql`) into Supabase's **SQL Editor** and clicked **Run**. Doing it automatically would have needed either Supabase's command-line tool (a new install) or the database password (a new secret). For a one-time setup, pasting by hand was simpler and safer.
3. **Previewed the data before writing it.** `npm run seed -- --dry-run` builds all the data and prints a self-check without touching the database. One finding: NRR came out at 99.8%, too low for a growing startup, so we added realistic seat growth and it landed at 108.2%.
4. **Caught a key-name mismatch before it failed.** We checked `.env.local` for names only, with no values shown. The seed expected `NEXT_PUBLIC_SUPABASE_URL`, but the file uses `SUPABASE_URL`, so the seed would have stopped with a "missing" error. We changed the seed to read `SUPABASE_URL`, which also keeps everything server-side.
5. **Ran the seed from the Terminal** with `npm run seed`. The script reads the project address (`SUPABASE_URL`) and the server-side key (`SUPABASE_SERVICE_ROLE_KEY`) from `.env.local` and sends the data to Supabase over the internet.
6. **It worked first time.** Every table was written without errors:
   - 190 accounts
   - 3 model prices
   - 140 opportunities
   - 1,901 invoices
   - 38,394 usage rows
   - 957 support tickets
   - 173 NPS responses

   The data fingerprint was `4cecab8bbd52`, the same as the dry run, which proves the database holds exactly the data we tested.

**Lessons.**

- The order matters: first run the SQL (it creates the tables), then the seed (it fills them).
- Run the dry run first, and check that its fingerprint matches the real run.
- Check `.env.local` variable *names* against what the code expects before running anything. Never print the values.
- If migrations become frequent, consider adding the Supabase command-line tool to this project (not system-wide) so `npx supabase db push` applies them automatically.

## Other work today

- **Project set up** (`a841d60`): new Next.js app with Supabase, the Anthropic SDK and Recharts. This first commit went to `main`.
- **`dev` branch created**: all work from here on happens on `dev`.
- **Safety rules added** (`d3e31c4`): `CLAUDE.md` now covers no `sudo`, no deleting files, no global installs, staying inside the project folder, keeping `.env.local` private and protecting `main`.
- **Rebranded** (`ede1ece`): the app header and browser tab title now say "Lumen Console".
- **Product brief added to `CLAUDE.md`** (`aaffcf2`): it covers the product, the demo company (Lumen AI), the three modules, the stack, the build rules and the working style. The safety rules stay in place.
- **Started this build log** (`aaffcf2`).
- **Data model, seed script and as-of date committed** (`b6f944f`).

## What we set up

- **Supabase database:** 11 tables (`accounts`, `opportunities`, `invoices`, `usage_daily`, `model_prices`, `support_tickets`, `nps_responses`, `health_scores`, `expansion_plays`, `briefings`, `llm_calls`), created by `supabase/migrations/20261113000000_create_core_tables.sql`.
- **Demo data:** loaded by `scripts/seed.ts` (`npm run seed`). It fills 7 tables. `health_scores`, `expansion_plays`, `briefings` and `llm_calls` start empty, because the app fills them later.
- **Row Level Security (RLS):** turned on for all 11 tables in the migration, with no access policies. The app reads data only through its own server, using the service-role key, which is allowed past RLS. Nobody can read through the public key.
  - **Checked from the project:** the server key reads every table, with row counts matching the seed exactly.
  - **The public key was rejected outright** (`401 Unauthorized`) on every table. So it can't read anything, but that result doesn't by itself prove RLS is on. The SQL check in Supabase's SQL Editor confirms RLS for each table.
- **As-of date setting:** `src/lib/as-of-date.ts`.
- **`.env.local` names the code expects:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Only the names were checked, never the values.

## Data design decisions (made by the owner)

1. **Account status with prospects and churned customers.** `accounts` has a `status` of `prospect`, `customer` or `churned`, plus a `churn_date`.
   - **Why:**
     - It maps cleanly to HubSpot's lifecycle stage and Salesforce's account type.
     - New-business deals need a prospect to belong to.
     - Net revenue retention (NRR) is only honest if churned customers stay in the data.
   - **Result:**
     - 150 customers, 30 prospects (no revenue, usage or invoices), and 10 accounts that churned in the last 6 months. Their invoices and usage stop at churn.
     - Open and lost "new" deals belong to prospects; won "new" deals belong to the newest customers.
     - Rule in `CLAUDE.md`: customer metrics count `customer` accounts only, unless a metric such as NRR needs churned accounts.
2. **Separate stage and forecast category on every deal.**
   - **Stage** says where the deal is in the sales process: Discovery, Demo, Proposal, Negotiation, Closed Won or Closed Lost. Probability follows the stage: Discovery 10%, Demo 25%, Proposal 50%, Negotiation 70%, Closed Won 100% and Closed Lost 0%.
   - **Forecast category** says how it counts in the forecast:
     - Pipeline (Discovery and Demo)
     - Best Case (Proposal)
     - Commit (Negotiation)
     - Closed (Closed Won)
     - Omitted (Closed Lost)
   - **Why:** this matches how Salesforce and HubSpot forecasting works, and it lets the forecast be read separately from stage.
   - **Rule in `CLAUDE.md`:** pipeline metrics count open deals only.
3. **A fixed as-of date.** "Today" is 2026-11-13, set once in `src/lib/as-of-date.ts`.
   - **Why:** the numbers never drift as real days pass.
   - **How to move the data forward:** change that one value and re-run the seed.
   - **Rule in `CLAUDE.md`:** metrics use this date, never the real clock.
4. **Deterministic IDs and data.** IDs are fixed: `acc_0001`–`acc_0190`, `opp_0001`–`opp_0140`, `tkt_00001…` and `nps_00001…`, and the random seed is fixed.
   - **Why:** every run produces identical data, and the fingerprint (`4cecab8bbd52`) proves it.
   - **Re-seeds:** a re-seed updates accounts in place and never deletes them, so health scores and expansion plays the app creates stay linked to the same accounts.

## Data model and demo data: details

- **Other data model choices:**
  - `nps_responses`, `expansion_plays`, `briefings` and `llm_calls` got an `id` column.
  - Every deal has a `created_date`.
- **Demo data, as reported by the seed's self-check:**
  - 150 customers, 30 prospects and 10 accounts that churned in the last 6 months.
  - About $3.07M ARR, with the top 10 customers making up 35% of it.
  - 90 days of usage.
  - 12 accounts whose token cost is more than 70% of their revenue, 15 with usage down more than 20%, and 15 over their included tokens.
  - 60 open deals, and 80 closed deals from the last 6 months with a 27.5% win rate.
  - 12-month net revenue retention (NRR) of 108.2% and gross revenue retention (GRR) of 92.7%.
- **New rules added to `CLAUDE.md`:**
  - Metrics use the as-of date, not the real clock.
  - Pipeline metrics count open deals only.
  - Customer metrics count accounts with status `customer` only, unless a metric such as NRR needs churned accounts.
