/**
 * Fills the contract layer for Cockpit (built for Lumen AI) from the data
 * already in Supabase, without a reseed.
 *
 *   npm run contracts:backfill -- --dry-run   build everything and print a summary; writes nothing
 *   npm run contracts:backfill                write it
 *
 * Writes only:
 *   - contract_lines: added or updated by id (never deleted)
 *   - usage_daily.active_users: each row is written back with its existing
 *     tokens and requests unchanged plus active_users
 *   - opportunities.contract_id: set on renewal deals only
 *
 * Run `npm run contracts:check` before and after to prove no existing number moved.
 * Needs the migration supabase/migrations/20261121000000_add_contract_lines.sql.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { priorUsageWindow, usageWindow } from "../src/lib/metrics.ts";
import {
  BASE_PRODUCT,
  buildContractLayer,
  contractLayerFingerprint,
  usageKey,
  type ContractAccount,
  type ContractLineRow,
  type ContractUsage,
} from "./contracts-lib.ts";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local. Nothing was written.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;
async function readAll(table: string, columns: string, orderBy: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns, from === 0 ? { count: "exact" } : undefined);
    for (const c of orderBy) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}. Nothing was written.`);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const DAY_MS = 86_400_000;
const usageStart = new Date(new Date(`${AS_OF_DATE}T00:00:00Z`).getTime() - 90 * DAY_MS).toISOString().slice(0, 10);

async function main() {
  console.log(`Contract-layer backfill (as of ${AS_OF_DATE})${dryRun ? ": DRY RUN, nothing is written" : ""}\n`);
  if (!dryRun && !existsSync("reconciliation/contracts-before.json")) {
    throw new Error("No before snapshot. Run `npm run contracts:check -- --save-before` first. Nothing was written.");
  }

  console.log("Reading...");
  const [accRows, usageRows, oppRows, invRows] = await Promise.all([
    readAll("accounts", "id, name, status, segment, seats, mrr_usd, included_tokens_monthly, start_date, renewal_date, churn_date", ["id"]),
    readAll("usage_daily", "account_id, date, feature, model, requests, input_tokens, output_tokens", ["account_id", "date", "feature", "model"]),
    readAll("opportunities", "id, account_id, type, stage, close_date, amount_usd", ["id"]),
    readAll("invoices", "account_id, month, amount_usd", ["account_id", "month"]),
  ]);
  console.log(`  ${accRows.length} accounts, ${usageRows.length} usage rows, ${oppRows.length} deals, ${invRows.length} invoices\n`);

  const accounts: ContractAccount[] = accRows.map((a) => ({
    id: String(a.id),
    status: a.status as ContractAccount["status"],
    segment: String(a.segment),
    seats: a.seats === null ? null : Number(a.seats),
    mrr_usd: Number(a.mrr_usd),
    included_tokens_monthly: Number(a.included_tokens_monthly),
    start_date: (a.start_date as string | null) ?? null,
    renewal_date: (a.renewal_date as string | null) ?? null,
    churn_date: (a.churn_date as string | null) ?? null,
  }));
  const usage: (ContractUsage & { requests: number })[] = usageRows.map((u) => ({
    account_id: String(u.account_id),
    date: String(u.date).slice(0, 10),
    feature: String(u.feature),
    model: String(u.model),
    requests: Number(u.requests),
    input_tokens: Number(u.input_tokens),
    output_tokens: Number(u.output_tokens),
  }));
  const opportunities = oppRows.map((o) => ({ id: String(o.id), account_id: String(o.account_id), type: String(o.type), stage: String(o.stage), close_date: String(o.close_date).slice(0, 10) }));
  const invoices = invRows.map((i) => ({ account_id: String(i.account_id), month: String(i.month).slice(0, 10), amount_usd: Number(i.amount_usd) }));

  const layer = buildContractLayer({ accounts, usage, opportunities, invoices, usageStart });
  summarize(layer, accounts, accRows, usage, oppRows);
  console.log(`\nContract-layer fingerprint: ${contractLayerFingerprint(layer)} (npm run seed -- --dry-run prints the same code when it would rebuild identical data)`);

  if (dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  console.log("\nWriting...");
  // 1. Contract lines (added or updated by id)
  for (let i = 0; i < layer.lines.length; i += 500) {
    const { error } = await db.from("contract_lines").upsert(layer.lines.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`Writing contract_lines failed: ${error.message}`);
  }
  console.log(`  contract_lines: ${layer.lines.length} rows`);

  // 2. Renewal deals: contract_id only, one update per account
  const byAccount = new Map<string, string>();
  for (const o of opportunities) if (layer.dealContract.has(o.id)) byAccount.set(o.account_id, layer.dealContract.get(o.id)!);
  for (const [accountId, contractId] of byAccount) {
    const { error } = await db.from("opportunities").update({ contract_id: contractId }).eq("account_id", accountId).eq("type", "renewal");
    if (error) throw new Error(`Linking renewal deals for ${accountId} failed: ${error.message}`);
  }
  console.log(`  opportunities.contract_id: ${layer.dealContract.size} renewal deals`);

  // 3. Active users: every usage row written back exactly as read, plus active_users
  const withUsers = usage.map((u) => {
    const v = layer.activeUsers.get(usageKey(u));
    if (v === undefined) throw new Error(`No active users worked out for ${usageKey(u)}. Stopped before writing usage.`);
    return { ...u, active_users: v };
  });
  for (let i = 0; i < withUsers.length; i += 1000) {
    const { error } = await db.from("usage_daily").upsert(withUsers.slice(i, i + 1000), { onConflict: "account_id,date,feature,model" });
    if (error) throw new Error(`Writing usage_daily.active_users failed at row ${i}: ${error.message}`);
  }
  console.log(`  usage_daily.active_users: ${withUsers.length} rows`);
  console.log("\nDone. Now run: npm run contracts:check");
}

function summarize(
  layer: ReturnType<typeof buildContractLayer>,
  accounts: ContractAccount[],
  accRows: Row[],
  usage: ContractUsage[],
  oppRows: Row[],
) {
  const names = new Map(accRows.map((a) => [String(a.id), String(a.name)]));
  const linesBy = new Map<string, ContractLineRow[]>();
  for (const l of layer.lines) linesBy.set(l.account_id, [...(linesBy.get(l.account_id) ?? []), l]);
  const customers = accounts.filter((a) => a.status === "customer");
  const churned = accounts.filter((a) => a.status === "churned");

  console.log("Contract lines");
  const byStatusProduct = new Map<string, number>();
  for (const l of layer.lines) byStatusProduct.set(`${l.status} ${l.product}`, (byStatusProduct.get(`${l.status} ${l.product}`) ?? 0) + 1);
  console.log(`  ${layer.lines.length} lines on ${linesBy.size} contracts (${customers.length} customers active, ${churned.length} churned, 0 prospects)`);
  for (const [k, v] of [...byStatusProduct].sort()) console.log(`    ${k.padEnd(22)} ${v}`);

  console.log("  Lines per customer, by segment:");
  for (const seg of ["SMB", "mid-market", "enterprise"]) {
    const counts = [1, 2, 3].map((n) => customers.filter((a) => a.segment === seg && (linesBy.get(a.id)?.length ?? 0) === n).length);
    const withAddOn = customers.filter((a) => a.segment === seg && (linesBy.get(a.id)?.length ?? 0) > 1).length;
    const total = customers.filter((a) => a.segment === seg).length;
    console.log(`    ${seg.padEnd(11)} 1 line: ${String(counts[0]).padStart(3)}   2 lines: ${String(counts[1]).padStart(3)}   3 lines: ${String(counts[2]).padStart(3)}   with an add-on: ${pct(withAddOn / total)}`);
  }

  const sumFails = customers.filter((a) => (linesBy.get(a.id) ?? []).reduce((s, l) => s + l.arr_usd, 0) !== Math.round(a.mrr_usd * 12));
  console.log(`  ${sumFails.length === 0 ? "PASS" : "FAIL"}  Lines sum exactly to MRR x 12: ${customers.length - sumFails.length} of ${customers.length} customers`);
  const tokFails = [...customers, ...churned].filter((a) => (linesBy.get(a.id) ?? []).reduce((s, l) => s + l.included_tokens_monthly, 0) !== a.included_tokens_monthly);
  console.log(`  ${tokFails.length === 0 ? "PASS" : "FAIL"}  Line allowances sum to the account's included tokens: ${tokFails.length} mismatches`);
  const dateFails = customers.filter((a) => (linesBy.get(a.id) ?? []).some((l) => l.renewal_date !== a.renewal_date));
  console.log(`  ${dateFails.length === 0 ? "PASS" : "FAIL"}  Every line's renewal date equals the account's: ${dateFails.length} mismatches`);
  const maxRounding = Math.max(...layer.lines.map((l) => Math.abs(l.quantity * l.unit_price_usd - l.arr_usd)));
  console.log(`  Quantity x unit price vs ARR: largest gap ${usd(maxRounding)} (Core unit price rounded to cents)`);

  const addOns = layer.lines.filter((l) => l.status === "active" && l.product !== BASE_PRODUCT);
  const mid = addOns.filter((l) => l.purchase_date !== linesBy.get(l.account_id)!.find((x) => x.product === BASE_PRODUCT)!.purchase_date);
  const expansionDates = new Set(oppRows.filter((o) => o.type === "expansion" && o.stage === "Closed Won").map((o) => `${o.account_id}|${String(o.close_date).slice(0, 10)}`));
  const fromExpansion = mid.filter((l) => expansionDates.has(`${l.account_id}|${l.purchase_date}`)).length;
  console.log(`  Add-ons bought mid-contract: ${mid.length} of ${addOns.length} (${fromExpansion} dated by a won expansion deal)`);

  const shelf = layer.unusedCore;
  const shelfShares = shelf.map((id) => {
    const ls = linesBy.get(id)!;
    return ls.find((l) => l.product === BASE_PRODUCT)!.arr_usd / ls.reduce((s, l) => s + l.arr_usd, 0);
  });
  console.log(`  Customers who own Core but never used it: ${shelf.length}; Core is ${pct(Math.min(...shelfShares))}-${pct(Math.max(...shelfShares))} of their ARR`);
  const smallArr = shelf.filter((id, i) => shelfShares[i] < 0.1 || shelfShares[i] > 0.15);
  if (smallArr.length) console.log(`    ${smallArr.length} fall outside 10-15% only because $120 rounding is large next to a small ARR`);

  // Active users
  console.log("\nActive users (usage_daily.active_users)");
  console.log(`  Worked out for ${layer.activeUsers.size} of ${usage.length} usage rows`);
  const seats = new Map(accounts.map((a) => [a.id, a.seats ?? 1]));
  const dayTotals = new Map<string, number>();
  for (const u of usage) {
    const k = `${u.account_id}|${u.date}`;
    dayTotals.set(k, (dayTotals.get(k) ?? 0) + layer.activeUsers.get(usageKey(u))!);
  }
  const overSeats = [...dayTotals].filter(([k, v]) => v > seats.get(k.split("|")[0])!).length;
  console.log(`  ${overSeats === 0 ? "PASS" : "FAIL"}  Account-days with more users than seats: ${overSeats}`);
  const zeroUserRows = usage.filter((u) => layer.activeUsers.get(usageKey(u)) === 0).length;
  console.log(`  Rows with tokens but 0 users (a feature's few users all on its other model that day): ${zeroUserRows}`);

  const last = usageWindow(AS_OF_DATE);
  const prior = priorUsageWindow(AS_OF_DATE);
  const agg = new Map<string, { tl: number; tp: number; ul: number; up: number }>();
  for (const u of usage) {
    const t = agg.get(u.account_id) ?? { tl: 0, tp: 0, ul: 0, up: 0 };
    const tokens = u.input_tokens + u.output_tokens;
    const users = layer.activeUsers.get(usageKey(u))!;
    if (u.date >= last.start && u.date <= last.end) { t.tl += tokens; t.ul += users; }
    else if (u.date >= prior.start && u.date <= prior.end) { t.tp += tokens; t.up += users; }
    agg.set(u.account_id, t);
  }
  const change = (a: number, b: number) => (b > 0 ? (a - b) / b : 0);
  const cust = customers.map((a) => ({ a, ...agg.get(a.id)! })).filter((x) => x.tp > 0);
  const declining = cust.filter((x) => change(x.tl, x.tp) < -0.2);
  const others = cust.filter((x) => change(x.tl, x.tp) >= -0.2);
  const med = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] ?? 0;
  console.log(`  Customers with usage down >20%: ${declining.length}. Their users are down too: ${declining.filter((x) => x.ul < x.up).length} of ${declining.length} (median users change ${pct(med(declining.map((x) => change(x.ul, x.up))))})`);
  console.log(`  All other customers: median users change ${pct(med(others.map((x) => change(x.ul, x.up))))}`);
  const weekdayAvg = customers.map((a) => {
    const days = [...dayTotals].filter(([k]) => k.startsWith(`${a.id}|`) && ![0, 6].includes(new Date(`${k.split("|")[1]}T00:00:00Z`).getUTCDay()));
    return days.reduce((s, [, v]) => s + v, 0) / Math.max(1, days.length) / (a.seats ?? 1);
  });
  console.log(`  Average weekday users as a share of seats: median ${pct(med(weekdayAvg))} (range ${pct(Math.min(...weekdayAvg))}-${pct(Math.max(...weekdayAvg))})`);

  // Deals
  const renewals = oppRows.filter((o) => o.type === "renewal");
  console.log(`\nRenewal deals linked to a contract: ${layer.dealContract.size} of ${renewals.length} (no amounts changed)`);

  // Samples
  console.log("\nSample contracts");
  const pick = [
    customers.find((a) => a.segment === "enterprise" && (linesBy.get(a.id)?.length ?? 0) === 3),
    customers.find((a) => a.segment === "SMB" && (linesBy.get(a.id)?.length ?? 0) === 1),
    customers.find((a) => shelf.includes(a.id)),
    churned[0],
  ].filter((a): a is ContractAccount => !!a);
  for (const a of pick) {
    console.log(`  ${a.id} ${names.get(a.id)} (${a.segment}, ${a.status}, MRR ${usd(a.mrr_usd)}, ${a.seats} seats)`);
    for (const l of linesBy.get(a.id)!) {
      console.log(`    ${l.id.padEnd(22)} ${l.product.padEnd(12)} qty ${String(l.quantity).padStart(3)} x ${usd(l.unit_price_usd).padStart(10)}  ARR ${usd(l.arr_usd).padStart(9)}  bought ${l.purchase_date}  renews ${l.renewal_date}  ${String(l.term_months).padStart(2)} mo  auto-renew ${l.auto_renew ? "yes" : "no "}  ${l.status}  ${l.included_tokens_monthly.toLocaleString("en-US")} tokens/mo`);
    }
  }
}

await main();
