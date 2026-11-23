/**
 * Reconciliation for the free text on tickets and CSM activities in Cockpit,
 * built for Lumen AI. Read-only: it never writes to Supabase.
 *
 *   npm run text:check                  print the checks, and compare with the saved "before" snapshot if there is one
 *   npm run text:check -- --save-before save this run as the "before" snapshot (reconciliation/text-before.json)
 *
 * Part 1 (must not change): every existing column of every existing table,
 * fingerprinted row by row (the new description and note columns are left out),
 * plus total ARR, every customer's health score and renewal-risk level, and the
 * High-risk list.
 *
 * Part 2 (once the migration and backfill have run): the stored text equals what
 * scripts/text-lib.ts builds, every non-email activity has a note, emails have
 * none, every ticket has a description, competitor names come from the agreed
 * list, and risky topics are concentrated in declining accounts.
 *
 * Numbers come from src/lib/metrics.ts or straight from the tables; this script
 * recomputes no business math.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { getArr, getHealth, getRenewalRisk } from "../src/lib/metrics.ts";
import { loadTextInputs, textMix } from "./text-backfill.ts";
import { buildTexts, COMPETITORS, textsFingerprint } from "./text-lib.ts";

const SNAPSHOT = "reconciliation/text-before.json";

const TABLES: Record<string, string[]> = {
  accounts: ["id"],
  opportunities: ["id"],
  invoices: ["account_id", "month"],
  usage_daily: ["account_id", "date", "feature", "model"],
  model_prices: ["model"],
  support_tickets: ["id"],
  nps_responses: ["id"],
  contract_lines: ["id"],
  cs_activities: ["id"],
  team: ["id"],
  health_scores: ["account_id", "week_start"],
};
const NEW_COLUMNS: Record<string, string[]> = { support_tickets: ["description"], cs_activities: ["note"] };

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;

async function readAll(table: string, columns: string, orderBy: string[]): Promise<Row[] | null> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns);
    for (const c of orderBy) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) {
      const missing = error.code === "PGRST205" || error.code === "42P01" || error.code === "42703" || /does not exist|Could not find/i.test(error.message);
      if (missing) return null;
      throw new Error(`Reading ${table} failed: ${error.message}`);
    }
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

const hash = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
const ok = (pass: boolean) => (pass ? "PASS" : "FAIL");
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function rowLine(table: string, r: Row): string {
  const drop = new Set(NEW_COLUMNS[table] ?? []);
  return Object.keys(r)
    .filter((c) => !drop.has(c))
    .sort()
    .map((c) => `${c}=${JSON.stringify(r[c])}`)
    .join("|");
}

type TableFingerprint = { rows: number; columns: string[]; fingerprint: string };
type Snapshot = {
  asOf: string;
  takenAt: string;
  totalArr: number;
  customerCount: number;
  highRisk: string[];
  riskLevel: Record<string, string>;
  healthScore: Record<string, number>;
  tables: Record<string, TableFingerprint>;
};

async function takeSnapshot(): Promise<{ snap: Snapshot; data: Record<string, Row[]> }> {
  const [arr, risk, health] = await Promise.all([getArr(), getRenewalRisk(AS_OF_DATE), getHealth(AS_OF_DATE)]);
  const data: Record<string, Row[]> = {};
  const tables: Record<string, TableFingerprint> = {};
  for (const [table, order] of Object.entries(TABLES)) {
    const rows = await readAll(table, "*", order);
    if (rows === null) throw new Error(`Table ${table} could not be read`);
    data[table] = rows;
    const drop = new Set(NEW_COLUMNS[table] ?? []);
    const columns = rows.length ? Object.keys(rows[0]).filter((c) => !drop.has(c)).sort() : [];
    tables[table] = { rows: rows.length, columns, fingerprint: hash(rows.map((r) => rowLine(table, r))) };
  }
  return {
    snap: {
      asOf: AS_OF_DATE,
      takenAt: new Date().toISOString(),
      totalArr: arr.totalArr,
      customerCount: arr.customerCount,
      highRisk: risk.all.filter((r) => r.level === "High").map((r) => `${r.accountId} ${r.name}`).sort(),
      riskLevel: Object.fromEntries(risk.all.map((r) => [r.accountId, r.level])),
      healthScore: Object.fromEntries(health.rows.map((r) => [r.accountId, Math.round(r.score * 100) / 100])),
      tables,
    },
    data,
  };
}

function compareMap(label: string, before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  console.log(`  ${ok(diffs.length === 0)}  ${label}: ${keys.size} compared, ${diffs.length} changed`);
  for (const k of diffs.slice(0, 10)) console.log(`        ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
  return diffs.length === 0;
}

function check(label: string, bad: string[]): boolean {
  console.log(`  ${ok(bad.length === 0)}  ${label}${bad.length ? `: ${bad.length} break the rule` : ""}`);
  for (const b of bad.slice(0, 8)) console.log(`        ${b}`);
  return bad.length === 0;
}

async function main() {
  const saveBefore = process.argv.includes("--save-before");
  console.log(`Text reconciliation (as of ${AS_OF_DATE}). Read-only.\n`);
  const { snap, data } = await takeSnapshot();

  console.log("Part 1: what must not change");
  console.log(`  Total ARR:        ${usd(snap.totalArr)} (${snap.customerCount} customers)`);
  console.log(`  High-risk:        ${snap.highRisk.length} (${snap.highRisk.join(", ")})`);
  for (const [t, f] of Object.entries(snap.tables)) console.log(`  ${t.padEnd(16)}  ${String(f.rows).padStart(6)} rows, ${f.columns.length} columns, fingerprint ${f.fingerprint}`);

  if (saveBefore) {
    writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + "\n");
    console.log(`\n  Saved as the "before" snapshot: ${SNAPSHOT}`);
  } else if (existsSync(SNAPSHOT)) {
    const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
    console.log(`\n  Compared with the "before" snapshot taken ${before.takenAt}:`);
    const results = [
      (() => { const p = before.totalArr === snap.totalArr; console.log(`  ${ok(p)}  Total ARR: ${usd(before.totalArr)} -> ${usd(snap.totalArr)}`); return p; })(),
      compareMap("Health scores", before.healthScore, snap.healthScore),
      compareMap("Renewal-risk levels", before.riskLevel, snap.riskLevel),
      (() => { const p = JSON.stringify(before.highRisk) === JSON.stringify(snap.highRisk); console.log(`  ${ok(p)}  High-risk list: ${before.highRisk.length} -> ${snap.highRisk.length}, same accounts: ${p ? "yes" : "no"}`); return p; })(),
      ...Object.keys(before.tables).map((t) => {
        const b = before.tables[t];
        const a = snap.tables[t];
        const p = a !== undefined && b.rows === a.rows && b.fingerprint === a.fingerprint && JSON.stringify(b.columns) === JSON.stringify(a.columns);
        console.log(`  ${ok(p)}  ${t}: ${b.rows} rows ${b.fingerprint} -> ${a?.rows} rows ${a?.fingerprint}`);
        return p;
      }),
    ];
    console.log(`  => ${results.every(Boolean) ? "Nothing changed." : "SOMETHING CHANGED: see FAIL lines."}`);
  }

  console.log("\nPart 2: the text");
  const tickets = data.support_tickets;
  const acts = data.cs_activities;
  if (!tickets.length || !("description" in tickets[0]) || !acts.length || !("note" in acts[0])) {
    console.log("  The description and note columns don't exist yet (run the migration first). Checks skipped.");
    return;
  }
  const input = await loadTextInputs();
  const built = buildTexts({ ...input, asOf: AS_OF_DATE });
  const stored = {
    descriptions: new Map(tickets.filter((t) => t.description).map((t) => [String(t.id), String(t.description)])),
    notes: new Map(acts.filter((a) => a.note).map((a) => [String(a.id), String(a.note)])),
    intended: built.intended,
  };
  const results = [
    check(`Stored text matches the builder (fingerprint ${textsFingerprint(stored)} vs ${textsFingerprint(built)})`, textsFingerprint(stored) === textsFingerprint(built) ? [] : ["fingerprints differ"]),
    check("Every ticket has a description", tickets.filter((t) => !t.description).map((t) => String(t.id))),
    check("Every call, meeting, QBR and exec meeting has a note", acts.filter((a) => a.type !== "email" && !a.note).map((a) => String(a.id))),
    check("Emails have no note", acts.filter((a) => a.type === "email" && a.note).map((a) => String(a.id))),
    check(
      `Competitor names only from the list (${COMPETITORS.join(", ")})`,
      [...built.intended].filter(([, i]) => i.topics.includes("competitor_mention") && (!i.competitor || !(COMPETITORS as readonly string[]).includes(i.competitor))).map(([k]) => k),
    ),
  ];
  const mix = textMix(built, input, AS_OF_DATE);
  const share = (tier: string) => mix.byTier.find((t) => t.tier === tier)!.riskyShare;
  const healthy = share("healthy");
  const declining = Math.min(share("declining-quiet"), share("declining-burst"));
  results.push(
    check(
      `Risky topics concentrated in declining accounts (last 180 days: healthy ${Math.round(healthy * 100)}%, declining ${Math.round(declining * 100)}%+)`,
      declining >= 4 * healthy ? [] : ["declining share is not at least 4x the healthy share"],
    ),
  );
  for (const [id, name] of [["acc_0089", "Ionic Retail"], ["acc_0013", "Copperleaf Media"]] as const) {
    const risky = [...built.intended].filter(([k, i]) => i.topics.length && (input.tickets.some((t) => `ticket:${t.id}` === k && t.account_id === id) || input.activities.some((a) => `activity:${a.id}` === k && a.account_id === id)));
    results.push(check(`${name} has clear examples (${risky.length} risky texts)`, risky.length >= 3 ? [] : ["fewer than 3"]));
  }
  console.log(`  => ${results.every(Boolean) ? "All text checks pass." : "SOME CHECKS FAILED: see FAIL lines."}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
