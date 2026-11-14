// Lumen Console business metrics. All business math lives in this file.
//
// Two layers:
//   1. Calculators (calc*): pure functions. They take plain rows plus "today"
//      (asOf, YYYY-MM-DD) and return numbers. No database, no real clock.
//   2. Loaders (get*): read rows from Supabase on the server with the
//      service-role key, then hand them to the calculators with AS_OF_DATE.
//
// Shared rules:
//   - "Today" is AS_OF_DATE (src/lib/as-of-date.ts), never the real clock.
//   - Customer metrics count accounts with status 'customer' only (NRR also
//     needs churned accounts, so it includes them).
//   - Pipeline metrics count open deals only.

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "./as-of-date.ts";

// ---------------------------------------------------------------------------
// Row types (only the columns the metrics need)
// ---------------------------------------------------------------------------

export type AccountRow = {
  id: string;
  name: string;
  status: "prospect" | "customer" | "churned";
  mrr_usd: number;
  included_tokens_monthly: number;
  start_date: string | null;
  churn_date: string | null;
};

export type OpportunityRow = {
  id: string;
  account_id: string;
  type: string;
  source: string;
  stage: string;
  forecast_category: string;
  amount_usd: number;
  probability: number; // 0-100
  created_date: string;
  close_date: string;
};

export type UsageRow = {
  account_id: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
};

export type ModelPriceRow = {
  model: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
};

export type InvoiceRow = {
  account_id: string;
  month: string; // first day of the month
  amount_usd: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPEN_STAGES = ["Discovery", "Demo", "Proposal", "Negotiation"] as const;
export const CLOSED_STAGES = ["Closed Won", "Closed Lost"] as const;
const SOURCE_ORDER = ["inbound", "outbound", "partner", "existing customer"];
const TYPE_ORDER = ["new", "expansion", "renewal"];
const FORECAST_ORDER = ["Pipeline", "Best Case", "Commit", "Closed", "Omitted"];

export const WIN_RATE_LOOKBACK_MONTHS = 6;
export const USAGE_WINDOW_DAYS = 30;
export const NRR_LOOKBACK_DAYS = 90;
export const UNDERWATER_MARGIN_BELOW = 0.3; // underwater when margin < 30%
export const OVERAGE_CAPACITY_ABOVE = 1.0; // overage when capacity used > 100%

// ---------------------------------------------------------------------------
// Date helpers (UTC, YYYY-MM-DD strings compare correctly as text)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function parseDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`Expected a YYYY-MM-DD date, got "${s}"`);
  return new Date(`${s.slice(0, 10)}T00:00:00Z`);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(s: string, days: number): string {
  return isoDate(new Date(parseDate(s).getTime() + days * DAY_MS));
}
function addMonths(s: string, months: number): string {
  const d = parseDate(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))));
}
function monthStart(s: string): string {
  return `${s.slice(0, 7)}-01`;
}
function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
}
function day(s: string): string {
  return s.slice(0, 10);
}

function customersOnly(accounts: AccountRow[]): AccountRow[] {
  return accounts.filter((a) => a.status === "customer");
}

// ---------------------------------------------------------------------------
// 1. ARR
// ---------------------------------------------------------------------------

export type ArrResult = {
  totalArr: number;
  customerCount: number;
  byAccount: { accountId: string; name: string; mrr: number; arr: number }[]; // largest first
};

/** ARR per customer = MRR x 12. Total = sum over customers. */
export function calcArr(accounts: AccountRow[]): ArrResult {
  const byAccount = customersOnly(accounts)
    .map((a) => ({ accountId: a.id, name: a.name, mrr: a.mrr_usd, arr: a.mrr_usd * 12 }))
    .sort((x, y) => y.arr - x.arr || x.accountId.localeCompare(y.accountId));
  return {
    totalArr: byAccount.reduce((s, a) => s + a.arr, 0),
    customerCount: byAccount.length,
    byAccount,
  };
}

// ---------------------------------------------------------------------------
// 2. Pipeline
// ---------------------------------------------------------------------------

export type PipelineBucket = { key: string; count: number; value: number; weightedValue: number };

export type PipelineResult = {
  total: PipelineBucket; // all open deals
  growth: PipelineBucket; // new + expansion: revenue we don't have yet
  renewal: PipelineBucket; // renewals: revenue we already have and must keep
  byStage: PipelineBucket[];
  bySource: PipelineBucket[];
  byType: PipelineBucket[];
  byForecastCategory: PipelineBucket[];
};

