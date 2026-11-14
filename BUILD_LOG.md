# Build Log: Lumen Console

## 2026-11-13 (Friday)

### Highlight: getting past the GitHub login

**The challenge.** The project was ready on this Mac, but the first `git push` to GitHub (`akp375/lumen-console`) needed us to sign in from the command line. GitHub no longer accepts an account password for `git push`, so typing the normal GitHub password fails even when it is correct.

**How we solved it.**

1. **Generated a personal access token** inside the GitHub account settings.
2. **Saved the token in Passwords** (the Mac password manager), so it is stored safely and never sits in a project file or chat.
3. **Connected through the Terminal:** when `git push` asked for a password, we pasted the token instead of the GitHub password.
4. Git on this Mac stores that sign-in in the **macOS Keychain** (`osxkeychain`), so later pushes go through without asking again.
5. Both pushes worked. `main` and `dev` are on GitHub, and each local branch is linked to its GitHub copy.

**Lesson.** If a push ever asks for a password again, the token has probably expired or been revoked. Make a new token on GitHub and enter it when asked. Never paste the token into chat or into a project file.

### Other work today

- **Project set up** (`a841d60`): new Next.js app with Supabase, the Anthropic SDK and Recharts. This first commit went to `main`.
- **`dev` branch created**: all work from here on happens on `dev`.
- **Safety rules added** (`d3e31c4`): `CLAUDE.md` now covers no `sudo`, no deleting files, no global installs, staying inside the project folder, keeping `.env.local` private and protecting `main`.
- **Rebranded** (`ede1ece`): the app header and browser tab title now say "Lumen Console".
- **Product brief added to `CLAUDE.md`**: it covers the product, the demo company (Lumen AI), the three modules, the stack, the build rules and the working style. The safety rules stay in place.
- **Started this build log** (`aaffcf2`).

### Data model and demo data (live in Supabase)

- **Database tables:** wrote the migration `supabase/migrations/20261113000000_create_core_tables.sql`. It creates the 11 tables from the data model reference, with Row Level Security on for every table. The owner ran it in the Supabase SQL Editor (pasted by hand, which needed no installs or extra passwords).
- **Seeded Supabase:** the owner ran `npm run seed`. Every table was written without errors: 190 accounts, 3 model prices, 140 opportunities, 1,901 invoices, 38,394 usage rows, 957 support tickets and 173 NPS responses. Data fingerprint `4cecab8bbd52`, matching the dry run.
- **Environment variable fix:** the seed first looked for `NEXT_PUBLIC_SUPABASE_URL`, but `.env.local` uses `SUPABASE_URL`. Changed the seed to read `SUPABASE_URL`, which keeps everything server-side.
- **Decisions made on the data model:**
  - `accounts` has a `status` (prospect, customer, churned) and a `churn_date`.
  - Opportunities use the stages Discovery, Demo, Proposal, Negotiation, Closed Won and Closed Lost. Each deal also has a `forecast_category` (Pipeline, Best Case, Commit, Closed, Omitted) and a `created_date`.
  - `nps_responses`, `expansion_plays`, `briefings` and `llm_calls` got an `id` column.
  - `health_scores`, `expansion_plays`, `briefings` and `llm_calls` are created empty. The app fills them later.
- **As-of date:** added `src/lib/as-of-date.ts`, which fixes "today" at 2026-11-13. Changing that one value and re-running the seed moves all the data forward.
- **Seed script:** wrote `scripts/seed.ts` (run with `npm run seed`, or `npm run seed -- --dry-run` to preview). It uses a fixed random seed, so the data and IDs are identical on every run. A re-seed updates accounts in place and never deletes them.
- **Demo data, as reported by the seed's self-check:**
  - 150 customers, 30 prospects and 10 accounts that churned in the last 6 months.
  - About $3.07M ARR, with the top 10 customers making up 35% of it.
  - 90 days of usage.
  - 12 accounts whose token cost is more than 70% of their revenue, 15 with usage down more than 20%, and 15 over their included tokens.
  - 60 open deals, and 80 closed deals from the last 6 months with a 27.5% win rate.
  - 12-month net revenue retention (NRR) of 108.2%.
- **New rules added to `CLAUDE.md`:**
  - Metrics use the as-of date, not the real clock.
  - Pipeline metrics count open deals only.
  - Customer metrics count accounts with status `customer` only, unless a metric such as NRR needs churned accounts.
