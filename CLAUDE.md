# Rules for working in lumen-console

## Working style

The owner is a RevOps and strategy lead acting as product owner. The tool is also intended to be used by ops leads. Work in small steps, explain decisions in plain English, and give exact click-or-run instructions.

## Hard rules (never break these)

- Never run `sudo`.
- Never delete with `rm` or `rm -rf`, even inside this folder. If something needs deleting, explain what and why, and ask the owner first.
- Never install anything globally: no `npm install -g`, no `brew install`, no system-wide installers.
- Only install packages the owner has asked for.
- Never read, create, change or delete anything outside `/Users/a/projects/lumen-console`. If a task seems to need that, stop and ask instead of finding a workaround.
- Never print, copy or send the contents of `.env.local` (it holds secret keys).
- Ask the owner before running any command you're unsure about.

## Git

- All work happens on the `dev` branch.
- Never commit to, merge into or push `main` unless the owner explicitly says so.
- GitHub's default branch is `dev`, so work pushed to `dev` already counts on GitHub (including the contribution graph). Never suggest merging into `main` for that reason; merge only when the owner asks.

## Product

**Cockpit** is the RevOps app we are building for our client, Lumen AI (an AI-native startup). It has no product name of its own: it is a build-out for Lumen AI. The code folder, GitHub repo and package keep the name `lumen-console`. It joins CRM pipeline, billing and LLM token usage to show margin, health and renewal risk per account.

**Demo company:** Lumen AI, a fictional 40-person AI startup with about $3M ARR and 150 customer accounts. All data is synthetic.

**Modules:**

1. Console views
2. Ask RevOps agent, using Claude tool use
3. Health & Renewals: health scores, renewal-risk and expansion flags, and a daily AI briefing

## Stack

Next.js App Router, TypeScript, Tailwind, Recharts, Supabase Postgres, Anthropic SDK, deployed on Vercel.

## Build rules

- All business math lives in `lib/metrics.ts` (in this project: `src/lib/metrics.ts`). Nothing else recomputes it.
- Business numbers (revenue, pipeline, usage, margin, health, risk) always come from lib/metrics.ts (Supabase). Operational figures about running the app, such as Claude spend and seed dates, may be read directly by claude.ts and integrations.ts. HubSpot is the source only for work state such as tasks, notes, owners and lead status. Never read a number from HubSpot to show in the app.
- "Today" is the as-of date in `src/lib/as-of-date.ts` (`AS_OF_DATE`). `lib/metrics.ts`, and anything else that needs today's date for a metric, uses it instead of the real clock (`new Date()`, `Date.now()`, or `now()` / `current_date` in SQL), so the numbers never drift. To move all data forward, change that one value and re-run `npm run seed`.
- Customer metrics (ARR, margin, health, renewals) count accounts with status `customer` only, unless a metric specifically needs churned accounts, such as NRR. Prospects never count toward customer metrics.
- Pipeline metrics count open opportunities only: stages Discovery, Demo, Proposal and Negotiation. Closed Won and Closed Lost are excluded.
- Use CRM-standard names (accounts, opportunities, stages, renewal dates) that map cleanly to HubSpot or Salesforce.
- Every Claude API call goes through one wrapper that logs model, tokens, cost and latency to the `llm_calls` table.
- API keys are used server-side only. No secret ever uses the `NEXT_PUBLIC_` prefix.
- Row Level Security stays on for every table.
- The Ask RevOps agent answers only from tool results.
