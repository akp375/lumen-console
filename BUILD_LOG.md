# Build Log: Cockpit (built for Lumen AI)

> The app was called "Lumen Console" until 2026-11-14, when it was renamed **Cockpit** so it is not confused with the client, Lumen AI. Older entries below keep the old name as history. The code folder, GitHub repo and package are still named `lumen-console`.

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

### 2. Renewal data fix (re-seed)

**The challenge.** The renewal win rate was 37.5% (6 won, 10 lost), which looked like Lumen loses most renewals. In fact, 73 customers renewed in the last 6 months and 10 churned. The seed recorded a deal for every lost renewal but only 6 of the 73 wins.

**How we solved it.**

1. **Found it** in the live check of win rate by deal type, then confirmed it in the seed code: it deliberately created exactly 6 won renewal deals.
2. **Added a Closed Won renewal deal for the other 67 renewals** in `scripts/seed.ts`. Each is dated just before the customer's renewal date, with the amount equal to the ARR the customer was paying at that time.
   - **No price changes**, so invoices and MRR stay exactly the same.
   - **Own random stream, added last**, so the existing deals `opp_0001`–`opp_0140` keep their ids and values. The new ones are `opp_0141`–`opp_0207`.
3. **Took a fingerprint of the live metrics before and after** the re-seed. Account economics for all 150 customers, ARR, pipeline and NRR came out identical. Only win rate changed, as intended.
4. **Ran the dry run first, then the re-seed.** New data fingerprint: `08eda9901247`.

| Win rate (last 6 months) | Before | After |
|---|---|---|
| Renewal | 37.5% (6 / 16) | **88.0% (73 / 83)** |
| Overall | 27.5% (22 / 80) | **60.5% (89 / 147)** |
| New | 18.2% | 18.2% (no change) |
| Expansion | 40.0% | 40.0% (no change) |
| Avg sales cycle, won deals | 49.2 days | 46.2 days |

**Lessons.**

- A win rate that mixes deal types can hide a data gap. Always look at it by type.
- Renewals only show up in metrics if a renewal deal is recorded every time. In HubSpot or Salesforce, make a renewal deal for every contract, not only the ones at risk.
- Before a re-seed, fingerprint the metrics you care about, then compare afterwards.
- Renewals older than 6 months still have no deal. No metric looks back that far today.

The live results table in section 1 shows the figures from before this fix. Overall win rate is now 60.5%, and the renewal data-gap note there is resolved.

## 2026-11-15 to 2026-11-18

- **Risk pages (Renewals, Deal Risk).** Rules in `src/lib/metrics.ts` flag at-risk renewals (for example falling NPS or usage) and deals (for example stuck in stage, no activity for 21+ days, no executive sponsor). Claude then writes a reason and next step for each flagged row. Decision: each page first shows the top 10 renewals or deals for this quarter and next. Claude only runs when you click Flag, so you pay only when you ask.
- **Workspace.** A chat page for questions about the business. Decision: Claude answers only from a snapshot of Cockpit's own figures, sent with each question, so its answers match the dashboard. The conversation is kept only in the page and is gone after a refresh.
- **Cost guardrails.** Claude is limited to $2 a day, counted from `llm_calls`, and each reply is capped at 4,000 tokens (down from 16,000). Workspace sends the last 6 messages, allows 1,000-character questions and 20 questions per browser per hour, and gives up after 30 seconds. What broke: the Flag buttons could be clicked again while Claude was writing, which started extra paid calls. They now stay locked until the answer arrives.
- **Polish.** Every page now has the same header and number formats: $1.2M on cards, full figures in tables, one-decimal percentages. Tables sort, and loading shows placeholders and spinners. A new Integrations page shows Supabase, today's Claude spend, and HubSpot and Salesforce as planned.

## 2026-11-19 (Thursday)

## Highlights

### 1. Connecting to HubSpot with a project-based app

**The challenge.** Cockpit will later sync account and deal data into HubSpot, and agents will write notes and tasks there. That needs an access token for the HubSpot developer test account. HubSpot no longer lets you create "legacy private apps", so the old way of getting a token is gone.

