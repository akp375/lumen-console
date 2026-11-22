/**
 * Fills the health-score inputs for Cockpit (built for Lumen AI) from the data
 * already in Supabase, without a reseed.
 *
 *   npm run health-inputs:backfill -- --dry-run   build everything and print a summary; writes nothing
 *   npm run health-inputs:backfill                write it
 *
 * Writes only:
 *   - team: added or updated by id
 *   - accounts.csm_id (no other account column)
 *   - opportunities.ae_id, adr_id, csm_id (no other deal column)
 *   - cs_activities: added or updated by id (never deleted)
 *   - support_tickets.csat_score on closed tickets (no other ticket column)
 *
 * Run `npm run health-inputs:check` before and after to prove no existing value moved.
 * Needs supabase/migrations/20261122000000_add_health_inputs_and_team.sql.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import type { AccountRow } from "../src/lib/metrics.ts";
import { buildHealthInputs, healthInputsFingerprint, type HealthInputs } from "./health-inputs-lib.ts";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local. Nothing was written.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;
async function readAll(table: string, columns: string, orderBy: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns);
    for (const c of orderBy) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}. Nothing was written.`);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

/** Sets one column value on many rows at once, 200 ids per request. Touches no other column. */
async function setWhereIn(table: string, values: Row, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db.from(table).update(values).in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`Updating ${table} failed: ${error.message}`);
  }
}

function groupBy<T>(items: [string, T][], keyOf: (v: T) => string): Map<string, { value: T; ids: string[] }> {
  const out = new Map<string, { value: T; ids: string[] }>();
  for (const [id, v] of items) {
    const k = keyOf(v);
    const g = out.get(k) ?? { value: v, ids: [] };
    g.ids.push(id);
    out.set(k, g);
  }
  return out;
}

function summarize(h: HealthInputs, accounts: AccountRow[], tickets: Row[]) {
  const name = new Map(h.team.map((t) => [t.id, t.name]));
  const count = <T>(xs: T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());
  const fmt = (m: Map<string, number>) => [...m].map(([k, n]) => `${n} ${k}`).join(", ");

  console.log(`Team: ${h.team.length} people (${fmt(count(h.team.map((t) => t.role)))})`);
  if (h.unknownOwners.length) console.log(`  WARNING: account owners not on the team: ${h.unknownOwners.join(", ")}`);

  const status = new Map(accounts.map((a) => [a.id, a.status]));
  const csmLoad = count([...h.accountCsm].filter(([id, c]) => c && status.get(id) === "customer").map(([, c]) => name.get(c!)!));
  console.log(`CSM per customer: ${fmt(csmLoad)}`);
  console.log(`Accounts with a CSM: ${[...h.accountCsm.values()].filter(Boolean).length} (customers and churned); prospects: none`);

  const deals = [...h.dealOwners.values()];
  console.log(`Deals: ${deals.length}; with an AE ${deals.filter((d) => d.ae_id).length}, with an ADR ${deals.filter((d) => d.adr_id).length}, with a CSM ${deals.filter((d) => d.csm_id).length}`);

  const customerTiers = [...h.tiers].filter(([id]) => status.get(id) === "customer").map(([, t]) => t);
  console.log(`Customer tiers (seeding only): ${fmt(count(customerTiers))}`);

  console.log(`CS activities: ${h.activities.length} (${fmt(count(h.activities.map((a) => a.type)))})`);
  const closed = tickets.filter((t) => t.status === "closed").length;
  console.log(`CSAT: ${h.csat.size} of ${closed} closed tickets rated (${Math.round((h.csat.size / closed) * 100)}%); scores ${fmt(count([...h.csat.values()].sort().map(String)))}`);

  // Spot check: what the relationship inputs look like by tier, as of today
  const byAcc = new Map<string, typeof h.activities>();
  for (const a of h.activities) byAcc.set(a.account_id, [...(byAcc.get(a.account_id) ?? []), a]);
  const daysAgo = (d: string) => Math.round((Date.parse(AS_OF_DATE) - Date.parse(d)) / 86_400_000);
  console.log("\nBy tier, customers only (median days since last call/meeting/QBR/exec; share with an exec touch in 90 days):");
  for (const tier of ["healthy", "middle", "declining-quiet", "declining-burst"]) {
    const ids = [...h.tiers].filter(([id, t]) => t === tier && status.get(id) === "customer").map(([id]) => id);
    if (!ids.length) continue;
    const last = ids
      .map((id) => (byAcc.get(id) ?? []).filter((x) => x.type !== "email").map((x) => x.activity_date).sort().at(-1))
      .map((d) => (d ? daysAgo(d) : 999))
      .sort((a, b) => a - b);
    const exec = ids.filter((id) => (byAcc.get(id) ?? []).some((x) => x.attendee_level === "executive" && daysAgo(x.activity_date) <= 90)).length;
    console.log(`  ${tier.padEnd(16)} ${String(ids.length).padStart(3)} accounts, last touch ${last[Math.floor(last.length / 2)]} days, exec in 90 days ${Math.round((exec / ids.length) * 100)}%`);
  }
}

