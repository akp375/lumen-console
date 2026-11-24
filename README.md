# Cockpit

A RevOps cockpit built for **Lumen AI**, a fictional 40-person AI startup with about $3M ARR and 150 customer accounts. All data is synthetic. (The repo and package are named `lumen-console`.)

## The problem

At an AI-native company, the numbers that decide whether an account is healthy are spread across three systems:

- **Revenue** is in billing.
- **Pipeline** is in the CRM.
- **Cost** is in LLM token usage, which changes every day.

A customer can renew on time and still lose money on every token. Leads can sit untouched for days while the dashboard looks fine. The ADR and CS teams rarely see these problems in the CRM they work from every day.

Cockpit joins those sources, turns them into a short list of signals, and pushes the signals into HubSpot, where the teams already work.

## What it does

**For the ADR team (Pipeline)**
- **ADR Hygiene:** unassigned leads, MQLs past the 24-hour SLA, stale Qualifying deals, handoff leaks, ADR–AE pairing mismatches and wrong account tags. Each list is oldest first.
- **ADR Insights:**
  - the funnel by lead source
  - speed to lead per ADR
  - which sequences book meetings
  - a memo for the ADR manager, written by Claude
- **AI agent:** investigates this week's pipeline leaks with read-only tools. It then proposes fixes: reassign leads, pause a sequence, or create a HubSpot task. Nothing happens until a person approves.
- **Deal Risk:** open deals this quarter and next, with rule-based flags and Claude's next steps.

**For the CS team (Customer Success)**
- **Health:** a weekly health score for every customer, its trend, and the products losing adoption.
- **Renewals:**
  - renewal risk
  - downsell risk inside each segment's renewal window
  - contracts with no renewal deal
  - Claude's reason and next action for each risky renewal
- **Account pages:**
  - health
  - products and adoption
  - renewal deals
  - the risk rule shown condition by condition
  - "What customers are saying": topics and word-for-word quotes that Claude tagged from support tickets and CSM notes

**Into HubSpot**
- **What syncs:**
  - companies, with health, renewal risk, margin and flags
  - deals in their pipelines, including a Qualifying stage that isn't forecasted
  - ADR leads as contacts, with ADR owner, lead stage and the SLA and unassigned flags
- **Agent actions:** an approved reassignment updates the contacts in HubSpot. An approved task lands on the deal and its company, and is never created twice.

## Architecture

```
Supabase Postgres ──▶ metrics engine (src/lib/metrics.ts) ──▶ Next.js pages
   (accounts, deals,        one place for all business math        │
    leads, usage,                    │                             ▼
    invoices, texts)                 ├──▶ HubSpot sync (companies, deals, contacts, tasks)
                                     │
                                     └──▶ Claude (Anthropic API): memo, agent,
                                          flag reasons, topic tagging, chat
```

- **Stack:** Next.js App Router, TypeScript, Tailwind, Recharts, Supabase Postgres, Anthropic SDK. Deployed on Vercel.
- **One metrics engine:**
  - Every business number comes from `src/lib/metrics.ts`.
  - Pages, the HubSpot sync, the memo and the agent's tools all read the same functions, so they never disagree.
  - HubSpot is a destination for numbers, never a source. It is read only for work state such as tasks and owners.
- **A fixed "today":** analysis uses one as-of date (`src/lib/as-of-date.ts`), so the demo numbers don't drift. Work state in HubSpot, such as task due dates, uses the real calendar.
- **One Claude wrapper:**
  - Every call goes through `src/lib/claude.ts`.
  - Each call is logged to `llm_calls` with model, tokens, cost and latency.
  - The Integrations page shows spend by feature, and every AI section shows its model and cost.

## Safety design

- **Grounding checks:** the ADR memo and the agent's summary are checked number by number. Every number and date must appear in the data Claude was given, or in the agent's tool results. Anything unsupported is highlighted on the page.
- **Approval before action:**
  - The agent can only read. Each change it wants is saved as a proposal.
  - A named person approves or rejects each proposal. Who decided, and when, is recorded.
  - Approved reassignments and pauses can be undone with `npm run agent:reset`.
  - Approving is only possible when the app runs locally.
- **Cost caps:**
  - a daily Claude budget across the app
  - per run, the agent stops at 8 tool calls, 3 proposals and $0.50
  - output token and time limits on each call
  - one agent run at a time
- **Evals and tests:**
  - 146 unit tests: metrics, grounding, the agent loop with Claude mocked, approvals and reverts, and HubSpot mapping.
  - Reconciliation scripts (`adr:check`, `contracts:check`, `health-inputs:check`, `text:check`) compare the computed numbers with what the synthetic data planted.
  - `signals:eval` draws a fixed sample of topic tags for a person to mark right or wrong.
- **Data rules:**
  - Row Level Security is on for every table.
  - API keys stay server-side. No secret uses the `NEXT_PUBLIC_` prefix.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
npm run adr:check  # one of the reconciliation checks
```

It needs a `.env.local` with Supabase, Anthropic and HubSpot keys (not in the repo).

## What's next

- **Logins and roles:** approvals become tied to the signed-in person, so they can run outside local development.
- **A daily AI briefing** for the CS team that covers health changes, renewal risk and expansion flags.
- **Live connectors** to replace the synthetic data: billing, product usage and the support desk.
- **Salesforce and Gainsight** alongside HubSpot: accounts and opportunities, health scorecards and renewal CTAs.
- **Scheduled agent runs** with proposals delivered in HubSpot, and agent evals on a fixed set of past weeks.