**How we solved it.**

1. **Read HubSpot's current developer docs first** (developer platform 2025.2) instead of relying on memory.
2. **Defined the app as a small project in the repo**, in `hubspot/app/`. Its settings file (`src/app/app-hsmeta.json`) lists the scopes: read and write for companies, contacts and deals, plus their property schemas. Keeping it in git means the app's permissions are recorded and reviewable.
3. **Chose a static token.** The app uses "static" auth and "private" distribution, so it installs into one account and gives one token. There is no sign-in flow to build.
4. **The owner ran the HubSpot steps.** They signed the CLI in with a personal access key, uploaded the project, installed it in the test account and pasted the token into `.env.local` as `HUBSPOT_ACCESS_TOKEN`. The token never went into chat. The CLI runs through `npx`, with nothing installed globally.
5. **Wrote the guide down** in `hubspot/README.md`, so ops leads can repeat it.
6. **Tested the connection** with `npm run hubspot:test`. HubSpot accepted the token, and the test account (248054539) has no companies yet.

**Lessons.**

- The CLI keeps its sign-in key in the home folder (`~/.hscli/config.yml`), not in the project, so it can't be committed by accident.
- HubSpot's scope list has no separate notes or tasks scope. They are expected to be covered by the company, contact and deal scopes. ~~Test one note and one task before relying on this.~~ **Resolved 20 Nov:** one note and one task were created and attached with the existing scopes (see 20 Nov).
- To change scopes later: edit `app-hsmeta.json`, upload again, and reinstall from the app's Distribution tab.

### 2. Creating the Lumen Console properties by script

**The challenge.** Cockpit's numbers need fields to land in on HubSpot companies and deals. The fields had to be created repeatably, without duplicates, and without touching anything already in the account.

**How we solved it.**

1. **Listed every property in one file**, `hubspot/properties.json`, all in a property group called **Lumen Console**:
   - Company: ARR, Renewal date, Gross margin, Capacity used, Latest NPS, NPS change, Health score, Renewal risk (Low / Medium / High)
   - Deal: Executive sponsor, Days in stage, Deal risk (None / Amber / Red)
2. **Wrote `npm run hubspot:setup`.** It creates the group and any missing properties, skips ones that exist, and never changes or deletes a property. It uses Node's built-in `fetch`, so there are no new packages.
3. **Ran a dry run first.** `npm run hubspot:setup -- --dry-run` showed that the three properties the owner had made by hand were not in this account. They had been made in a different account, which we left alone.
4. **Reused HubSpot's built-in "Next Renewal Date"** (`hs_next_renewal_date`) for Renewal date instead of creating a duplicate. Built-in properties are marked `"builtIn": true` in `properties.json` and stay in HubSpot's own group.
5. **Created the other 10** as `lumen_` properties, such as `lumen_arr` and `lumen_deal_risk`. A second dry run skipped all 11 with no warnings, so the script is safe to run again.

**Lessons.**

- Always do a dry run against the real account. It showed the hand-made properties were in another account before anything was created.
- Reuse a HubSpot built-in property where one exists. Duplicates confuse reports and anyone syncing to HubSpot later.

### 3. Percent decision: send 0.42, not 42

**The challenge.** The plan was to send 42 to HubSpot for 42%. HubSpot's help centre says percentage properties are stored as decimals, so 42 would display as **4200%**.

**Decision (owner).** Send our fractions unchanged, for example a 42% gross margin goes as `0.42`. Cockpit already stores percentages that way. Before the full data sync, push **one record** and confirm HubSpot shows "42%", not "4200%" or "0.42%".

## Other work today

- **Integrations page:** the Anthropic Claude card now shows **Spend to date** and **Calls to date** across all of `llm_calls`, on the real clock. Supabase returns 1,000 rows at a time, so the total reads in pages.
- **GitHub:** the default branch is `dev`, so work on `dev` counts on GitHub without merging into `main`. This is now a rule in `CLAUDE.md`.

