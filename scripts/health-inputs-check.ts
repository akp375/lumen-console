/**
 * Reconciliation for the health-score inputs (team, ownership, CSM activities,
 * CSAT) in Cockpit, built for Lumen AI. Read-only: it never writes to Supabase.
 *
 *   npm run health-inputs:check                  print the checks, and compare with the saved "before" snapshot if there is one
 *   npm run health-inputs:check -- --save-before save this run as the "before" snapshot (reconciliation/health-inputs-before.json)
 *
 * Part 1 (must not change): every existing column of every existing table
 * except health_scores (filled by `npm run health:backfill`),
 * fingerprinted row by row (new columns are left out), plus total ARR, the
 * renewal-risk level of each account and the High-risk list.
 *
 * Part 2 (once the migration and seeding have run): the ownership rules,
 * CSM activity counts and CSAT coverage.
 *
 * All numbers come from src/lib/metrics.ts or straight from the tables; this
 * script recomputes no business math.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { getArr, getRenewalRisk } from "../src/lib/metrics.ts";

const SNAPSHOT = "reconciliation/health-inputs-before.json";

// Existing tables and how to order them. Columns added by the health-inputs
// migration are dropped before fingerprinting, so only old values are compared.
const TABLES: Record<string, string[]> = {
  accounts: ["id"],
  opportunities: ["id"],
  invoices: ["account_id", "month"],
  usage_daily: ["account_id", "date", "feature", "model"],
  model_prices: ["model"],
  support_tickets: ["id"],
  nps_responses: ["id"],
  contract_lines: ["id"],
};
// health_scores is left out: `npm run health:backfill` writes it on purpose.
const NEW_COLUMNS: Record<string, string[]> = {
  accounts: ["csm_id", "executive_sponsor_name", "executive_sponsor_title", "sponsor_status", "sponsor_left_date"],
  opportunities: ["ae_id", "adr_id", "csm_id"],
  support_tickets: ["csat_score"],
};

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;

/** Reads every row, 1,000 at a time. Returns null if the table or a column doesn't exist yet. */
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

/** One stable line per row: old columns only, in name order. */
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
  tables: Record<string, TableFingerprint>;
};