function isOpen(o: OpportunityRow): boolean {
  return (OPEN_STAGES as readonly string[]).includes(o.stage);
}

function weighted(o: OpportunityRow): number {
  return (o.amount_usd * o.probability) / 100;
}

function groupPipeline(deals: OpportunityRow[], keyOf: (o: OpportunityRow) => string, order: readonly string[]): PipelineBucket[] {
  const buckets = new Map<string, PipelineBucket>();
  for (const o of deals) {
    const key = keyOf(o);
    const b = buckets.get(key) ?? { key, count: 0, value: 0, weightedValue: 0 };
    b.count += 1;
    b.value += o.amount_usd;
    b.weightedValue += weighted(o);
    buckets.set(key, b);
  }
  const rank = (k: string) => (order.indexOf(k) === -1 ? order.length : order.indexOf(k));
  return [...buckets.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
}

function sumBucket(key: string, deals: OpportunityRow[]): PipelineBucket {
  return {
    key,
    count: deals.length,
    value: deals.reduce((s, o) => s + o.amount_usd, 0),
    weightedValue: deals.reduce((s, o) => s + weighted(o), 0),
  };
}

/**
 * Open deals only. Weighted value = amount x probability / 100.
 * growth = new + expansion deals; renewal = renewal deals. growth + renewal = total.
 */
export function calcPipeline(opportunities: OpportunityRow[]): PipelineResult {
  const open = opportunities.filter(isOpen);
  return {
    total: sumBucket("total", open),
    growth: sumBucket("growth", open.filter((o) => o.type !== "renewal")),
    renewal: sumBucket("renewal", open.filter((o) => o.type === "renewal")),
    byStage: groupPipeline(open, (o) => o.stage, OPEN_STAGES),
    bySource: groupPipeline(open, (o) => o.source, SOURCE_ORDER),
    byType: groupPipeline(open, (o) => o.type, TYPE_ORDER),
    byForecastCategory: groupPipeline(open, (o) => o.forecast_category, FORECAST_ORDER),
  };
}

// ---------------------------------------------------------------------------
// 3. Win rate and average sales cycle
// ---------------------------------------------------------------------------

export type WinRateStats = {
  won: number;
  lost: number;
  winRate: number | null; // null when no deals closed
  avgSalesCycleDays: number | null; // won deals only; null when none won
};

export type WinRateResult = WinRateStats & {
  windowStart: string; // exclusive
  windowEnd: string; // inclusive (= asOf)
  byType: (WinRateStats & { type: string })[]; // new, expansion, renewal
};

function winStats(closed: OpportunityRow[]): WinRateStats {
  const wonDeals = closed.filter((o) => o.stage === "Closed Won");
  const won = wonDeals.length;
  const lost = closed.length - won;
  const cycleTotal = wonDeals.reduce((s, o) => s + daysBetween(day(o.created_date), day(o.close_date)), 0);
  return {
    won,
    lost,
    winRate: won + lost === 0 ? null : won / (won + lost),
    avgSalesCycleDays: won === 0 ? null : cycleTotal / won,
  };
}

/**
 * Deals closed after (asOf - 6 months) and on or before asOf.
 * Win rate = won / (won + lost), by deal count. Overall covers all deal types;
 * byType gives the same numbers for new, expansion and renewal separately
 * (renewal win rate = share of renewals that renewed).
 * Sales cycle = average (close_date - created_date) in days over won deals.
 */
export function calcWinRateAndCycle(opportunities: OpportunityRow[], asOf: string): WinRateResult {
  const windowStart = addMonths(asOf, -WIN_RATE_LOOKBACK_MONTHS);
  const closed = opportunities.filter((o) => {
    const c = day(o.close_date);
    return (CLOSED_STAGES as readonly string[]).includes(o.stage) && c > windowStart && c <= asOf;
  });
  const types = [...new Set([...TYPE_ORDER, ...closed.map((o) => o.type)])];
  return {
    windowStart,
    windowEnd: asOf,
    ...winStats(closed),
    byType: types.map((type) => ({ type, ...winStats(closed.filter((o) => o.type === type)) })),
  };
}

// ---------------------------------------------------------------------------
// 4-6. Usage-based account economics (shared 30-day window)
// ---------------------------------------------------------------------------

/** The 30 days before asOf: [asOf - 30, asOf - 1]. asOf itself is not included. */
export function usageWindow(asOf: string): { start: string; end: string } {
  return { start: addDays(asOf, -USAGE_WINDOW_DAYS), end: addDays(asOf, -1) };
}

type UsageTotals = { inputTokens: number; outputTokens: number; costUsd: number };

function sumUsage30d(usage: UsageRow[], prices: ModelPriceRow[], asOf: string): Map<string, UsageTotals> {
  const priceByModel = new Map(prices.map((p) => [p.model, p]));
  const { start, end } = usageWindow(asOf);
  const totals = new Map<string, UsageTotals>();
  for (const u of usage) {
    const d = day(u.date);
    if (d < start || d > end) continue;
    const price = priceByModel.get(u.model);
    if (!price) throw new Error(`No price in model_prices for model "${u.model}"`);
    const t = totals.get(u.account_id) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    t.inputTokens += u.input_tokens;
    t.outputTokens += u.output_tokens;
    t.costUsd +=
      (u.input_tokens / 1_000_000) * price.input_usd_per_million +
      (u.output_tokens / 1_000_000) * price.output_usd_per_million;
    totals.set(u.account_id, t);
  }
  return totals;
}

const NO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

// 4. Token cost

export type TokenCostRow = { accountId: string; name: string; inputTokens: number; outputTokens: number; tokenCost30d: number };

/** Per customer: sum over the 30-day window of input/1M x input price + output/1M x output price. */
export function calcTokenCost30d(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): TokenCostRow[] {
  const totals = sumUsage30d(usage, prices, asOf);
  return customersOnly(accounts).map((a) => {
    const t = totals.get(a.id) ?? NO_USAGE;
    return { accountId: a.id, name: a.name, inputTokens: t.inputTokens, outputTokens: t.outputTokens, tokenCost30d: t.costUsd };
  });
}

// 5. Gross margin

export type GrossMarginRow = {
  accountId: string;
  name: string;
  mrr: number;
  tokenCost30d: number;
  grossMargin: number | null; // null when MRR is 0
  underwater: boolean; // margin below 30%
};

/** Per customer: (MRR - 30-day token cost) / MRR. Underwater when below 30%. */
export function calcGrossMargin(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): GrossMarginRow[] {
  const totals = sumUsage30d(usage, prices, asOf);
  return customersOnly(accounts).map((a) => {
    const cost = (totals.get(a.id) ?? NO_USAGE).costUsd;
    const grossMargin = a.mrr_usd > 0 ? (a.mrr_usd - cost) / a.mrr_usd : null;
    return {
      accountId: a.id,
      name: a.name,
      mrr: a.mrr_usd,
      tokenCost30d: cost,
      grossMargin,
      underwater: grossMargin !== null && grossMargin < UNDERWATER_MARGIN_BELOW,
    };
  });
}

// 6. Capacity used

export type CapacityRow = {
  accountId: string;
  name: string;
  tokens30d: number;
  includedTokensMonthly: number;
  capacityUsed: number | null; // null when the allowance is 0
  overage: boolean; // above 100%
};

/** Per customer: 30-day (input + output) tokens / included monthly tokens. Overage when above 100%. */
export function calcCapacity(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): CapacityRow[] {
  const totals = sumUsage30d(usage, prices, asOf);
  return customersOnly(accounts).map((a) => {
    const t = totals.get(a.id) ?? NO_USAGE;
    const tokens = t.inputTokens + t.outputTokens;
    const capacityUsed = a.included_tokens_monthly > 0 ? tokens / a.included_tokens_monthly : null;
    return {
      accountId: a.id,
      name: a.name,
      tokens30d: tokens,
      includedTokensMonthly: a.included_tokens_monthly,
      capacityUsed,
      overage: capacityUsed !== null && capacityUsed > OVERAGE_CAPACITY_ABOVE,
    };
  });
}

// 4-6 together: one row per customer with cost, margin and capacity

export type AccountEconomicsRow = TokenCostRow &
  Omit<GrossMarginRow, "accountId" | "name" | "tokenCost30d"> &
  Omit<CapacityRow, "accountId" | "name">;

/** Joins token cost, gross margin and capacity per customer from one set of rows. */
export function calcAccountEconomics(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): AccountEconomicsRow[] {
  const margin = new Map(calcGrossMargin(accounts, usage, prices, asOf).map((r) => [r.accountId, r]));
  const capacity = new Map(calcCapacity(accounts, usage, prices, asOf).map((r) => [r.accountId, r]));
  return calcTokenCost30d(accounts, usage, prices, asOf).map((c) => {
    const m = margin.get(c.accountId)!;
    const k = capacity.get(c.accountId)!;
    return {
      ...c,
      mrr: m.mrr,
      grossMargin: m.grossMargin,
      underwater: m.underwater,
      tokens30d: k.tokens30d,
      includedTokensMonthly: k.includedTokensMonthly,
      capacityUsed: k.capacityUsed,
      overage: k.overage,
    };
  });
}

// ---------------------------------------------------------------------------
// 7. NRR (last 90 days)
// ---------------------------------------------------------------------------

export type NrrResult = {
  startDate: string; // asOf - 90 days
  startMonth: string; // invoice month used for starting MRR
  endMonth: string; // invoice month used for ending MRR (asOf's month)
  accountsInCohort: number;
  startingMrr: number;
  upgrades: number;
  downgrades: number;
  churnedMrr: number;
  endingMrr: number;
  upgradedCount: number;
  downgradedCount: number;
  churnedCount: number;
  nrr: number | null; // null when starting MRR is 0
};

/**
 * Cohort: accounts that were customers on asOf - 90 days (started on or before
 * it, and not churned by it). Customers who joined later are excluded.
 * Starting MRR = the account's latest invoice in or before the start month.
 * Ending MRR = its invoice for asOf's month, or 0 if it has churned or has none.
 * NRR = (starting + upgrades - downgrades - churned) / starting.
 */
export function calcNrr90d(accounts: AccountRow[], invoices: InvoiceRow[], asOf: string): NrrResult {
  const startDate = addDays(asOf, -NRR_LOOKBACK_DAYS);
  const startMonth = monthStart(startDate);
  const endMonth = monthStart(asOf);

  const invoicesByAccount = new Map<string, InvoiceRow[]>();
  for (const i of invoices) {
    const list = invoicesByAccount.get(i.account_id) ?? [];
    list.push(i);
    invoicesByAccount.set(i.account_id, list);
  }

  const cohort = accounts.filter(
    (a) =>
      a.status !== "prospect" &&
      a.start_date !== null &&
      day(a.start_date) <= startDate &&
      (a.churn_date === null || day(a.churn_date) > startDate),
  );

  const r: NrrResult = {
    startDate, startMonth, endMonth,
    accountsInCohort: 0, startingMrr: 0, upgrades: 0, downgrades: 0, churnedMrr: 0, endingMrr: 0,
    upgradedCount: 0, downgradedCount: 0, churnedCount: 0, nrr: null,
  };

  for (const a of cohort) {
    const list = invoicesByAccount.get(a.id) ?? [];
    const before = list
      .filter((i) => day(i.month) <= startMonth)
      .sort((x, y) => day(y.month).localeCompare(day(x.month)))[0];
    if (!before || before.amount_usd <= 0) continue; // nothing billed at the start: adds nothing
    const starting = before.amount_usd;
    const churned = a.status === "churned" && a.churn_date !== null && day(a.churn_date) <= asOf;
    const ending = churned ? 0 : (list.find((i) => day(i.month) === endMonth)?.amount_usd ?? 0);

    r.accountsInCohort += 1;
    r.startingMrr += starting;
    r.endingMrr += ending;
    if (ending === 0) {
      r.churnedMrr += starting;
      r.churnedCount += 1;
    } else if (ending > starting) {
      r.upgrades += ending - starting;
      r.upgradedCount += 1;
    } else if (ending < starting) {
      r.downgrades += starting - ending;
      r.downgradedCount += 1;
    }
  }
  r.nrr = r.startingMrr > 0 ? (r.startingMrr + r.upgrades - r.downgrades - r.churnedMrr) / r.startingMrr : null;
  return r;
}

// ---------------------------------------------------------------------------
// Loaders: read from Supabase (server-side only) and run the calculators
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000; // Supabase returns at most 1,000 rows per request

let client: SupabaseClient | null = null;

function db(): SupabaseClient {
  if (typeof window !== "undefined") throw new Error("metrics loaders must run on the server");
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side)");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

type Query = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

/** Reads every matching row, 1,000 at a time, in a stable order. */
async function fetchAll(table: string, columns: string, orderBy: string[], filter?: (q: Query) => Query): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let q = db().from(table).select(columns) as unknown as Query;
    if (filter) q = filter(q);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function loadAccounts(filter?: (q: Query) => Query): Promise<AccountRow[]> {
  const rows = await fetchAll("accounts", "id, name, status, mrr_usd, included_tokens_monthly, start_date, churn_date", ["id"], filter);
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    status: str(r.status) as AccountRow["status"],
    mrr_usd: num(r.mrr_usd),
    included_tokens_monthly: num(r.included_tokens_monthly),
    start_date: strOrNull(r.start_date),
    churn_date: strOrNull(r.churn_date),
  }));
}