### 4. Security and cost audit

**The challenge.** Before going further, check that secrets stay server-side, the AI budget can't be bypassed, the database is locked down and nothing secret has ever been committed.

**What passed (read-only checks).**

- **Secrets:** `.env.local` holds `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` and `HUBSPOT_ACCESS_TOKEN`. None uses `NEXT_PUBLIC_`, and each is read only in server code or scripts. `SUPABASE_ANON_KEY` is not used.
- **Database:** Row Level Security is on for all 12 tables. The public (anon) key gets "permission denied" on every table.
- **Git history:** no `.env` file and no API key, token or HubSpot CLI config has ever been committed.
- **Budget and Workspace limits:** the $2 daily budget, the 4,000-token reply cap, 6 messages of history, 1,000-character questions, 20 questions per hour and the 30-second timeout are all in place.

**What we fixed.**

1. **Dev server listened on the whole network.** `npm run dev` showed a Wi-Fi address (`192.168.1.117:3000`), so anyone on the same Wi-Fi could open Cockpit and spend the AI budget. It now runs `next dev -H 127.0.0.1`: localhost works, and the Wi-Fi address is refused.
2. **Today's spend could undercount after 1,000 calls.** Supabase returns at most 1,000 rows per request. Today's spend is now read page by page, like spend to date.
3. **Timed-out calls were not counted.** Anthropic may still bill a call we stop at its timeout. These calls are now logged as `<feature>:timeout` (for example `workspace:timeout`) at a worst-case estimate: input from the text length at full price, plus a full-length reply. The cost math moved to `src/lib/claude-cost.ts`, with 4 new tests (43 in total).
4. **HubSpot card on the Integrations page** now shows Connected, the account number (248054539), the account type and the last check time.

## To do before deploying

- **Login.** Cockpit has no sign-in. Once it is on the internet, anyone with the link could see the data and use the AI budget.
- **Budget overshoot from simultaneous calls (2c).** Two calls started at the same moment can both pass the $2 check, so the budget can be exceeded by a few cents. Fix: reserve the cost before the call, or check again just before sending.
- **Questions-per-hour limit is per browser cookie (2d).** Clearing cookies resets it, and each server instance on Vercel keeps its own count. Fix: limit per signed-in user, stored in the database.
- **Pause AI if cost logging fails.** If a call's cost can't be saved to `llm_calls`, the app only prints an error, so that cost is missing from the budget. Fix: pause AI features for the day when logging fails.
- **sync_runs table and last-sync display.** Nothing records HubSpot sync runs, so the Integrations page's HubSpot card says "Synced manually; see BUILD_LOG.md". Plan: run `supabase/migrations/20261120000000_add_sync_runs.sql` (in the repo, not yet run; on 21 Nov the app couldn't see the table after a first attempt, so check it's the right project), have `npm run hubspot:sync` save one row per run, and show the last full sync's time and counts on the card.

## 2026-11-20 (Friday)

- **Full HubSpot sync.** `npm run hubspot:sync` loaded 190 companies, 207 deals and 30 contacts into the test account, plus two deal pipelines: "New business" and "Renewals & expansion". Records are matched on our own IDs (`lumen_account_id`, `lumen_opportunity_id`), so a re-run updates instead of duplicating. A second run created nothing new, and HubSpot's counts and risk levels match Cockpit. Decision: always do a dry run and a one-record run (`--one`) before a full sync.
- **Our own Renewal date field.** On 19 Nov we chose to reuse HubSpot's built-in "Next Renewal Date". What broke: the first one-record sync was refused, because HubSpot fills that field from its Contracts feature and won't accept values from outside. Nothing was written. Renewal date now goes to `lumen_renewal_date`, and `hubspot:setup` warns if a reused built-in field is read-only. Every other built-in field the sync writes was checked and accepts values.
- **Contact email fix.** Each prospect gets one made-up contact. What broke: HubSpot rejected emails ending in a bare `.example`. They now use `<company>.example.com`, a reserved domain that can't receive mail. The made-up names also repeated too often, so they now vary more.
- **Percent check.** As decided on 19 Nov, one record went first: 0.7186 showed as 71.86% in HubSpot. Percentages go as decimals, unchanged.
- **Note and task test.** This answers the 19 Nov question of whether the app's access covers notes and tasks. `npm run hubspot:test-activity` created one note and one task on the test company, Ionic Logistics, and both attached correctly. No extra access is needed.

