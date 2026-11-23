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

**Downsell card too.** "ARR at downsell risk" on the Renewals page now uses the same segment windows instead of a flat 180 days, and is renamed "ARR at downsell risk, inside renewal window". It went from $216K (9 lines on 5 contracts, see 21 Nov) to **$208,800 (7 lines on 3 contracts)**: Ionic Retail $99,600, Cedarline Legal $74,400 and Vantagely Energy $34,800. Orchardly Labs (136 days) and Orchardly Logistics (175 days) dropped out because they are SMB, with a 90-day window. The "across all customers" small print is unchanged at $298K. The downsell test now covers the 90/91, 120/121 and 180/181 day edges. Nothing on the Renewals page looks a flat 180 days ahead any more.

**Open item.** HubSpot has not been re-synced since the renewal-risk rule changed, so the Renewal risk values there are out of date (6 High before, 4 now). Run a dry run, then `npm run hubspot:sync`, when ready.

### HubSpot: health, renewal signals, people, products and sponsor contacts

**What we did.** Extended the HubSpot sync so the CRM shows what Cockpit now knows, and added a button to run it.

1. **New values, all from `metrics.ts`** (`calcCrmSyncData`):
   - Company: health score, health declining, renewal-risk reasons, ARR at downsell risk, missing renewal deal, executive sponsor status, AE and CSM names, products owned, and Core / Extract / Code Review ARR.
   - Deal: ADR and CSM names.
   - Contacts: each enterprise and mid-market customer's executive sponsor (current or former) as a contact with job title and a new **Lumen role** property (Executive sponsor / Former sponsor).
2. **14 new HubSpot properties**, created with `npm run hubspot:setup` after a dry run (no warnings). Setup now creates proper HubSpot checkboxes for yes/no fields, and created the Lumen Console group on contacts.
3. **Shared sync code** (`src/lib/hubspot-sync-run.ts`), used by `npm run hubspot:sync` and a new **Sync to HubSpot** button on the Integrations page, which shows each step and the result. New `--account <id>` option to sync one chosen customer.
4. **Checked on one record first.** Ionic Retail (`--account acc_0089`) went first, twice, and the owner checked it in HubSpot before the full sync.
5. **Full sync:** 190 companies and 207 deals updated, 81 contacts (50 new sponsor contacts). No errors.

**Result.** Renewal risk in HubSpot went from 6 High, 10 Medium, 134 Low (set by the 20 Nov rules) to **4 High, 13 Medium, 133 Low**. That matches Cockpit on every customer. 13 customers changed level, for example Ionic Retail and Copperleaf Labs Low → High, Larkspur Systems and Quillon Retail High → Medium. 19 companies have Missing renewal deal ticked and 2 have Health declining, matching the Renewals and Health pages. Spot checks of a deal's ADR and CSM names and the 5 former-sponsor contacts matched Cockpit.

**Decisions (owner).**

- **ARR at downsell risk per company** counts every product line with an adoption drop, whatever the renewal date. The Renewals card only counts lines inside the renewal window.
- **The button only works locally** (on this Mac with `npm run dev`) until Cockpit has a login, because anyone with the link could otherwise write to HubSpot. Elsewhere it is greyed out with "Available locally until login is added".
- **AE, CSM and ADR are text fields**, not HubSpot's Owner field: the team is fictional and Owner only accepts real HubSpot users.
- **Sponsor emails use `<company>.example.com`**, not a bare `.example` domain, which HubSpot rejects.

**Not tested.** The sync endpoint refuses requests that don't come from the Integrations page (a custom header and an origin check). An automated safety check blocked the test request, so that guard hasn't been tried. The button's full run also hasn't been clicked; the same code ran from the command line.

**Follow-up: blank, not $0.** Core / Extract / Code Review ARR are now blank when the customer doesn't own the product (the full sync above sent $0). On live data that is Extract on 77 customers and Code Review on 74; every customer owns Core. HubSpot shows the blanks after the next sync, which the owner will run with the button.

