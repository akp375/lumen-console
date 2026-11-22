/**
 * Writes the weekly health-score snapshots for Cockpit (built for Lumen AI)
 * into health_scores. (Renewal-risk before/after: npm run renewal-risk:compare.)
 *
 *   npm run health:backfill -- --dry-run   compute and print; writes nothing
 *   npm run health:backfill                write the snapshots
 *
 * Snapshots: 6 weeks, as of AS_OF_DATE and each 7 days before it, for every
 * customer who had started by that date. week_start holds the snapshot date.
 * Rows are added or updated by (account_id, week_start), so it can be re-run.
 *
 * Every number comes from src/lib/metrics.ts (calcHealthTrend, the same code
 * the pages use). This script recomputes nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { HEALTH_CATEGORIES, calcHealthScores, calcHealthTrend, healthSnapshotDates, loadHealthInputs } from "../src/lib/metrics.ts";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local. Nothing was written.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log(`Health snapshots (as of ${AS_OF_DATE})${dryRun ? ": DRY RUN, nothing is written" : ""}\n`);
  const input = await loadHealthInputs(AS_OF_DATE);
  const dates = healthSnapshotDates(AS_OF_DATE);
  const trend = calcHealthTrend(input, AS_OF_DATE);

  // Distribution per week
  console.log("Week        Customers  Green  Amber  Red   Average");
  const rows: Record<string, unknown>[] = [];
  for (const d of dates) {
    const scores = calcHealthScores(input, d);
    const band = (b: string) => scores.filter((s) => s.band === b).length;
    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    console.log(`${d}  ${String(scores.length).padStart(9)}  ${String(band("green")).padStart(5)}  ${String(band("amber")).padStart(5)}  ${String(band("red")).padStart(4)}  ${avg.toFixed(1).padStart(7)}`);
    for (const s of scores) {
      rows.push({
        account_id: s.accountId,
        week_start: d,
        score: s.score,
        usage_trend: null, // not an account-level input any more: adoption is per contract line (behavioral_points)
        capacity_used: null,
        support_load: s.inputs.openLowOrMedium + s.inputs.openHighOrUrgent,
        sentiment: s.inputs.latestNps,
        ...Object.fromEntries(HEALTH_CATEGORIES.map((c) => [`${c}_points`, s.points[c]])),
      });
    }
  }

  // Category averages today
  console.log("\nAverage points today (of the maximum):");
  const max = { behavioral: 35, relationship: 20, feedback: 20, support: 15, financial: 10 } as const;
  for (const c of HEALTH_CATEGORIES) {
    const avg = trend.reduce((s, r) => s + r.points[c], 0) / trend.length;
    console.log(`  ${c.padEnd(13)} ${avg.toFixed(1).padStart(5)} of ${max[c]}`);
  }

  const declining = trend.filter((r) => r.declining);
  const poor = trend.filter((r) => r.score < 50);
  console.log(`\nDeclining (down 10+ on last week): ${declining.length}`);
  for (const r of declining) console.log(`  ${r.accountId} ${r.name}: ${r.history.map((h) => h.score.toFixed(0)).join(" -> ")} (${r.change})`);
  console.log(`Below 50 today: ${poor.length}`);
  for (const r of poor) console.log(`  ${r.accountId} ${r.name}: ${r.score}`);

  if (dryRun) {
    console.log(`\nDry run: ${rows.length} snapshot rows would be written.`);
    return;
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("health_scores").upsert(rows.slice(i, i + 500), { onConflict: "account_id,week_start" });
    if (error) throw new Error(`Writing health_scores failed: ${error.message}`);
  }
  console.log(`\nWrote ${rows.length} rows to health_scores.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