## 2026-11-21 (Saturday)

### Contract layer under accounts

**The challenge.** Accounts held one ARR figure and one renewal date. To see which products a customer owns and whether each is being used, Cockpit needed contract line items, built from existing data, with no full reseed and no existing number moving (ARR, MRR, margins, renewal risk, the 6 High-risk accounts).

**How we solved it.**

1. **Agreed the plan first**, including 3 products mapped from the 4 usage features: **Core** (chat assistant, document summary) is the base product every customer owns; **Extract** (data extraction) and **Code Review** (code review) are add-ons.
2. **Took a "before" snapshot** with `npm run contracts:check -- --save-before` (read-only). It records total ARR, every account's MRR and renewal date, every gross margin, every renewal-risk level, and fingerprints of all usage tokens and deal amounts.
3. **Ran a migration** (`supabase/migrations/20261121000000_add_contract_lines.sql`): a new `contract_lines` table, plus nullable `usage_daily.active_users` and `opportunities.contract_id`. What broke: the first run went into a different Supabase project, so the app couldn't see the table. Re-running it in the project whose ID starts `htvo` fixed it. This is probably why `sync_runs` was "not visible" on 21 Nov too.
4. **Dry-ran, then ran, `npm run contracts:backfill`.** It wrote 314 contract lines (150 customer contracts, 10 churned, none for prospects), set `contract_id` on all 105 renewal deals and filled `active_users` on all 38,394 usage rows. Each customer's lines sum exactly to MRR × 12.
5. **Ran the "after" check.** Every number matched the snapshot: ARR $3,069,960, all 190 MRRs and renewal dates, all 150 margins, all 16 risk levels, the same 6 High-risk accounts, and identical usage and deal fingerprints.

**Decision (owner).** For the 26 customers who own Core but never use its features, Core is a small line (10–15% of ARR, rounded to $120) and the rest goes to the add-ons they use, so shelfware shows as a signal without dominating their ARR.

**Simplifications to know about.**

- **Invoices don't reflect mid-contract add-ons.** 40 of 149 add-ons have a purchase date after their contract started, but invoices were left untouched (that is what keeps MRR and NRR unchanged). An invoice history won't show a step-up on the purchase date.
- **One user split across two models.** `active_users` is stored per usage row, and a row is per model. When a feature has only 1 user on a day but used two models, that user goes on the model with more tokens and the other row shows 0 users. 1,205 rows look like this. Adding up a feature's rows still gives the right count.
- **acc_0047's users don't fall.** 15 customers have usage down more than 20%; 14 show users falling too. The exception, acc_0047 (5 seats), already has 1 user per feature per day, so its users can't fall without showing usage by nobody. Its tokens fall 36% because that person uses it less.
- **Add-on purchase dates come before the usage history (15 Aug)**, so every add-on has usage from day one. That is why only 1 add-on is dated by a won expansion deal; the others closed later.

**Report only, not fixed.** 11 won renewal deals are more than 10% away from their contract's ARR (from −50.6% for Larkspur Bio to +32.6% for Redwoodly Legal). Renewal deals were priced at the ARR on the renewal day; seat changes since then moved MRR. `npm run contracts:check` lists them.

**Lessons.**

- Check which Supabase project the SQL Editor is in before running a migration. The project ID is in the address bar after `/project/`.
- A before/after fingerprint is the quickest proof that a backfill didn't touch existing numbers.

**Other work today.**