**Still open.** Sync runs aren't recorded (`sync_runs` is still parked), so the HubSpot card keeps saying "Synced manually; see BUILD_LOG.md", and the button's result disappears on reload.


### Navigation in four sections

- **Overview**, **Pipeline** (Deal Risk; ADR hygiene and ADR insights will join it, and anything top of funnel), **Customer Success** (Health and Renewals; Consumption will join it) and **Integrations**. Pipeline and Customer Success have a row of sub-tabs.
- **New addresses:** `/pipeline/deal-risk`, `/customer-success/health`, `/customer-success/renewals`. The old ones (`/deal-risk`, `/health`, `/renewals`) redirect there, keeping anything after the `?`; `/pipeline` and `/customer-success` open their first page. Redirects are temporary (307) while the nav is still changing.
- **Workspace** is out of the nav, but `/workspace` still works.
- One list in `src/lib/pages.ts` drives the nav, the sub-tabs and the redirects.

### What customers are saying: text, topic tagging and the account-page panel

**Text, seeded additively.** A short description on every support ticket (957) and a note on every CSM call, meeting, QBR and exec meeting (3,058; emails get none), from a fixed template generator (`scripts/text-lib.ts`, used by `npm run text:backfill` and `npm run seed`; same fingerprint `20593f4aaa2b`). Varied and often indirect ("their CFO wants them to benchmark other vendors before renewal"), some mixing two topics, about 9% deliberately ambiguous. Risky topics sit in declining accounts (68–69% of their last-180-day texts) and are rare in healthy ones (7%, never competitors or leaving). Fictional competitors only: Brontide AI, Veyra Labs, Kestrine. Ionic Retail and Copperleaf Media carry clear examples (two named-account texts were reworded to fit the real dates: season, and the sponsor's leaving date). `npm run text:check`: every existing table, ARR, all 150 health scores and renewal-risk levels unchanged; all text checks pass.

**Topic tagger.** `npm run signals:tag` sends each text from the last 180 days to Claude Haiku 5.5 once, through `callClaude()` (feature `topic_tagging`), and stores topics, competitor, sentiment and a word-for-word quote in `text_signals` (one row per text, enforced by the table). It stops when today's Claude spend reaches $1.50, leaving the rest of the $2 budget for the app.
- `callClaude()` now takes a model; Haiku 5.5 is priced at $0.10 / $0.50 per million tokens (confirmed by the owner against Anthropic's pricing page) in Cockpit's own cost table, not in `model_prices` (that one feeds customer gross margin). Haiku calls go without the refusal fallback, which Haiku doesn't support.
- **Cost:** pilot of 20 $0.00277, then the other 2,360 $0.32275: **$0.3255 for all 2,380** (about $0.00014 per text; estimate was $0.49). 1 quote wasn't word for word and was stored empty.

**Account page: "What Customers Are Saying"** (under Health): topic chips with counts for the last 90 days, the text count with its negative / neutral / positive split, competitors named, and the 5 most recent quotes with date and source. Ionic Retail: 22 texts in 90 days, Reliability 9, Pricing complaint 7, Implementation 3, Feature gap 3, Competitor 1 (Brontide AI); 15 negative, 0 positive.

**Eval (owner's marks, 23 Nov).** 20 tagged texts, fixed seed: 9 written with a risky topic, 8 without, 3 ambiguous (`reconciliation/topic-eval.md`).
- **Prompt v1: 16/20 (80%).** Misses: #1 a plain question tagged as a feature gap; #7 and #18 "do you offer on-prem, as some other vendors do?" not tagged (should be competitor mention + feature gap); #12 "wants to understand what they're paying for" not tagged (should be a pricing signal).
- **Against what the texts were written to say:** Claude matched 18 of 20. #1 was its own mistake; on #9 it also added feature gap, which the owner marked right (the intended label was too narrow). On #7, #12 and #18 Claude agreed with the intended "no topic": the generator and prompt v1 used the same narrow rules, and the owner's marks set the rule now.
- **Fix (prompt v2, `TAGGING_PROMPT_VERSION = 2`):** an unnamed comparison with other vendors is a competitor mention; asking whether we offer what other vendors offer is also a feature gap; otherwise a question isn't a feature gap unless the text says it's unsupported; scrutiny of what they're paying for is a pricing complaint; and a problem that blocks their use is negative sentiment even when the cause is on their side.
- **Prompt v2: 19/20 (95%) on topics and sentiment** (`reconciliation/topic-eval-v2.json`). All four misses fixed; topics right on all 20 and stable across re-runs. The one miss is #5 ("interested in the next Extract release"): sentiment positive → neutral. That is run-to-run variation on a borderline text, not the prompt change: each re-run so far moved one borderline sentiment (#13 and #17 on the run before, fixed by the sentiment line). Re-tagging the 20 three times cost $0.0096.
- **Scores:** prompt v1 **16/20 (80%)**, prompt v2 **19/20 (95%)**. Topics were the same on all 20 across three v2 runs.
- **Decision (owner): accept neutral for borderline texts like #5.** Borderline sentiment (mild interest, problems on the customer's side) varies between runs of the same prompt, which is why each text is tagged once and the result stored, not recalculated on every view.
- **Full re-tag with v2:** the other 2,360 texts re-tagged with `npm run signals:tag -- --retag-all` for **$0.39833** (about $0.00017 per text). The 20 eval texts keep the v2 tags the owner scored. 2 quotes weren't word for word and were stored empty. Every tagged text now carries v2 tags; topic tagging has cost $0.73 in all (v1 run $0.3255, eval re-runs $0.0096, v2 re-tag $0.3983).

### ADR data: leads, sequences, Stage 0.1, account tags and ADR-AE pairing

**What we did.** Added the account-development data the ADR hygiene and insights pages will need, additively (migration `20261125000000_add_adr_data.sql`). One library, `scripts/adr-lib.ts`, is used by `npm run adr:backfill` and `npm run seed` (same fingerprint `a248d12f8e93`).

- **Territories and pairing:** each AE has a territory (Enterprise North America, Enterprise EMEA, Commercial East / Central / West / EMEA); ADRs are paired by territory (Sofia Marin: both enterprise; Kenji Watanabe: Commercial East and Central; Grace Mensah: Commercial West and EMEA) in `adr_ae_pairings`. **Decision (owner):** the pairing counts from 1 Oct 2026; older deals aren't judged against it (18 of the 49 older ADR deals would otherwise look mismatched, because ADRs used to be round-robined).
- **Account tags:** ICP tier, target account and territory (the owner's territory) on all 190 accounts, with planted errors: 4 tier-3 accounts marked as targets, 5 with no tier, 3 with no territory, 3 with the wrong territory.
- **Leads:** 600 over the last 6 months, with fictional contacts at `<company>.example.com`. The 44 existing new-business deals created in that time are linked to the lead they came from (the deals don't change). 8% unassigned; 31% of MQLs touched after the 24-hour SLA (18%) or never (13%); Kenji is on time for 64% of his MQLs, Sofia 86%, Grace 83%. Lead→SQL differs clearly by source: inbound demo request 42%, partner 26%, outbound 11%, webinar 9%, event 7%, content download 1%.
- **Sequences:** 8 with owners and step counts, 655 enrollments. Inbound demo follow-up books meetings for 36% of enrollments, content nurture 1%. The bought-list commercial outbound sequence (used since 1 Sep) bounces at 16%, against at most 6% for every other sequence.
- **Stage 0.1** ("meeting booked, qualifying") is the first New business stage: 25 new deals from recent SQLs, 6 stale (no update in 14+ days). It isn't counted as open pipeline (the four open stages are unchanged), so no pipeline, forecast or Deal Risk number moves.
- **ADR-AE mismatches:** 7 deals since 1 Oct have an ADR who isn't paired with the AE: the 4 planted Stage 0.1 deals, plus 3 existing deals (opp_0054, opp_0055, opp_0056) created after 1 Oct with their old round-robin ADR.

**Reconciliation (`npm run adr:check`).** Every existing table unchanged row by row (existing deals only), and all 30 page sections (Overview, pipeline, win rate, upcoming deals, Deal Risk, Renewals, Health, HubSpot sync values, Workspace data) unchanged. Stored rows match the builder, and every planted problem is present.

**HubSpot. Decision (owner):** Stage 0.1 deals stay out of the sync (they aren't in HubSpot's pipelines), so the Sync button keeps working; it reports how many it left out. Leads and sequences aren't synced.

## 2026-11-23 (Monday)

### ADR Hygiene, ADR Insights and the AI memo for the ADR manager

**What we did.** Two new Pipeline pages built on the ADR data from 22 Nov, and an AI memo for the ADR manager. All numbers come from `src/lib/metrics.ts`, and every threshold is in one config object, `ADR_RULES`. "Now" is the end of the as-of day (13 Nov 2026), the same cut-off the ADR data was built with.

1. **ADR Hygiene** (`/pipeline/adr-hygiene`): one card per check, each with its count, a one-line "why it matters" and a list you can expand (record, account, problem, owner, how long). There is a total at the top and a filter by ADR (`?adr=…`).

   | Check | Rule | Today |
   |---|---|---|
   | Unassigned leads | An open lead (lead, MQL or SQL) with no ADR | 36 |
   | MQLs past the 24-hour SLA | Still an MQL, never touched, and its 24 hours are up | 29 |
   | Stale Qualifying deals | No update for 14+ days | 6 |
   | SQLs that never got a deal | An ADR-to-AE handoff leak: an SQL with no deal 3+ days after its meeting | 2 |
   | ADR–AE pairing mismatches | An open deal created on or after 1 Oct whose ADR isn't paired with its AE | 7 |
   | Account tag problems | No ICP tier, tier 3 marked as a target, no territory, or a territory that isn't the owner's | 15 |

   - **Total: 95** (Sofia 20, Kenji 42, Grace 33).
   - **30-day SLA breach rate: 28.8%** (19 of 66 MQLs touched late or never).
   - **How the ADR filter assigns issues:** a lead goes to its ADR, or if it has none, to the ADR who covers its territory. A deal goes to its ADR. An account goes to the ADR paired with its owner.
2. **ADR Insights** (`/pipeline/adr-insights`), covering the last 6 months:
   - **Funnel by lead source:** leads → MQL → SQL → Qualifying → opportunity. Inbound demo requests do best: 20.4% of leads become opportunities, against 7.3% overall.
   - **Speed to lead by ADR:** team 69.4% on time; Kenji 64.5%, Sofia 89.3%, Grace 83.0%.
   - **Sequence performance:** best is Inbound demo follow-up (36.4% meetings). Worst is the bought list: 0% meetings and a red 15.8% bounce rate.
   - **Results per ADR.**
3. **"Qualifying"** is what users see for the stored stage `Stage 0.1`: "meeting held, not yet qualified as an opportunity". It's set in one place (`stageLabel` in `src/lib/format.ts`). Database values and internal names are unchanged.
4. **Meetings booked** means sequence enrollments with `meeting_booked`, everywhere. All 88 SQLs have a sequence meeting today. Meetings outside a sequence aren't recorded, so the page shows "SQLs with no sequence meeting" (currently 0) to make any gap visible.
5. **AI memo** at the top of ADR Insights:
   - **How it works:** a **Generate memo** button sends a compact summary from `metrics.ts` (`getAdrMemoInput`) to Claude Sonnet 5.5 through `callClaude()` (feature `adr_memo`).
   - **What comes back:** a one-sentence headline and 3–5 recommendations. Each has a finding, why it matters, an action, an owner and the expected impact.
   - **Saving:** each memo is saved in `briefings` (kind `adr_memo`) with the exact summary sent, the model, the cost and the grounding result. The page shows the latest one, with a **Regenerate** button.
6. **Grounding check** (`src/lib/grounding.ts`, new): every number and date in the memo must appear in the summary Claude was given. "$34,800" matches 34800; "$35K" doesn't. Numbers it can't find are highlighted on the page and saved with the memo. Signs are ignored ("4.9 points below" matches −4.9), and numbers written as words aren't checked.
7. **ADR manager:** Nadia Haddad (fictional, `tm_16`) was added to the team, additively. The memo is written for her, and the sales manager can still be named as an owner.

**Migration** (`20261126000000_adr_manager_and_memos.sql`, run by the owner): it allows the new "ADR manager" role, adds Nadia's row, and adds `kind`, `as_of_date`, `model`, `cost_usd`, `input` and `grounding` to `briefings`. Existing rows became kind `daily`. RLS stays on.

**First saved memo (23 Nov):**
- **Cost:** $0.0221 (4,512 input and 1,312 output tokens). Grounding: all 52 numbers and dates were found in the data.
- **Headline:** Kenji has the most leads and the weakest speed to lead, while unassigned leads and the bought-list sequence waste effort that could go to inbound demo follow-up.
- **Recommendations, in order:**
  1. Clear Kenji's 16 overdue MQLs (owner Nadia).
  2. Assign the 36 unassigned leads (RevOps).
  3. Pause the bought-list sequence (Kenji).
  4. Copy the inbound demo follow-up approach into the webinar and event follow-ups (Grace).
  5. Review the 6 stale Qualifying deals (David Novak).
- An earlier unsaved run, made before the migration, cost $0.0238 and was also fully grounded.

**Checks.**
- **Tests:** 102 pass (13 new: 8 ADR tests worked out by hand, 4 grounding tests and 1 stage-label test).
- **Reconciliation (`npm run adr:check`):** every existing table and all 30 page sections are unchanged. `team` now shows 15 → 16 rows. That's Nadia; the 15 original rows still match their "before" fingerprint (`f4337162a2e9`).
- **Health-inputs fingerprint:** it will change, because `TEAM` now includes the ADR manager.

**Decisions (owner).**
- The grounding check is new; nothing earlier checked numbers.
- The handoff-leak card counts SQLs with no deal.
- Meetings booked come only from sequence enrollments.
- The memo has a headline.
- The stage is shown as "Qualifying".

**Simplifications.**
- Tag problems have no date, so their "how long" says "Not tracked".
- **Funnel stages:** "Qualifying" counts any lead with a deal. The 44 older deals were opened straight into a later stage, so they count as having passed Qualifying.
- **Different counts from the 22 Nov data check:**
  - Per-ADR SLA % is slightly higher here than in that check (Sofia 89.3% vs 86%), because this page leaves out MQLs whose 24 hours aren't up yet.
  - Sequence open rates here are per enrollment; the data check counts per email.

**Open items.**
- **Production build:** `next build` couldn't run in Claude's sandbox, because it can't download the Google font. Type-check and tests pass.
- ~~**Reconciliation snapshot:** `reconciliation/adr-before.json` still holds the 15-row team.~~ **Resolved 23 Nov:** saved again with `npm run adr:check -- --save-before` (team: 16 rows, `5ffa8ee62963`; nothing else changed), and `npm run adr:check` now passes with nothing changed.

### New lead lifecycle

**What changed.** Leads now move through **New** (downloaded or signed up for something) → **Engaged** (responded to automated marketing emails) → **MQL** → **Sales accepted** (an ADR took ownership and is working it) → **Sales qualified** (passed the ADR's qualifying call) → **Meeting booked** (meeting set with an AE; the Qualifying deal is created here). Every lead ends as **Converted** (became an opportunity), **Disqualified** (with a reason) or **Nurture** (returned to marketing).

- **Migration** (`20261127000000_lead_lifecycle.sql`, run by the owner), additive:
  - `leads.lead_stage` plus a timestamp for each stage reached: `engaged_at`, `sales_accepted_at`, `sales_qualified_at`, `meeting_booked_at`, `converted_at`, `disqualified_at` and `nurtured_at`.
  - A constraint that keeps the stages in order.
  - `lifecycle_stage` and `sql_at` keep their values as legacy columns.
- **Paths are built from each lead's existing values** (`buildLeadStages` in `scripts/adr-lib.ts`, its own random stream), so MQL times, first touches, sequence enrollments and deals line up. `npm run adr:backfill` and `npm run seed` share it (ADR fingerprint `36c65a0c56c7`). No deals were created or changed.
- **The rules:**
  - The 24-hour SLA stays MQL → first touch.
  - Sales accepted needs an ADR and a first touch.
  - **A lead reaches Meeting booked only with a Qualifying deal.**
  - Converted means the deal moved past Qualifying.
  - Untouched MQLs stay open at MQL, because they are the SLA breaches.
  - Leads that never reach MQL go to Nurture 30–45 days after creation. Sales accepted leads that stall go to Nurture 21–30 days after acceptance.
- **Decisions (owner):**
  - **The 17 leads disqualified "after the first meeting"** are now disqualified at the ADR's qualifying call, before Meeting booked. About a third reached Sales qualified ("No budget this year"); the rest stopped at Sales accepted ("Not a fit at the qualifying call"). This changes `disqualify_reason` on those 17 rows, the only existing value that changed.
  - **Handoff leak** = a lead at Sales qualified for 3+ days with no meeting with an AE. Today it's the 2 leads that had a qualifying call but no deal.
  - **Meetings booked** = leads that reached Meeting booked (69). The sequence table's column is now "Call booked" (88), because a sequence's booked calls include ADR qualifying calls.

**Result (as of 13 Nov):**
- **Funnel:** 600 New → 404 Engaged → 336 MQL → 288 Sales accepted → 94 Sales qualified → 69 Meeting booked → 44 Converted. 168 Disqualified, 226 Nurture, 162 still open.
- **Weakest step:** Sales accepted → Sales qualified, at 32.6% (content download 15.2%, webinar 8.0%, demo requests 42.9%).
- **By source:** demo requests go furthest, with 35 of 108 at Meeting booked. 69% of content downloads end in Nurture or Disqualified.

| ADR numbers | Before | After |
|---|---|---|
| Hygiene total | 95 | **83** |
| Unassigned leads | 36 | **24** (old unassigned leads went to Nurture) |
| Open SLA breaches / stale Qualifying / handoff leaks / mismatches / tag problems | 29 / 6 / 2 / 7 / 15 | 29 / 6 / 2 / 7 / 15 |
| SLA breach rate, 30 days | 28.8% (19 of 66) | 28.8% (19 of 66) |
| Speed to lead (team / Sofia / Kenji / Grace) | 69.4% / 89.3% / 64.5% / 83.0% | unchanged |
| Meetings booked (Sofia / Kenji / Grace) | 17 / 38 / 33 (sequence meetings) | **12 / 30 / 27** (Meeting booked stage) |
| New per-ADR columns (accepted / qualified / converted) | n/a | Sofia 56 / 17 / 5, Kenji 137 / 41 / 21, Grace 95 / 36 / 18 |

Both snapshots are in `reconciliation/adr-numbers-before-lifecycle.json` and `reconciliation/adr-numbers-after-lifecycle.json`.

**Checks.**
- **`npm run adr:check`:** every customer, health and renewal table and all 30 page sections are unchanged.
- **New lifecycle checks, all passing:**
  - every lead has a stage, with its stages in order, and none after the as-of date
  - no Meeting booked without a Qualifying deal, and every deal has Meeting booked
  - Meeting booked equals `sql_at`
  - Converted exactly when the deal is past Qualifying
  - every ending has its time (and a reason when Disqualified)
  - leads disqualified at the qualifying call stop before Meeting booked
  - content downloads mostly end in Nurture or Disqualified, and demo requests progress furthest
- **Tests:** 110 pass. There are 8 new tests for the path builder, and `npm test` now also runs `scripts/*.test.ts`.

**Memo regenerated (23 Nov):**
- **Cost:** $0.0272 (5,328 input and 1,653 output tokens). Grounding: all 65 numbers and dates were found in the data.
- **Headline:** speed to lead (69.4% on time, 43 never touched) and the Sales accepted → Sales qualified step (32.6%) are the biggest leaks.
- **Recommendations:**
  1. Assign the 24 unassigned leads and clear Kenji's breaches (Nadia).
  2. Tighten acceptance for content and webinar leads (Nadia).
  3. Pause the bought-list sequence (RevOps).
  4. Clear stale Qualifying deals, the 2 handoffs and the mismatches (David Novak).
  5. Protect Kenji's time for demo follow-up (Nadia).

### Sequence email metrics per email sent, and the Pipeline tab order

**What changed.**
- **Sequence table on ADR Insights:**
  - Email rates are now **per email sent**: open, **click-through (new)**, reply and bounce. Emails sent has its own column.
  - **"Call booked (per enrollment)"** is the same number as before (enrollments that booked a call ÷ enrollments).
  - **"Used by"** (the ADRs who enrolled leads in it, most first, plus unassigned) replaces Owner.
  - A note under the table defines each rate. Bounce rates above 10% per email are red.
- **Migration** (`20261128000000_enrollment_clicks.sql`, run by the owner): `sequence_enrollments.clicks`, defaulting to 0, with a rule that clicks can't exceed opens.
- **Engagement re-seeded by temperature** (`scripts/adr-lib.ts`, agreed with the owner):
  - **Cold** (outbound cold, bought list, content nurture, re-engagement): opens 20–40%, click-through 1–3%, replies 1–5%, bounces 2–6% per email. The bought list stays the outlier at 15.6%.
  - **Warm** (inbound demo, webinar and event follow-up): opens 50–70%, click-through 4–10%, replies 15–40%, bounces under 2%.
  - **Bounces are hard or soft.** Hard: the first email bounces and the sequence stops, which is a bad address. Soft: any email bounces temporarily. Without soft bounces, the cold ranges would need about a fifth of all contacts to bounce.
  - Leads with a meeting reply to the 2nd email of a warm sequence and the 3rd of a cold one.
- **Meetings booked are exactly as before:** 88 calls, each at its lead's `sql_at`. Lead stages, deals, the funnel, hygiene, speed to lead and the per-ADR table are unchanged.
  - One knock-on effect: Re-engagement went from 55 to 56 enrollments, because the leads that qualify for it depend on earlier bounces.
- **Pipeline sub-tabs:** ADR Insights, ADR Hygiene, Deal Risk. `/pipeline` opens ADR Insights. Redirects only change when the dev server restarts.
- **Decision (owner):** no bounced-contacts hygiene card.

| Sequence (per email) | Open | Click-through | Reply | Bounce | Call booked (per enrollment) |
|---|---|---|---|---|---|
| Inbound demo follow-up (warm) | 64.4% | 7.2% | 26.3% | 0.5% | 36.4% |
| Outbound cold: commercial | 35.8% | 2.5% | 4.6% | 4.6% | 19.5% |
| Webinar follow-up (warm) | 65.0% | 8.5% | 17.5% | 0.6% | 8.6% |
| Event follow-up (warm) | 60.6% | 5.8% | 22.1% | 1.0% | 6.7% |
| Outbound cold: enterprise | 35.3% | 2.3% | 4.0% | 4.0% | 6.3% |
| Content nurture | 31.6% | 2.8% | 1.3% | 2.5% | 1.3% |
| Re-engagement | 32.3% | 1.3% | 2.5% | 2.5% | 0.0% |
| Bought list | 22.2% | 1.4% | 1.9% | 15.6% | 0.0% |

**Checks.**
- **`npm run adr:check`:**
  - all customer, health and renewal tables and all 30 page sections are unchanged
  - each sequence is within its temperature's ranges, and the bought list is at 15–16%
  - clicks never exceed opens, and opens never exceed emails sent
  - calls booked are unchanged
  - every lifecycle rule still passes
- **ADR page numbers:** hygiene, funnel, speed to lead and the per-ADR table are identical to `reconciliation/adr-numbers-after-lifecycle.json`.
- **Tests:** 111 pass. The sequence test now covers per-email rates, call booked per enrollment and Used by.

**Memo regenerated (23 Nov):**
- **Cost:** $0.0252 (5,816 input and 1,356 output tokens). Grounding: all 53 numbers and dates were found in the data.
- **Headline:** 7.3% of 600 leads converted; 28.8% of MQLs breached the SLA in the last 30 days, with Kenji at 64.5% on time.
- **Recommendations:**
  1. Clear Kenji's 16 breaches and route some MQLs to Sofia (Nadia).
  2. Assign the 24 unassigned leads (RevOps).
  3. Pause the bought list (15.6% bounce per email, 0 calls) and move contacts to Outbound cold: commercial (Nadia).
  4. Tighten MQL criteria for content and webinar leads (Nadia).
  5. Clear the 5 stale Qualifying deals and the 2 handoffs (Sofia).

### Fixes before the demo

1. **Memo prompt, bounce rule:** contacts from a high-bounce list must never be moved to another sequence. The action is to pause, remove the bounced addresses and verify the rest before re-enrolling.
2. **Memo summary, territory labels:** each hygiene check now has `owned_by_adr` (items an ADR actually owns) and `no_adr_by_territory` ("in [name]'s territory"). Unassigned leads are never counted as that ADR's. The prompt says the same.
   - This also corrected a count: Kenji owns **9** of the 29 MQLs past SLA. The other 7 counted before are unassigned leads in his territory.
   - Hygiene items now carry `ownerAdrId`, the real owner, next to the filter's territory attribution.
3. **New hygiene card, "Leads in sequences with no owner":** open leads (not Converted, Disqualified or Nurture) enrolled in a sequence with no ADR. How long = since the first enrollment.
   - Today it's **24**, the same 24 leads as "Unassigned leads", because every lead is enrolled in a sequence. So the card shows a note and **isn't added to the hygiene total** (still 83), which would otherwise count each lead twice.
4. **Speed to lead:** the team rate covers assigned ADRs only, **75.0% across 308 MQLs** (was 69.4% with unassigned included). Unassigned (25 MQLs, 0% on time) is its own row, outside the team rate and the green/red comparison.
5. **HubSpot sync runs recorded:**
   - **Migration** `20261129000000_sync_runs.sql` (to run in Supabase). The parked `20261120000000_add_sync_runs.sql` was never run here and is marked superseded.
   - **What's recorded:** every real sync, from the button or `npm run hubspot:sync`, success or failure, saves one row (`src/lib/sync-runs.ts`). The row holds scope, source, times, synced and created counts, Qualifying deals left out, and any error. Dry runs aren't recorded, and a failure to record never fails a sync.
   - **On the card:** the last run's time, result and counts, plus the last full sync if a single-account run came after it.
6. **Claude card:** spend and calls to date by feature and model, read in pages from `llm_calls`. Timeouts count under their feature. Today:

   | Feature | Model | Calls | Spend |
   |---|---|---|---|
   | Topic tagging | Haiku 5.5 | 4,800 | $0.7338 |
   | Workspace chat | Sonnet 5.5 | 7 | $0.3867 |
   | Flag reasons: Renewals | Sonnet 5.5 | 14 | $0.3025 |
   | Flag reasons: Deal Risk | Sonnet 5.5 | 9 | $0.2571 |
   | ADR memo | Sonnet 5.5 | 4 | $0.0983 |

7. **Gainsight card (planned):** "push health scores to scorecards and renewal risk as CTAs."

**Memo regenerated (23 Nov):**
- **Cost:** $0.0280 (6,482 input and 1,505 output tokens). Grounding: all 54 numbers and dates were found in the data.
- **Recommendations:**
  1. Assign the 24 unassigned leads ("10 in Kenji Watanabe's territory and 11 in Grace Mensah's territory").
  2. Clear Kenji's 9 MQLs past SLA (64.5% against the team's 75%).
  3. Pause the bought list, remove bounced addresses and verify the rest, and don't move the contacts.
  4. Focus on demo and partner leads.
  5. Clear the stale Qualifying deals and the 2 handoffs.

**Checks.**
- **`npm run adr:check`:** all customer, health and renewal tables and all 30 page sections are unchanged, and all ADR checks pass.
- **Tests:** 112 pass. New coverage: the new card and its exclusion from the total, owner vs territory attribution, and unassigned MQLs kept out of the team rate.