async function main() {
  console.log(`Health-inputs backfill (as of ${AS_OF_DATE})${dryRun ? ": DRY RUN, nothing is written" : ""}\n`);
  if (!dryRun && !existsSync("reconciliation/health-inputs-before.json")) {
    throw new Error("No before snapshot. Run `npm run health-inputs:check -- --save-before` first. Nothing was written.");
  }

  const [accRows, oppRows, ticketRows, usageRows, npsRows] = await Promise.all([
    readAll("accounts", "id, name, status, segment, mrr_usd, included_tokens_monthly, start_date, renewal_date, churn_date, owner", ["id"]),
    readAll("opportunities", "id, account_id, type, source", ["id"]),
    readAll("support_tickets", "id, account_id, opened_at, closed_at, severity, status", ["id"]),
    readAll("usage_daily", "account_id, date, model, input_tokens, output_tokens", ["account_id", "date", "feature", "model"]),
    readAll("nps_responses", "account_id, responded_at, score", ["id"]),
  ]);
  const accounts: AccountRow[] = accRows.map((a) => ({
    id: String(a.id),
    name: String(a.name),
    status: a.status as AccountRow["status"],
    segment: String(a.segment),
    mrr_usd: Number(a.mrr_usd),
    included_tokens_monthly: Number(a.included_tokens_monthly),
    start_date: (a.start_date as string | null) ?? null,
    renewal_date: (a.renewal_date as string | null) ?? null,
    churn_date: (a.churn_date as string | null) ?? null,
    owner: String(a.owner),
  }));
  const h = buildHealthInputs({
    accounts,
    opportunities: oppRows.map((o) => ({ id: String(o.id), account_id: String(o.account_id), type: String(o.type), source: String(o.source) })),
    tickets: ticketRows.map((t) => ({
      id: String(t.id),
      account_id: String(t.account_id),
      opened_at: String(t.opened_at),
      closed_at: (t.closed_at as string | null) ?? null,
      severity: String(t.severity),
      status: String(t.status),
    })),
    usage: usageRows.map((u) => ({
      account_id: String(u.account_id),
      date: String(u.date).slice(0, 10),
      model: String(u.model),
      input_tokens: Number(u.input_tokens),
      output_tokens: Number(u.output_tokens),
    })),
    nps: npsRows.map((n) => ({ account_id: String(n.account_id), responded_at: String(n.responded_at), score: Number(n.score) })),
    asOf: AS_OF_DATE,
  });

  summarize(h, accounts, ticketRows);
  console.log(`\nHealth-inputs fingerprint: ${healthInputsFingerprint(h)} (npm run seed -- --dry-run prints the same code for the same data)`);
  if (h.unknownOwners.length) throw new Error("Some account owners aren't on the team. Nothing was written.");

  if (dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  console.log("\nWriting...");
  const { error: teamError } = await db.from("team").upsert(h.team, { onConflict: "id" });
  if (teamError) throw new Error(`Writing team failed: ${teamError.message}`);
  console.log(`  team: ${h.team.length} rows`);

  for (const { value, ids } of groupBy([...h.accountCsm], (v) => String(v)).values()) await setWhereIn("accounts", { csm_id: value }, ids);
  console.log(`  accounts.csm_id: ${h.accountCsm.size} accounts`);

  for (const { value, ids } of groupBy([...h.dealOwners], (v) => JSON.stringify(v)).values()) await setWhereIn("opportunities", value, ids);
  console.log(`  opportunities.ae_id / adr_id / csm_id: ${h.dealOwners.size} deals`);

  for (let i = 0; i < h.activities.length; i += 500) {
    const { error } = await db.from("cs_activities").upsert(h.activities.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`Writing cs_activities failed: ${error.message}`);
  }
  const built = new Set(h.activities.map((a) => a.id));
  const existing = await readAll("cs_activities", "id", ["id"]);
  const extra = existing.filter((x) => !built.has(String(x.id))).length;
  console.log(`  cs_activities: ${h.activities.length} rows${extra ? ` (${extra} older rows not in this build were left in place)` : ""}`);

  for (const { value, ids } of groupBy([...h.csat], (v) => String(v)).values()) await setWhereIn("support_tickets", { csat_score: value }, ids);
  console.log(`  support_tickets.csat_score: ${h.csat.size} closed tickets`);
  console.log("Done. Now run: npm run health-inputs:check");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
