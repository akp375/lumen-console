/**
 * Contract-layer reconciliation for Cockpit (built for Lumen AI). Read-only:
 * it never writes to Supabase.
 *
 *   npm run contracts:check                  print the checks, and compare with the saved "before" snapshot if there is one
 *   npm run contracts:check -- --save-before save this run as the "before" snapshot (reconciliation/contracts-before.json)
 *
 * Part 1 (must not change): total ARR, every account's MRR and renewal date,
 * every customer's gross margin, every renewing customer's renewal-risk level,
 * the High-risk count, and fingerprints of usage tokens/requests and deal amounts.
 *
 * Part 2 (contract layer, once the migration and backfill have run): each
 * customer's lines sum to MRR x 12, each customer's renewal date equals its
 * contract's, every renewal deal points at a contract that exists, prospects
 * have no lines. Report only: renewal deals whose amount differs from their
 * contract's ARR by more than 10%.
 *
 * All numbers come from src/lib/metrics.ts or straight from the tables; this
 * script recomputes no business math.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { getAccountEconomics, getArr, getRenewalRisk } from "../src/lib/metrics.ts";

const SNAPSHOT = "reconciliation/contracts-before.json";
const MISMATCH_ABOVE = 0.1; // report renewal deals more than 10% away from contract ARR

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

const fingerprint = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const ok = (pass: boolean) => (pass ? "PASS" : "FAIL");

type Snapshot = {
  asOf: string;
  takenAt: string;
  totalArr: number;
  customerCount: number;
  highRiskCount: number;
  highRisk: string[];
  mrr: Record<string, number>;
  renewalDate: Record<string, string | null>;
  grossMargin: Record<string, number | null>;
  riskLevel: Record<string, string>;
  usageFingerprint: string;
  usageRows: number;
  dealAmountFingerprint: string;
  dealCount: number;
};

async function takeSnapshot(): Promise<{ snap: Snapshot; accounts: Row[]; opps: Row[] }> {
  const [arr, risk, econ, accounts, usage, opps] = await Promise.all([
    getArr(),
    getRenewalRisk(AS_OF_DATE),
    getAccountEconomics(AS_OF_DATE),
    readAll("accounts", "id, name, status, mrr_usd, renewal_date", ["id"]),
    readAll("usage_daily", "account_id, date, feature, model, requests, input_tokens, output_tokens", ["account_id", "date", "feature", "model"]),
    readAll("opportunities", "id, account_id, type, stage, amount_usd", ["id"]),
  ]);
  const high = risk.rows.filter((r) => r.level === "High");
  const snap: Snapshot = {
    asOf: AS_OF_DATE,
    takenAt: new Date().toISOString(),
    totalArr: arr.totalArr,
    customerCount: arr.customerCount,
    highRiskCount: high.length,
    highRisk: high.map((r) => `${r.accountId} ${r.name}`).sort(),
    mrr: Object.fromEntries(accounts!.map((a) => [String(a.id), Number(a.mrr_usd)])),
    renewalDate: Object.fromEntries(accounts!.map((a) => [String(a.id), (a.renewal_date as string | null) ?? null])),
    grossMargin: Object.fromEntries(econ.map((e) => [e.accountId, e.grossMargin === null ? null : Number(e.grossMargin.toFixed(6))])),
    riskLevel: Object.fromEntries(risk.rows.map((r) => [r.accountId, r.level])),
    usageFingerprint: fingerprint(usage!.map((u) => `${u.account_id}|${u.date}|${u.feature}|${u.model}|${u.requests}|${u.input_tokens}|${u.output_tokens}`)),
    usageRows: usage!.length,
    dealAmountFingerprint: fingerprint(opps!.map((o) => `${o.id}|${o.account_id}|${o.type}|${o.stage}|${Number(o.amount_usd)}`)),
    dealCount: opps!.length,
  };
  return { snap, accounts: accounts!, opps: opps! };
}

function compareMap(label: string, before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  console.log(`  ${ok(diffs.length === 0)}  ${label}: ${keys.size} compared, ${diffs.length} changed`);
  for (const k of diffs.slice(0, 10)) console.log(`        ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
  return diffs.length === 0;
}

async function main() {
  const saveBefore = process.argv.includes("--save-before");
  console.log(`Contract-layer reconciliation (as of ${AS_OF_DATE}). Read-only.\n`);

  const { snap, accounts, opps } = await takeSnapshot();

  console.log("Part 1: numbers that must not change");
  console.log(`  Total ARR:              ${usd(snap.totalArr)} (${snap.customerCount} customers)`);
  console.log(`  Accounts with MRR:      ${Object.keys(snap.mrr).length} (fingerprint ${fingerprint(Object.entries(snap.mrr).map(([k, v]) => `${k}|${v}`))})`);
  console.log(`  Gross margins:          ${Object.keys(snap.grossMargin).length} customers (fingerprint ${fingerprint(Object.entries(snap.grossMargin).map(([k, v]) => `${k}|${v}`))})`);
  console.log(`  Flagged renewals:       ${Object.keys(snap.riskLevel).length} customers (High or Medium; level of each is compared)`);
  console.log(`  High-risk count:        ${snap.highRiskCount}`);
  for (const h of snap.highRisk) console.log(`                          ${h}`);
  console.log(`  Usage rows:             ${snap.usageRows} (tokens/requests fingerprint ${snap.usageFingerprint})`);
  console.log(`  Deals:                  ${snap.dealCount} (amounts fingerprint ${snap.dealAmountFingerprint})`);

  if (existsSync(SNAPSHOT) && !saveBefore) {
    const before = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
    console.log(`\n  Compared with the "before" snapshot taken ${before.takenAt}:`);
    const checks = [
      (() => { const p = before.totalArr === snap.totalArr; console.log(`  ${ok(p)}  Total ARR: ${usd(before.totalArr)} -> ${usd(snap.totalArr)}`); return p; })(),
      compareMap("Every account's MRR", before.mrr, snap.mrr),
      compareMap("Every account's renewal date", before.renewalDate, snap.renewalDate),
      compareMap("Every customer's gross margin", before.grossMargin, snap.grossMargin),
      compareMap("Renewal-risk levels", before.riskLevel, snap.riskLevel),
      (() => { const p = before.highRiskCount === snap.highRiskCount && JSON.stringify(before.highRisk) === JSON.stringify(snap.highRisk); console.log(`  ${ok(p)}  High-risk: ${before.highRiskCount} -> ${snap.highRiskCount}, same accounts: ${p ? "yes" : "no"}`); return p; })(),
      (() => { const p = before.usageFingerprint === snap.usageFingerprint && before.usageRows === snap.usageRows; console.log(`  ${ok(p)}  Usage tokens/requests: ${before.usageFingerprint} -> ${snap.usageFingerprint}`); return p; })(),
      (() => { const p = before.dealAmountFingerprint === snap.dealAmountFingerprint; console.log(`  ${ok(p)}  Deal amounts: ${before.dealAmountFingerprint} -> ${snap.dealAmountFingerprint}`); return p; })(),
    ];
    console.log(`  => ${checks.every(Boolean) ? "Nothing changed." : "SOMETHING CHANGED: see FAIL lines."}`);
  }

  // Part 2: the contract layer
  console.log("\nPart 2: contract layer");
  const lines = await readAll("contract_lines", "id, account_id, contract_id, product, arr_usd, renewal_date, status", ["id"]);
  const oppLinks = await readAll("opportunities", "id, contract_id", ["id"]);
  if (lines === null) {
    console.log("  contract_lines table: not created yet (run the migration first). Checks skipped.");
  } else {
    const byAccount = new Map<string, Row[]>();
    for (const l of lines) byAccount.set(String(l.account_id), [...(byAccount.get(String(l.account_id)) ?? []), l]);
    const customers = accounts.filter((a) => a.status === "customer");
    const prospects = accounts.filter((a) => a.status === "prospect");

    const sumFails = customers.filter((a) => {
      const active = (byAccount.get(String(a.id)) ?? []).filter((l) => l.status === "active");
      const sum = active.reduce((s, l) => s + Math.round(Number(l.arr_usd) * 100), 0);
      return sum !== Math.round(Number(a.mrr_usd) * 12 * 100);
    });
    console.log(`  ${ok(sumFails.length === 0)}  Lines sum to MRR x 12: ${customers.length - sumFails.length} of ${customers.length} customers`);
    for (const a of sumFails.slice(0, 10)) console.log(`        ${a.id} ${a.name}`);

    const dateFails = customers.filter((a) => {
      const active = (byAccount.get(String(a.id)) ?? []).filter((l) => l.status === "active");
      return active.length === 0 || active.some((l) => l.renewal_date !== a.renewal_date);
    });
    console.log(`  ${ok(dateFails.length === 0)}  Renewal date equals contract's: ${customers.length - dateFails.length} of ${customers.length} customers`);
    for (const a of dateFails.slice(0, 10)) console.log(`        ${a.id} ${a.name}`);

    const prospectLines = prospects.filter((a) => byAccount.has(String(a.id)));
    console.log(`  ${ok(prospectLines.length === 0)}  Prospects with lines: ${prospectLines.length}`);

    // Renewal deals and their contracts
    const contractArr = new Map<string, { account: string; arr: number }>();
    for (const l of lines) {
      const c = contractArr.get(String(l.contract_id)) ?? { account: String(l.account_id), arr: 0 };
      c.arr += Number(l.arr_usd);
      contractArr.set(String(l.contract_id), c);
    }
    if (oppLinks === null) {
      console.log("  opportunities.contract_id: column not added yet. Deal checks skipped.");
    } else {
      const link = new Map(oppLinks.map((o) => [String(o.id), (o.contract_id as string | null) ?? null]));
      const renewals = opps.filter((o) => o.type === "renewal");
      const broken = renewals.filter((o) => {
        const cid = link.get(String(o.id));
        return !cid || contractArr.get(cid)?.account !== o.account_id;
      });
      console.log(`  ${ok(broken.length === 0)}  Renewal deals linked to their account's contract: ${renewals.length - broken.length} of ${renewals.length}`);
      for (const o of broken.slice(0, 10)) console.log(`        ${o.id} (${o.account_id})`);

      const names = new Map(accounts.map((a) => [String(a.id), String(a.name)]));
      const off = renewals
        .map((o) => {
          const c = contractArr.get(link.get(String(o.id)) ?? "");
          return c ? { o, arr: c.arr, diff: (Number(o.amount_usd) - c.arr) / c.arr } : null;
        })
        .filter((x): x is { o: Row; arr: number; diff: number } => x !== null && Math.abs(x.diff) > MISMATCH_ABOVE)
        .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
      console.log(`\n  Report only: renewal deals more than 10% away from their contract's ARR: ${off.length}`);
      for (const x of off) {
        console.log(`    ${x.o.id}  ${names.get(String(x.o.account_id))}  ${x.o.stage}  deal ${usd(Number(x.o.amount_usd))} vs contract ${usd(x.arr)} (${x.diff > 0 ? "+" : ""}${(x.diff * 100).toFixed(1)}%)`);
      }
    }
  }

  if (saveBefore) {
    mkdirSync("reconciliation", { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + "\n");
    console.log(`\nSaved the "before" snapshot to ${SNAPSHOT}.`);
  }
}

await main();
