/**
 * Reconciliation for the ADR (account development) data in Cockpit, built for Lumen AI.
 * Read-only: it never writes to Supabase.
 *
 *   npm run adr:check                  print the checks, and compare with the saved "before" snapshot if there is one
 *   npm run adr:check -- --save-before save this run as the "before" snapshot (reconciliation/adr-before.json)
 *
 * Part 1 (must not change):
 *   - every existing column of every existing table, row by row (new columns are left out; for
 *     opportunities, only deals that existed before, so the new Stage 0.1 deals don't count);
 *   - what every page shows: the output of each page's loader in src/lib/metrics.ts (Overview,
 *     pipeline, win rate, upcoming deals, Deal Risk, Renewals, Health, the HubSpot sync values for
 *     existing records, and the Workspace data), compared as a fingerprint per section.
 * Part 2 (once the migration and backfill have run): the stored rows equal what scripts/adr-lib.ts
 * builds, and every planted problem is there.
 *
 * This script recomputes no business math.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import {
  getCrmSyncData,
  getDealRisk,
  getHealth,
  getHomePageData,
  getPipeline,
  getRenewalDeals,
  getRenewalRisk,
  getUpcomingDeals,
  getUpcomingRenewals,
  getWinRateAndCycle,
  getWorkspaceSnapshot,
} from "../src/lib/metrics.ts";
import { loadAdrInputs, adrSummary } from "./adr-backfill.ts";
import { buildAdrData, PAIRING_EFFECTIVE_FROM, SLA_HOURS, STALE_DAYS } from "./adr-lib.ts";

const SNAPSHOT = "reconciliation/adr-before.json";

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
const NEW_COLUMNS: Record<string, string[]> = { accounts: ["icp_tier", "target_account", "territory"], team: ["territory"] };
const isNewRow = (table: string, r: Row) => table === "opportunities" && r.stage === "Stage 0.1";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
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

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const ok = (pass: boolean) => (pass ? "PASS" : "FAIL");
const rowLine = (table: string, r: Row) => {
  const drop = new Set(NEW_COLUMNS[table] ?? []);
  return Object.keys(r).filter((c) => !drop.has(c)).sort().map((c) => `${c}=${JSON.stringify(r[c])}`).join("|");
};

type Snapshot = { asOf: string; takenAt: string; tables: Record<string, { rows: number; fingerprint: string }>; pages: Record<string, string> };

async function pageFingerprints(): Promise<Record<string, string>> {
  const [home, pipeline, win, upDeals, upRen, dealRisk, risk, health, renDeals, crm, ws] = await Promise.all([
    getHomePageData(AS_OF_DATE),
    getPipeline(),
    getWinRateAndCycle(AS_OF_DATE),
    getUpcomingDeals(AS_OF_DATE),
    getUpcomingRenewals(AS_OF_DATE),
    getDealRisk(AS_OF_DATE),
    getRenewalRisk(AS_OF_DATE),
    getHealth(AS_OF_DATE),
    getRenewalDeals(AS_OF_DATE),
    getCrmSyncData(AS_OF_DATE),
    getWorkspaceSnapshot(AS_OF_DATE),
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(home)) out[`Overview: ${k}`] = hash(JSON.stringify(v));
  out["Pipeline"] = hash(JSON.stringify(pipeline));
  out["Win rate and cycle"] = hash(JSON.stringify(win));
  out["Upcoming deals"] = hash(JSON.stringify(upDeals));
  out["Upcoming renewals"] = hash(JSON.stringify(upRen));
  out["Deal Risk"] = hash(JSON.stringify(dealRisk));
  out["Renewal risk"] = hash(JSON.stringify(risk));
  out["Health"] = hash(JSON.stringify(health));
  out["Renewal deals"] = hash(JSON.stringify(renDeals));
  // HubSpot sync values for existing records (the new Stage 0.1 deals are left out of the sync)
  out["HubSpot sync: accounts"] = hash(JSON.stringify(crm.accounts));
  out["HubSpot sync: existing deals"] = hash(JSON.stringify(crm.deals.filter((d) => d.stage !== "Stage 0.1")));
  for (const [k, v] of Object.entries(ws as Record<string, unknown>)) out[`Workspace data: ${k}`] = hash(JSON.stringify(v));
  return out;
}

async function main() {
  const saveBefore = process.argv.includes("--save-before");
  console.log(`ADR reconciliation (as of ${AS_OF_DATE}). Read-only.\n`);
  const data: Record<string, Row[]> = {};
  const tables: Snapshot["tables"] = {};
  for (const [t, order] of Object.entries(TABLES)) {
    const rows = await readAll(t, "*", order);
    if (rows === null) throw new Error(`Table ${t} could not be read`);
    data[t] = rows;
    const old = rows.filter((r) => !isNewRow(t, r));
    tables[t] = { rows: old.length, fingerprint: hash(old.map((r) => rowLine(t, r)).join("\n")) };
  }
  const snap: Snapshot = { asOf: AS_OF_DATE, takenAt: new Date().toISOString(), tables, pages: await pageFingerprints() };

  console.log("Part 1: what must not change");
  for (const [t, f] of Object.entries(snap.tables)) console.log(`  ${t.padEnd(16)} ${String(f.rows).padStart(6)} existing rows, fingerprint ${f.fingerprint}`);
  console.log(`  ${Object.keys(snap.pages).length} page sections fingerprinted`);
  if (saveBefore) {
    writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + "\n");
    console.log(`\n  Saved as the "before" snapshot: ${SNAPSHOT}`);
  } else if (existsSync(SNAPSHOT)) {
    const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
    console.log(`\n  Compared with the "before" snapshot taken ${before.takenAt}:`);
    const results = Object.keys(before.tables).map((t) => {
      const b = before.tables[t];
      const a = snap.tables[t];
      const p = b.rows === a.rows && b.fingerprint === a.fingerprint;
      console.log(`  ${ok(p)}  ${t}: ${b.rows} rows ${b.fingerprint} -> ${a.rows} rows ${a.fingerprint}`);
      return p;
    });
    const changed = Object.keys(before.pages).filter((k) => before.pages[k] !== snap.pages[k]);
    console.log(`  ${ok(changed.length === 0)}  Page sections: ${Object.keys(before.pages).length} compared, ${changed.length} changed`);
    for (const k of changed) console.log(`        changed: ${k}`);
    results.push(changed.length === 0);
    console.log(`  => ${results.every(Boolean) ? "Nothing changed." : "SOMETHING CHANGED: see FAIL lines."}`);
  }

  console.log("\nPart 2: the ADR data");
  const [leads, seqs, enr, pairs] = await Promise.all([
    readAll("leads", "*", ["id"]),
    readAll("sequences", "*", ["id"]),
    readAll("sequence_enrollments", "*", ["id"]),
    readAll("adr_ae_pairings", "*", ["adr_id", "ae_id"]),
  ]);
  if (!leads || !seqs || !enr || !pairs || !("icp_tier" in (data.accounts[0] ?? {}))) {
    console.log("  New tables or columns not created yet (run the migration first). Checks skipped.");
    return;
  }
  const input = await loadAdrInputs();
  const built = buildAdrData({ ...input, asOf: AS_OF_DATE });
  const same = (label: string, stored: Row[], expected: object[], key: (r: Row) => string) => {
    const want = new Map(expected.map((e) => [key(e as Row), e as Row]));
    const norm = (r: Row) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /T\d\d:\d\d:\d\d/.test(v) ? new Date(v).toISOString() : v]).sort()));
    const bad = stored.filter((r) => !want.has(key(r)) || norm(r) !== norm({ ...r, ...want.get(key(r)) }));
    const missing = [...want.keys()].filter((k) => !stored.some((r) => key(r) === k));
    const p = bad.length === 0 && missing.length === 0;
    console.log(`  ${ok(p)}  ${label}: ${stored.length} stored, ${expected.length} built${bad.length ? `, ${bad.length} differ (e.g. ${key(bad[0])})` : ""}${missing.length ? `, ${missing.length} missing` : ""}`);
    return p;
  };
  const stage01 = data.opportunities.filter((o) => o.stage === "Stage 0.1");
  const results = [
    same("Leads match the builder", leads, built.leads, (r) => String(r.id)),
    same("Sequences match", seqs, built.sequences, (r) => String(r.id)),
    same("Enrollments match", enr, built.enrollments, (r) => String(r.id)),
    same("ADR-AE pairings match", pairs, built.pairings, (r) => `${r.adr_id}|${r.ae_id}`),
    same("Stage 0.1 deals match", stage01, built.stage01Deals, (r) => String(r.id)),
    same("Account tags match", data.accounts.map((a) => ({ id: a.id, icp_tier: a.icp_tier, target_account: a.target_account, territory: a.territory })), [...built.accountTags].map(([id, t]) => ({ id, ...t })), (r) => String(r.id)),
  ];
  const check = (label: string, pass: boolean) => {
    console.log(`  ${ok(pass)}  ${label}`);
    results.push(pass);
  };
  const L = built.leads;
  const unassigned = L.filter((l) => !l.assigned_adr_id).length / L.length;
  check(`About 600 leads over the last 6 months (${L.length})`, L.length >= 560 && L.length <= 640);
  check(`About 8% unassigned (${Math.round(unassigned * 100)}%)`, unassigned >= 0.06 && unassigned <= 0.1);
  const mqls = L.filter((l) => l.mql_at);
  const missed = mqls.filter((l) => !l.first_touch_at || Date.parse(l.first_touch_at) - Date.parse(l.mql_at!) > SLA_HOURS * 3_600_000).length;
  check(`MQLs touched late or never (${missed} of ${mqls.length}, ${Math.round((missed / mqls.length) * 100)}%)`, missed / mqls.length >= 0.15);
  const conv = (src: string) => {
    const ls = L.filter((l) => l.lead_source === src);
    return ls.filter((l) => l.sql_at).length / ls.length;
  };
  check(`Conversion differs by source (lead->SQL: inbound demo ${Math.round(conv("inbound demo request") * 100)}%, outbound ${Math.round(conv("outbound") * 100)}%, content ${Math.round(conv("content download") * 100)}%)`, conv("inbound demo request") >= 3 * conv("outbound") && conv("outbound") > conv("content download"));
  const bounce = (id: string) => {
    const e = built.enrollments.filter((x) => x.sequence_id === id);
    return e.filter((x) => x.bounces > 0).length / e.length;
  };
  const others = built.sequences.filter((s) => s.id !== "seq_06").map((s) => bounce(s.id));
  check(`Bought-list sequence bounces far more (${Math.round(bounce("seq_06") * 100)}% vs at most ${Math.round(Math.max(...others) * 100)}% elsewhere)`, bounce("seq_06") >= 2 * Math.max(...others));
  const today = Date.parse(`${AS_OF_DATE}T00:00:00Z`);
  const stale = stage01.filter((o) => (today - Date.parse(`${o.last_activity_date}T00:00:00Z`)) / 86_400_000 >= STALE_DAYS);
  check(`Stage 0.1 deals (${stage01.length}); stale ${STALE_DAYS}+ days (${stale.length})`, stage01.length >= 20 && stale.length === built.planted.staleDeals.length);
  const pairedAdr = new Map(pairs.map((p) => [String(p.ae_id), String(p.adr_id)]));
  const mismatched = data.opportunities.filter((o) => o.adr_id && String(o.created_date) >= PAIRING_EFFECTIVE_FROM && pairedAdr.get(String(o.ae_id)) !== o.adr_id);
  check(`Deals since ${PAIRING_EFFECTIVE_FROM} whose ADR isn't paired with the AE (${mismatched.length}: ${mismatched.map((o) => o.id).join(", ")})`, mismatched.length >= built.planted.mismatchedDeals.length);
  const tags = data.accounts;
  check(
    `Account tag problems are there: tier-3 targets ${tags.filter((a) => a.icp_tier === 3 && a.target_account).length}, no tier ${tags.filter((a) => a.icp_tier === null).length}, no territory ${tags.filter((a) => a.territory === null).length}`,
    built.planted.tierThreeTargets.length === 4 && built.planted.missingTier.length === 5 && built.planted.missingTerritory.length === 3 && built.planted.wrongTerritory.length === 3,
  );
  check("Every contact email is at <company>.example.com", L.every((l) => /@[a-z0-9-]+\.example\.com$/.test(l.contact_email)));
  check(`Existing new-business deals linked to their lead (${built.planted.linkedExistingDeals.length})`, built.planted.linkedExistingDeals.every((id) => L.some((l) => l.opportunity_id === id)));
  console.log("\nWhat was built:");
  for (const line of adrSummary(built, input.team)) console.log(`  ${line}`);
  console.log(`  => ${results.every(Boolean) ? "All ADR checks pass." : "SOME CHECKS FAILED: see FAIL lines."}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