async function takeSnapshot(): Promise<{ snap: Snapshot; data: Record<string, Row[]> }> {
  const [arr, risk] = await Promise.all([getArr(), getRenewalRisk(AS_OF_DATE)]);
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
  const snap: Snapshot = {
    asOf: AS_OF_DATE,
    takenAt: new Date().toISOString(),
    totalArr: arr.totalArr,
    customerCount: arr.customerCount,
    highRisk: risk.rows.filter((r) => r.level === "High").map((r) => `${r.accountId} ${r.name}`).sort(),
    riskLevel: Object.fromEntries(risk.rows.map((r) => [r.accountId, r.level])),
    tables,
  };
  return { snap, data };
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
  console.log(`Health-inputs reconciliation (as of ${AS_OF_DATE}). Read-only.\n`);
  const { snap, data } = await takeSnapshot();

  console.log("Part 1: what must not change");
  console.log(`  Total ARR:        ${usd(snap.totalArr)} (${snap.customerCount} customers)`);
  console.log(`  High-risk:        ${snap.highRisk.length}`);
  for (const h of snap.highRisk) console.log(`                    ${h}`);
  for (const [t, f] of Object.entries(snap.tables)) console.log(`  ${t.padEnd(16)}  ${String(f.rows).padStart(6)} rows, ${f.columns.length} columns, fingerprint ${f.fingerprint}`);

  if (saveBefore) {
    writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + "\n");
    console.log(`\n  Saved as the "before" snapshot: ${SNAPSHOT}`);
  } else if (existsSync(SNAPSHOT)) {
    const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
    console.log(`\n  Compared with the "before" snapshot taken ${before.takenAt}:`);
    const results = [
      (() => { const p = before.totalArr === snap.totalArr; console.log(`  ${ok(p)}  Total ARR: ${usd(before.totalArr)} -> ${usd(snap.totalArr)}`); return p; })(),
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

  // Part 2: the new inputs
  console.log("\nPart 2: team, ownership, CSM activities and CSAT");
  const team = await readAll("team", "id, name, role, segment", ["id"]);
  const activities = await readAll("cs_activities", "id, account_id, csm_id, activity_date, type, attendee_level", ["id"]);
  const hasCsm = data.accounts.length > 0 && "csm_id" in data.accounts[0];
  const hasCsat = data.support_tickets.length > 0 && "csat_score" in data.support_tickets[0];
  if (team === null || activities === null || !hasCsm || !hasCsat) {
    console.log("  New tables or columns not created yet (run the migration first). Checks skipped.");
    return;
  }

  const roleOf = new Map(team.map((t) => [String(t.id), String(t.role)]));
  const byRole = new Map<string, number>();
  for (const t of team) byRole.set(String(t.role), (byRole.get(String(t.role)) ?? 0) + 1);
  console.log(`  Team: ${team.length} people (${[...byRole].map(([r, n]) => `${n} ${r}`).join(", ")})`);

  const aeNames = new Set(team.filter((t) => t.role === "AE").map((t) => String(t.name)));
  const aeIdByName = new Map(team.filter((t) => t.role === "AE").map((t) => [String(t.name), String(t.id)]));
  const accounts = data.accounts;
  const accById = new Map(accounts.map((a) => [String(a.id), a]));
  const opps = data.opportunities;
  const tickets = data.support_tickets;

  const results = [
    check("Every account owner is an AE on the team", accounts.filter((a) => !aeNames.has(String(a.owner))).map((a) => `${a.id} owner ${a.owner}`)),
    check("Every customer has a CSM", accounts.filter((a) => a.status === "customer" && !a.csm_id).map((a) => String(a.id))),
    check("No prospect has a CSM", accounts.filter((a) => a.status === "prospect" && a.csm_id).map((a) => String(a.id))),
    check("Account CSMs have the CSM role", accounts.filter((a) => a.csm_id && roleOf.get(String(a.csm_id)) !== "CSM").map((a) => `${a.id} -> ${a.csm_id}`)),
    check(
      "Each account's CSM covers its segment",
      accounts.filter((a) => a.csm_id && team.find((t) => t.id === a.csm_id)?.segment !== a.segment).map((a) => `${a.id} ${a.segment} -> ${a.csm_id}`),
    ),
    check(
      "Every deal's ae_id is its account owner (deals have no owner of their own)",
      opps.filter((o) => o.ae_id !== aeIdByName.get(String(accById.get(String(o.account_id))?.owner))).map((o) => `${o.id} ae_id ${o.ae_id}`),
    ),
    check(
      "ADR on new inbound/outbound deals only",
      opps
        .filter((o) => {
          const wants = o.type === "new" && (o.source === "inbound" || o.source === "outbound");
          return wants ? !o.adr_id || roleOf.get(String(o.adr_id)) !== "ADR" : Boolean(o.adr_id);
        })
        .map((o) => `${o.id} ${o.type}/${o.source} adr ${o.adr_id}`),
    ),
    check(
      "Renewal and expansion deals carry the account's CSM; new deals none",
      opps
        .filter((o) => {
          const acc = accById.get(String(o.account_id));
          return o.type === "new" ? Boolean(o.csm_id) : (o.csm_id ?? null) !== (acc?.csm_id ?? null);
        })
        .map((o) => `${o.id} ${o.type} csm ${o.csm_id}`),
    ),
    check("Every activity's CSM is the account's CSM", activities.filter((x) => x.csm_id !== accById.get(String(x.account_id))?.csm_id).map((x) => `${x.id} ${x.account_id}`)),
    check("No activity on a prospect or after the as-of date", activities.filter((x) => accById.get(String(x.account_id))?.status === "prospect" || String(x.activity_date) > AS_OF_DATE).map((x) => `${x.id} ${x.activity_date}`)),
    check(
      "Sponsor only on enterprise and mid-market customers, every one of them",
      accounts
        .filter((a) => {
          const wants = a.status === "customer" && (a.segment === "enterprise" || a.segment === "mid-market");
          return wants ? !a.sponsor_status : a.sponsor_status != null || a.executive_sponsor_name != null;
        })
        .map((a) => `${a.id} ${a.segment} ${a.status}: ${a.sponsor_status}`),
    ),
    check(
      "Active and left sponsors have a name and title; none has neither",
      accounts
        .filter((a) => a.sponsor_status)
        .filter((a) => (a.sponsor_status === "none") !== (a.executive_sponsor_name == null && a.executive_sponsor_title == null))
        .map((a) => `${a.id} ${a.sponsor_status}`),
    ),
    check(
      "Left date only on 'left', within the last 90 days",
      accounts
        .filter((a) => {
          const d = a.sponsor_left_date == null ? null : String(a.sponsor_left_date);
          if (a.sponsor_status !== "left") return d !== null;
          const ninetyAgo = new Date(Date.parse(`${AS_OF_DATE}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
          return d === null || d > AS_OF_DATE || d < ninetyAgo;
        })
        .map((a) => `${a.id} ${a.sponsor_status} ${a.sponsor_left_date}`),
    ),
    check("CSAT only on closed tickets", tickets.filter((t) => t.csat_score != null && t.status !== "closed").map((t) => String(t.id))),
  ];

  // CSM coverage: customers per CSM, by segment
  console.log("\n  CSM load (current customers):");
  const nameOf = new Map(team.map((t) => [String(t.id), t]));
  const load = new Map<string, { segs: Map<string, number>; arr: number }>();
  for (const a of accounts.filter((x) => x.status === "customer")) {
    const k = String(a.csm_id);
    const l = load.get(k) ?? { segs: new Map(), arr: 0 };
    l.segs.set(String(a.segment), (l.segs.get(String(a.segment)) ?? 0) + 1);
    l.arr += Number(a.mrr_usd) * 12;
    load.set(k, l);
  }
  for (const [id, l] of [...load].sort()) {
    const t = nameOf.get(id);
    const n = [...l.segs.values()].reduce((x, y) => x + y, 0);
    console.log(`    ${String(t?.name).padEnd(16)} ${String(t?.segment).padEnd(11)} ${String(n).padStart(3)} customers (${[...l.segs].map(([s, c]) => `${c} ${s}`).join(", ")}), ARR ${usd(l.arr)}`);
  }
  const content = hash(activities.map((x) => `${x.id}|${x.account_id}|${x.activity_date}|${x.type}|${x.attendee_level}`));
  console.log(`\n  Activity content fingerprint (ids, dates, types, attendees; CSM left out): ${content}`);

  const closed = tickets.filter((t) => t.status === "closed");
  const rated = closed.filter((t) => t.csat_score != null);
  const byType = new Map<string, number>();
  for (const x of activities) byType.set(String(x.type), (byType.get(String(x.type)) ?? 0) + 1);
  const sponsorCount = new Map<string, number>();
  for (const a of accounts.filter((x) => x.sponsor_status)) sponsorCount.set(String(a.sponsor_status), (sponsorCount.get(String(a.sponsor_status)) ?? 0) + 1);
  console.log(`\n  Executive sponsors: ${[...sponsorCount].map(([k, n]) => `${n} ${k}`).join(", ")}`);
  console.log(`\n  CS activities: ${activities.length} (${[...byType].map(([t, n]) => `${n} ${t}`).join(", ")})`);
  console.log(`  CSAT: ${rated.length} of ${closed.length} closed tickets rated (${closed.length ? Math.round((rated.length / closed.length) * 100) : 0}%)`);

  // Financial inputs available to the health score (report only)
  const yearAgo = new Date(Date.parse(`${AS_OF_DATE}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const ended = data.contract_lines.filter((l) => l.status !== "active" && accById.get(String(l.account_id))?.status === "customer");
  const wonExpansion = opps.filter((o) => o.type === "expansion" && o.stage === "Closed Won" && String(o.close_date) > yearAgo && String(o.close_date) <= AS_OF_DATE);
  const unpaid = new Map<string, number>();
  for (const i of data.invoices.filter((x) => x.status !== "paid")) unpaid.set(`${i.status} ${String(i.month).slice(0, 7)}`, (unpaid.get(`${i.status} ${String(i.month).slice(0, 7)}`) ?? 0) + 1);
  console.log(`\n  Financial inputs: ${ended.length} ended lines on current customers; ${wonExpansion.length} expansion deals won in the last 12 months`);
  console.log(`  Unpaid invoices: ${[...unpaid].sort().map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  console.log(`  => ${results.every(Boolean) ? "All ownership and data rules pass." : "SOME RULES FAIL: see FAIL lines."}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