- **Account page** (`/accounts/<id>`): ARR, seats, renewal date, renewal-risk badge and a **Products** section listing each line with purchase date, ARR, renewal date and an adoption bar (tokens vs the line's allowance; red on an adoption drop, amber over the allowance, "Not adopted" for unused lines). Account names in the Overview table link to it.
- **Per-line metrics** in `src/lib/metrics.ts` (`calcContractLineMetrics`): usage last 30 days vs prior 30, capacity used, average daily active users and their change, and an **adoption drop** flag when line usage falls more than 30%. 8 new tests (61 in total). Account-level metrics are unchanged.
- **`npm run seed` rebuilds the contract layer** with the same code as the backfill. A seed dry run and a backfill dry run on live data print the same contract-layer fingerprint (`640e3ebf199b`), so a future reseed reproduces today's data.
- **Nav bar fix.** The account page is the first page with an ID in its address, and Next.js wanted the nav bar (which reads the address) inside a loading boundary. It now is; while loading it shows the same bar with no tab highlighted.
- **Renewal deals with their lines.** The Renewals page lists all 22 open renewal deals, and each account page lists that account's renewal deals. Each is one row at its full amount and expands to the active lines of the contract it renews (product, ARR, adoption status), found by joining `opportunities.contract_id` to `contract_lines.contract_id`; no columns were added. Where the deal amount and the lines differ, both show with the gap as "uplift" or "reduction"; a churned or unlinked contract shows "No active lines" instead of a gap. Lines with an adoption drop are marked **Downsell risk**, and the Renewals page opens with **ARR at downsell risk**: $34,800 on open renewal deals (both of Vantagely Energy's lines), against $298K across all customers. All 22 open renewals match their lines exactly; only won renewals differ. 5 new tests (66 in total).
- **Next 180 days on Renewals.** The headline card is now **ARR at downsell risk, next 180 days**: adoption-drop lines whose contract renews within 180 days of the as-of date, deal or not. It shows $216K (9 lines on 5 contracts: Ionic Retail, Cedarline Legal, Vantagely Energy and two Orchardly accounts), with $298K across all customers in the small print. A new **Missing renewal deal** check (`calcMissingRenewalDeals`) finds customer contracts renewing within 180 days with no open renewal deal: **46 contracts, $1,085,400 ARR**, listed in a table with renewal date, ARR, renewal-risk level and downsell risk. Finding: 3 High-risk accounts (Larkspur Systems in 13 days, Quillon Retail, Cedarline Legal) have no open renewal deal. Renewals beyond the 120-day risk window show "Not yet checked". 2 new tests replace the open-deals-only downsell test (67 in total).

## 2026-11-22 (Sunday)

### Health-score inputs, team and ownership

**What we did.** Added the data the health score needs, without changing anything that already existed.