async function loadOpportunities(filter?: (q: Query) => Query): Promise<OpportunityRow[]> {
  const rows = await fetchAll(
    "opportunities",
    "id, account_id, type, source, stage, forecast_category, amount_usd, probability, created_date, close_date",
    ["id"],
    filter,
  );
  return rows.map((r) => ({
    id: str(r.id),
    account_id: str(r.account_id),
    type: str(r.type),
    source: str(r.source),
    stage: str(r.stage),
    forecast_category: str(r.forecast_category),
    amount_usd: num(r.amount_usd),
    probability: num(r.probability),
    created_date: str(r.created_date),
    close_date: str(r.close_date),
  }));
}

async function loadUsageAndPrices(asOf: string): Promise<{ usage: UsageRow[]; prices: ModelPriceRow[] }> {
  const { start, end } = usageWindow(asOf);
  const [usageRows, priceRows] = await Promise.all([
    fetchAll("usage_daily", "account_id, date, feature, model, input_tokens, output_tokens", ["account_id", "date", "feature", "model"], (q) =>
      q.gte("date", start).lte("date", end),
    ),
    fetchAll("model_prices", "model, input_usd_per_million, output_usd_per_million", ["model"]),
  ]);
  return {
    usage: usageRows.map((r) => ({
      account_id: str(r.account_id),
      date: str(r.date),
      model: str(r.model),
      input_tokens: num(r.input_tokens),
      output_tokens: num(r.output_tokens),
    })),
    prices: priceRows.map((r) => ({
      model: str(r.model),
      input_usd_per_million: num(r.input_usd_per_million),
      output_usd_per_million: num(r.output_usd_per_million),
    })),
  };
}

