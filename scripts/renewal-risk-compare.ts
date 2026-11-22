/**
 * Renewal-risk before/after for Cockpit (built for Lumen AI). Read-only: it never writes to Supabase.
 *
 *   npm run renewal-risk:compare -- --save-before   save today's High and Medium lists (reconciliation/renewal-risk-before.json)
 *   npm run renewal-risk:compare                    print today's lists and compare with the saved "before"
 *
 * Every level and reason comes from src/lib/metrics.ts (getRenewalRisk). This script recomputes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { getRenewalRisk } from "../src/lib/metrics.ts";

const SNAPSHOT = "reconciliation/renewal-risk-before.json";
type Entry = { name: string; segment: string; level: string; reasons: string[]; renewalDate: string; daysToRenewal: number; arr: number };
type Snapshot = { asOf: string; takenAt: string; rows: Record<string, Entry> };

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

async function main() {
  const risk = await getRenewalRisk(AS_OF_DATE);
  const now: Snapshot = {
    asOf: AS_OF_DATE,
    takenAt: new Date().toISOString(),
    rows: Object.fromEntries(
      risk.rows
        .filter((r) => r.level !== "Low")
        .map((r) => [
          r.accountId,
          { name: r.name, segment: r.segment, level: r.level, reasons: [...r.reasons], renewalDate: r.renewalDate, daysToRenewal: r.daysToRenewal, arr: r.arr },
        ]),
    ),
  };

  const print = (title: string, s: Snapshot) => {
    for (const level of ["High", "Medium"]) {
      const list = Object.entries(s.rows).filter(([, e]) => e.level === level).sort(([, a], [, b]) => a.daysToRenewal - b.daysToRenewal);
      console.log(`${title} ${level}: ${list.length} (${usd(list.reduce((t, [, e]) => t + e.arr, 0))} ARR)`);
      for (const [id, e] of list) console.log(`  ${id} ${e.name} (${e.segment}, renews in ${e.daysToRenewal} days, ${usd(e.arr)}): ${e.reasons.join(", ")}`);
    }
  };

  if (process.argv.includes("--save-before")) {
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + "\n");
    print("Before", now);
    console.log(`\nSaved as the "before" snapshot: ${SNAPSHOT}`);
    return;
  }
  if (!existsSync(SNAPSHOT)) throw new Error(`No before snapshot. Run with --save-before first.`);
  const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  print("Before", before);
  console.log("");
  print("After", now);

  console.log("\nChanged level (Low = not flagged):");
  const ids = [...new Set([...Object.keys(before.rows), ...Object.keys(now.rows)])].sort();
  let n = 0;
  for (const id of ids) {
    const b = before.rows[id];
    const a = now.rows[id];
    if ((b?.level ?? "Low") === (a?.level ?? "Low")) continue;
    n++;
    const e = (a ?? b)!;
    console.log(`  ${id} ${e.name} (${e.segment}, renews in ${e.daysToRenewal} days): ${b?.level ?? "Low"} -> ${a?.level ?? "Low"}`);
    console.log(`      before: ${b ? b.reasons.join(", ") : "no signs"}`);
    const low = risk.all.find((r) => r.accountId === id);
    const why = low
      ? low.inWindow
        ? `health ${low.healthScore}, no other condition met`
        : `renewal in ${low.daysToRenewal} days is outside the ${low.segment} window (${low.windowDays} days); health ${low.healthScore}`
      : "not a customer with a renewal date";
    console.log(`      after:  ${a ? `${a.reasons.join(", ")} (health ${risk.all.find((r) => r.accountId === id)?.healthScore})` : `Low: ${why}`}`);
  }
  if (n === 0) console.log("  none");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
