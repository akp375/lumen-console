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

## 2026-11-14 (Saturday)

## Highlights

### 1. Business metrics module (`src/lib/metrics.ts`)

**The challenge.** Every screen and the Ask RevOps agent need the same numbers, calculated the same way, from one place. Each metric needed a written definition the owner agreed to before any code was written.

**How we solved it.**

1. **Agreed every definition in plain English first** (listed below).
2. **Split the code into two layers.**
   - *Calculators* are pure math on lists of rows, with "today" passed in.
   - *Loaders* read Supabase on the server with the service-role key and pass the rows to the calculators.

   The tests can check the math without a database.
3. **Read data in pages of 1,000 rows.** Supabase returns at most 1,000 rows per request, and the 30-day usage window has about 13,000 rows. Without paging, totals would come out quietly wrong.
4. **Wrote 17 tests against a tiny hand-made dataset** (`src/lib/metrics.test.ts`). Every expected answer has its hand calculation next to it. Run them with `npm test`, which uses Node's built-in test runner, so there are no new packages.
5. **Checked against the live data (read-only).** ARR, win rate, underwater count and over-capacity count all matched the seed's own self-check exactly.

**Lessons.**

- Boundaries get their own tests. Exactly 30% margin is *not* underwater, exactly 100% capacity is *not* overage, and a deal closed exactly 6 months ago is outside the window.
- If usage mentions a model with no price, the code stops with an error instead of counting it as $0.
- Running against Supabase from Claude's sandbox needs `NODE_USE_ENV_PROXY=1`. The app on Vercel and `npm run seed` in your own Terminal don't.

## Metric definitions (agreed by the owner)

"Today" = `AS_OF_DATE`. "Customer" = status `customer`. "Open deal" = Discovery, Demo, Proposal or Negotiation.

1. **ARR.** Per customer: MRR × 12. Total = the sum over customers.
2. **Pipeline.** Open deals only, from any account. Weighted value = amount × probability ÷ 100.
   - Shown by stage, source, deal type and forecast category, each with count, value and weighted value.
   - Also split into **growth** (new + expansion) and **renewal**, because renewals protect revenue we already have rather than adding new revenue.
3. **Win rate and sales cycle.** Deals closed after today − 6 months, up to today.
   - Win rate = won ÷ (won + lost), counted by number of deals. It's shown overall and per deal type.
   - Sales cycle = the average of (close date − created date) in days, over won deals only.
4. **30-day token cost.** The window is the 30 days before today; today itself is left out. Cost = input tokens ÷ 1M × input price + output tokens ÷ 1M × output price, using `model_prices`.
5. **Gross margin.** (MRR − 30-day token cost) ÷ MRR. **Underwater** = strictly below 30%.
6. **Capacity used.** 30-day (input + output) tokens ÷ included monthly tokens. **Overage** = strictly above 100%.
7. **NRR, last 90 days.** There's no daily MRR history, so monthly invoices are the MRR record.
   - **Starting group:** accounts that were customers on today − 90 days, including those that have churned since. Customers who joined later are left out.
   - **Starting MRR** = each account's latest invoice in or before the start month.
   - **Ending MRR** = its invoice for the current month, or $0 if it has churned.
   - **NRR** = (starting + upgrades − downgrades − churned) ÷ starting.
8. **Account economics.** Token cost, margin and capacity together, one row per customer, reading usage only once.

## Live results (as of 2026-11-13)

| Metric | Value |
|---|---|
| ARR | $3,069,960 (150 customers; top 10 = 35%) |
| Open pipeline | 60 deals, $1,261,900 ($401,446 weighted) |
| Growth pipeline | 38 deals, $696,100 ($193,930 weighted) |
| Renewal pipeline | 22 deals, $565,800 ($207,516 weighted) |
| Win rate, 6 months | 27.5% overall (new 18.2%, expansion 40.0%, renewal 37.5%) |
| Average sales cycle | 49.2 days (new 54.4, expansion 46.5, renewal 46.0) |
| Token cost, 30 days | $96,494; margin after token costs 62.3% |
| Underwater / overage | 12 / 15 (no account is both) |
| NRR, 90 days | 96.8% (start $264,258 + $1,932 up − $3,970 down − $6,390 churn) |

## Things worth noting (for the owner)

- **The largest customer barely makes money.** Copperleaf Labs (#1, $162K ARR) runs at 2.6% margin, and Harborview Analytics (#5) at 11%.
- **7 customers cost more in tokens than they pay.** The 12 underwater accounts bring in about 14% of ARR but use about 35% of token spend.
- **The margin problem is pricing, not overuse.** No underwater account is over its allowance, which points to plan design.
- **Overage usage is unbilled.** The 15 over-capacity accounts are profitable, but invoices always equal MRR, so the extra usage isn't charged. It's either upsell or revenue leakage, and the expansion pipeline is only $105K.
- **NRR has slipped.** 90-day NRR is 96.8%, against a 12-month figure of 108.2%. No customer joined in the last 90 days.
- **The renewal win rate (37.5%) is a data gap, not a real renewal rate.** Only 16 renewals closed through a deal in 6 months. Contracts renew yearly, so roughly half of 150 customers would have come up for renewal in that time. Most renewals have no deal record, so this number understates retention.
- **The partner channel has no open deals.**

## Other work today

- Added `npm test` (Node's built-in test runner; no new packages).