const customerFilter = (q: Query) => q.eq("status", "customer");

export async function getArr(): Promise<ArrResult> {
  return calcArr(await loadAccounts(customerFilter));
}

export async function getPipeline(): Promise<PipelineResult> {
  return calcPipeline(await loadOpportunities((q) => q.in("stage", [...OPEN_STAGES])));
}

export async function getWinRateAndCycle(asOf: string = AS_OF_DATE): Promise<WinRateResult> {
  const windowStart = addMonths(asOf, -WIN_RATE_LOOKBACK_MONTHS);
  const opps = await loadOpportunities((q) => q.in("stage", [...CLOSED_STAGES]).gt("close_date", windowStart).lte("close_date", asOf));
  return calcWinRateAndCycle(opps, asOf);
}

export async function getTokenCost30d(asOf: string = AS_OF_DATE): Promise<TokenCostRow[]> {
  const [accounts, { usage, prices }] = await Promise.all([loadAccounts(customerFilter), loadUsageAndPrices(asOf)]);
  return calcTokenCost30d(accounts, usage, prices, asOf);
}

export async function getGrossMargin(asOf: string = AS_OF_DATE): Promise<GrossMarginRow[]> {
  const [accounts, { usage, prices }] = await Promise.all([loadAccounts(customerFilter), loadUsageAndPrices(asOf)]);
  return calcGrossMargin(accounts, usage, prices, asOf);
}

