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

## Product

**Lumen Console** is a RevOps app for AI-native startups. It joins CRM pipeline, billing and LLM token usage to show margin, health and renewal risk per account.

**Demo company:** Lumen AI, a fictional 40-person AI startup with about $3M ARR and 150 customer accounts. All data is synthetic.

**Modules:**

1. Console views
2. Ask RevOps agent, using Claude tool use
3. Health & Renewals: health scores, renewal-risk and expansion flags, and a daily AI briefing

## Stack

Next.js App Router, TypeScript, Tailwind, Recharts, Supabase Postgres, Anthropic SDK, deployed on Vercel.

## Build rules

- All business math lives in `lib/metrics.ts`. Nothing else recomputes it.
- Use CRM-standard names (accounts, opportunities, stages, renewal dates) that map cleanly to HubSpot or Salesforce.
- Every Claude API call goes through one wrapper that logs model, tokens, cost and latency to the `llm_calls` table.
- API keys are used server-side only. No secret ever uses the `NEXT_PUBLIC_` prefix.
- Row Level Security stays on for every table.
- The Ask RevOps agent answers only from tool results.