1. **Banner.** The date came off the demo banner ("Demo data: Lumen AI is a fictional company."). It said 15 Sep 2026 while every calculation uses `AS_OF_DATE` (13 Nov 2026). `AS_OF_DATE` is still the only "today"; nothing was reseeded.
2. **Migrations** (`20261122000000_add_health_inputs_and_team.sql`, `20261122010000_team_csm_segments.sql`): a `team` table, `accounts.csm_id`, `opportunities.ae_id / adr_id / csm_id`, a `cs_activities` table, `support_tickets.csat_score` and component-point columns on `health_scores`. RLS is on for both new tables.
3. **Team of 15 (fictional).** The 6 existing account owners are the AEs, so `owner` kept its exact values. CSM coverage (owner's decision): Aisha Bello has all 15 enterprise customers (dedicated), Jonas Weber all 45 mid-market (named), and Maya Fernandes and Liam O'Connor split the 90 SMB customers as a pool (45 each). 3 ADRs, 1 CS manager, 1 sales manager.
4. **Ownership rules.** Deals have no owner column, so a deal's AE is its account owner. ADRs only on new deals sourced inbound or outbound (49). Renewal and expansion deals carry the account's CSM (145). Prospects have no CSM; churned accounts keep the CSM of their segment.
5. **CSM activities: 4,594 rows** over about 13 months (emails, calls, meetings, QBRs, exec meetings). Accounts were grouped from today's data (usage trend, NPS, open severe tickets) only to shape the demo: healthy accounts get regular touches and recent exec meetings; declining ones either go quiet (median 121 days since a real touch) or show a burst of 4–8 calls in the last 3 weeks with no executive.
6. **CSAT** on 677 of 947 closed tickets (71%), lower on recent tickets for declining accounts.
7. **Reconciliation** (`npm run health-inputs:check`): every existing column of every table matched its before-fingerprint, ARR stayed $3,069,960, the same 6 High-risk accounts, all 16 risk levels unchanged, and 11 ownership and data rules pass. Moving CSMs between segments changed only `csm_id`: the activity content fingerprint (`1fac79b4f228`) held.

**Reproducible.** `scripts/health-inputs-lib.ts` is used by both `npm run health-inputs:backfill` and `npm run seed`; both print the same fingerprint (`b798f6eb7f07`), and the core (`393ca01b70f9`) and contract-layer (`640e3ebf199b`) fingerprints are unchanged.

**Simplification.** Invoices store only their current status, so past weekly health snapshots use today's invoice status (worth at most 5 points).

### Health score

**What we did.** Built the account health score (0–100) in `src/lib/metrics.ts`, reusing the per-line adoption metrics and adoption-drop flag.

- **Weights** (`HEALTH_WEIGHTS`, one config object adding to 100):
  - Behavioral 35: line adoption weighted by line ARR. Unused lines count as 0.
  - Relationship 20: last CSM touch 8, exec meeting in 90 days 7, QBR this term 5. Emails don't count as a touch.
  - Feedback 20: latest NPS 12, NPS change 4, CSAT 4. No NPS response scores 40%.
  - Support 15: open tickets by severity 10, resolution time 5.
  - Financial 10: overdue invoices 5, invoice growth over 12 months 5.
  - Gross margin and renewal risk are not inputs.
- **Bands:** green 70+, amber 50–69, red below 50.
- **Declining:** down 10+ points on last week.
- **Weekly snapshots:** 900 rows in `health_scores` (`npm run health:backfill`): 150 customers × 6 weeks, from 9 Oct to 13 Nov, all measured from `AS_OF_DATE`. The pages compute the same numbers live with the same function (`calcHealthTrend`).
- **Today's results:** 114 green, 22 amber, 14 red, 2 declining (Aster Legal and Orchardly Logistics).
- **Renewal risk** has a fifth sign, "Poor or declining health" (below 50, or down 10+). It counts only when "Usage declining" isn't already firing.
  - **Before and after:** High-risk stays at **6, the same accounts**.
  - The only two renewing customers with poor health (Vantagely Energy and Cedarline Legal) already fire "Usage declining", and both were already High.
- **Pages:**
  - A new **Health** page: score badges, a week-over-week arrow, adoption-drop chips and a Declining tag, worst first.
  - On each account page, above Products: a large score, a 6-week line chart, and a bar of each category's points.
- **Tests:** 7 new (74 in total) cover the weights, every band edge, a hand-worked account, the short-window rule, declining vs poor, and the new renewal sign.

**Decisions and simplifications.**

- **Expansion vs contraction uses invoices.** No contract line has ever ended on a current customer, so line-based contraction would never fire. The score compares each customer's latest invoice with the earliest in the last 12 months (seat changes move it). Invoices don't show mid-contract add-ons (see 21 Nov).
- **Short comparison window.** The oldest snapshot's prior 30 days start before usage history (15 Aug), so `calcContractLineMetrics` takes an optional history start and compares daily averages. Today's numbers are unchanged.
- **Back-weeks use today's invoice status.** Invoices only store their current status (at most 5 points).
- **`health_scores.usage_trend` and `capacity_used` are left empty.** Adoption is per contract line now, and the five category points are stored instead.
- **HubSpot not synced.** Risk levels didn't change, so nothing is stale. The `lumen_health_score` property is still empty.


### Health display polish

- **Health page:** ARR column, filters, sorting and clickable rows. Hovering a score badge shows the five-category summary.
- **Account page:** one row per health category with an earned-vs-possible bar. Hovering shows each metric's value and points, and for Behavioral each product line's usage, users and allowance used. The stacked bar is gone.
- Every adoption figure states its window (last 30 days vs prior 30). Account names are underlined links, and the account page has a **← Back** link to the previous page.

### Renewal risk rebuilt on the health score

**What changed.** Renewal risk used separate signs (low NPS, NPS dropping, usage declining and so on). Those now live inside the health score, so the rule reads the score instead. All thresholds are in one config object, `RENEWAL_RISK_RULES` in `src/lib/metrics.ts`.

- **Window by segment**, counted from `AS_OF_DATE`: enterprise 180 days, mid-market 120, SMB 90. Renewals outside the window are Low.
- **High:** health below 50; or health 50–69 with underwater margin, health down 10+ points on last week, or 25%+ of contract ARR at downsell risk.
- **Medium:** health 50–69; or health 70+ with underwater margin or any line at downsell risk; or NPS down 3+ points since the previous survey.
- **Every customer now has a level** (Low included), used by the Renewals page, the account page, the HubSpot sync values and Claude's renewal facts. Reasons show as chips.
- **Result:** High went from 6 accounts to 4 (Vantagely Energy, Cedarline Legal, Ionic Retail, Copperleaf Labs), $370,800 ARR. Larkspur Systems and Quillon Retail moved to Medium.
- `npm run renewal-risk:compare` (read-only) prints the High and Medium lists and compares them with a saved "before" (`reconciliation/renewal-risk-before.json`).
- This replaces the "fifth sign" described under Health score above.

### Executive sponsor

- **New account fields** (migration `20261123000000_add_account_exec_sponsor.sql`): sponsor name, title, status (active / left / none) and the date a sponsor left.
- **Seeded additively** for enterprise and mid-market customers only: 46 active, 9 none, 5 left (mostly on lower-health accounts). SMB, prospects and churned accounts are not tracked. The backfill and `npm run seed` share one builder; the reconciliation check showed no existing value changed.
- **New renewal-risk trigger:** an enterprise or mid-market customer with no sponsor, or whose sponsor left, is Medium on its own, High when health is below 70.
- **Result:** High stays at the same 4. Medium went from 10 to 13 (Copperleaf Media: sponsor left; Nimbus Health and Nimbus Media: no sponsor). Copperleaf Labs, already High, gained a "No exec sponsor" chip.
- The account page shows the sponsor, and Claude's renewal facts include sponsor status.

### Account page: Renewal Risk section and missing renewal deal

- **Renewal Risk section** under Renewal Deals: the level, reason chips, the window, and every condition with this account's value, the rule and whether it counts.
- **Missing renewal deal:** inside the window with no open renewal deal, the page says "Contract renews [date] ([N] days) · No renewal deal opened yet" with a red chip. This doesn't change the risk level. Outside the window it says no renewal deal is needed yet.

### Missing renewal deals: same window on both pages

**What broke.** The Renewals page looked 180 days ahead for every customer, while account pages used the segment windows. An SMB account renewing in 100 days showed as missing a deal on the Renewals page but not on its own page.

**Fix.** The Renewals check (`calcMissingRenewalDeals`) now uses the same segment windows from `RENEWAL_RISK_RULES`. The "ARR at downsell risk, next 180 days" card still looks 180 days ahead for everyone.

**Result.** Missing renewal deals went from 46 contracts ($1,085,400 ARR, see 21 Nov) to **19 ($833,400)**: 7 enterprise, 6 mid-market, 6 SMB. A read-only check of all 150 customers found the Renewals page and the account pages flag exactly the same 19 accounts. Three are High risk: Cedarline Legal (108 days), Ionic Retail (165) and Copperleaf Labs (177).

**Tests:** 79 in total. The missing-deal test now covers each window's edge (SMB day 90/91, mid-market 120/121, enterprise 180/181).

**Open item.** HubSpot has not been re-synced since the renewal-risk rule changed, so the Renewal risk values there are out of date (6 High before, 4 now). Run a dry run, then `npm run hubspot:sync`, when ready.