export async function getCapacity(asOf: string = AS_OF_DATE): Promise<CapacityRow[]> {
  const [accounts, { usage, prices }] = await Promise.all([loadAccounts(customerFilter), loadUsageAndPrices(asOf)]);
  return calcCapacity(accounts, usage, prices, asOf);
}

/** Token cost, margin and capacity per customer, reading usage only once. */
export async function getAccountEconomics(asOf: string = AS_OF_DATE): Promise<AccountEconomicsRow[]> {
  const [accounts, { usage, prices }] = await Promise.all([loadAccounts(customerFilter), loadUsageAndPrices(asOf)]);
  return calcAccountEconomics(accounts, usage, prices, asOf);
}

export async function getNrr90d(asOf: string = AS_OF_DATE): Promise<NrrResult> {
  const endMonth = monthStart(asOf);
  const [accounts, invoiceRows] = await Promise.all([
    loadAccounts((q) => q.neq("status", "prospect")),
    fetchAll("invoices", "account_id, month, amount_usd", ["account_id", "month"], (q) => q.lte("month", endMonth)),
  ]);
  const invoices = invoiceRows.map((r) => ({ account_id: str(r.account_id), month: str(r.month), amount_usd: num(r.amount_usd) }));
  return calcNrr90d(accounts, invoices, asOf);
}
