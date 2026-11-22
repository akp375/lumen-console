// Cockpit (built for Lumen AI) business metrics. All business math lives in this file.
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
  segment: string; // SMB, mid-market, enterprise
  mrr_usd: number;
  included_tokens_monthly: number;
  start_date: string | null;
  renewal_date: string | null; // next renewal; empty for prospects and churned accounts
  churn_date: string | null;
  owner: string; // account owner
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

export const SEGMENT_ORDER = ["enterprise", "mid-market", "SMB"];

function segmentRank(s: string): number {
  const i = SEGMENT_ORDER.indexOf(s);
  return i === -1 ? SEGMENT_ORDER.length : i;
}

export type ArrResult = {
  totalArr: number;
  customerCount: number;
  top10Share: number | null; // share of ARR from the 10 largest customers
  bySegment: { segment: string; customers: number; arr: number; share: number | null }[]; // enterprise, mid-market, SMB
  byAccount: { accountId: string; name: string; mrr: number; arr: number }[]; // largest first
};

/** ARR per customer = MRR x 12. Total = sum over customers. Also split by segment. */
export function calcArr(accounts: AccountRow[]): ArrResult {
  const customers = customersOnly(accounts);
  const byAccount = customers
    .map((a) => ({ accountId: a.id, name: a.name, mrr: a.mrr_usd, arr: a.mrr_usd * 12 }))
    .sort((x, y) => y.arr - x.arr || x.accountId.localeCompare(y.accountId));
  const totalArr = byAccount.reduce((s, a) => s + a.arr, 0);
  const top10 = byAccount.slice(0, 10).reduce((s, a) => s + a.arr, 0);
  const segments = [...new Set(customers.map((a) => a.segment))].sort((x, y) => segmentRank(x) - segmentRank(y));
  return {
    totalArr,
    customerCount: byAccount.length,
    top10Share: totalArr > 0 ? top10 / totalArr : null,
    bySegment: segments.map((segment) => {
      const list = customers.filter((a) => a.segment === segment);
      const arr = list.reduce((s, a) => s + a.mrr_usd * 12, 0);
      return { segment, customers: list.length, arr, share: totalArr > 0 ? arr / totalArr : null };
    }),
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

/** Returns a function that prices one usage row: input/1M x input price + output/1M x output price. */
function usageCoster(prices: ModelPriceRow[]): (u: UsageRow) => number {
  const priceByModel = new Map(prices.map((p) => [p.model, p]));
  return (u) => {
    const price = priceByModel.get(u.model);
    if (!price) throw new Error(`No price in model_prices for model "${u.model}"`);
    return (
      (u.input_tokens / 1_000_000) * price.input_usd_per_million +
      (u.output_tokens / 1_000_000) * price.output_usd_per_million
    );
  };
}

function sumUsage30d(usage: UsageRow[], prices: ModelPriceRow[], asOf: string): Map<string, UsageTotals> {
  const cost = usageCoster(prices);
  const { start, end } = usageWindow(asOf);
  const totals = new Map<string, UsageTotals>();
  for (const u of usage) {
    const d = day(u.date);
    if (d < start || d > end) continue;
    const t = totals.get(u.account_id) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    t.inputTokens += u.input_tokens;
    t.outputTokens += u.output_tokens;
    t.costUsd += cost(u);
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

// Customer lifecycle

export const LIFECYCLE_STAGES = ["Onboarding", "First year", "Established", "Renewal due"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export const ONBOARDING_DAYS = 90; // Onboarding = customer for fewer than 90 days
export const FIRST_YEAR_DAYS = 365; // First year = 90 to 364 days; Established = 365 days or more
export const RENEWAL_DUE_DAYS = 90; // Renewal due = renewal date within the next 90 days (overrides the rest)

/** Whole months from `from` to `to` (a month counts once the same day of the month is reached). */
function wholeMonthsBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export type Lifecycle = {
  tenureMonths: number; // whole months since start_date
  daysToRenewal: number | null;
  stage: LifecycleStage;
};

/**
 * Renewal due: renewal date is today or within the next 90 days (checked first,
 * because it needs action). Otherwise by time since start: Onboarding under 90
 * days, First year under 365 days, Established after that.
 */
export function calcLifecycle(startDate: string, renewalDate: string | null, asOf: string): Lifecycle {
  const tenureDays = daysBetween(day(startDate), asOf);
  const daysToRenewal = renewalDate === null ? null : daysBetween(asOf, day(renewalDate));
  const stage: LifecycleStage =
    daysToRenewal !== null && daysToRenewal >= 0 && daysToRenewal <= RENEWAL_DUE_DAYS
      ? "Renewal due"
      : tenureDays < ONBOARDING_DAYS
        ? "Onboarding"
        : tenureDays < FIRST_YEAR_DAYS
          ? "First year"
          : "Established";
  return { tenureMonths: wholeMonthsBetween(day(startDate), asOf), daysToRenewal, stage };
}

export type AccountEconomicsRow = TokenCostRow &
  Omit<GrossMarginRow, "accountId" | "name" | "tokenCost30d"> &
  Omit<CapacityRow, "accountId" | "name"> & {
    segment: string;
    owner: string;
    startDate: string | null;
    renewalDate: string | null;
    tenureMonths: number | null;
    daysToRenewal: number | null;
    lifecycleStage: LifecycleStage | null;
  };

/** Joins token cost, gross margin, capacity and lifecycle per customer from one set of rows. */
export function calcAccountEconomics(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): AccountEconomicsRow[] {
  const margin = new Map(calcGrossMargin(accounts, usage, prices, asOf).map((r) => [r.accountId, r]));
  const capacity = new Map(calcCapacity(accounts, usage, prices, asOf).map((r) => [r.accountId, r]));
  const account = new Map(accounts.map((a) => [a.id, a]));
  return calcTokenCost30d(accounts, usage, prices, asOf).map((c) => {
    const m = margin.get(c.accountId)!;
    const k = capacity.get(c.accountId)!;
    const a = account.get(c.accountId)!;
    const life = a.start_date ? calcLifecycle(a.start_date, a.renewal_date, asOf) : null;
    return {
      ...c,
      segment: a.segment,
      owner: a.owner,
      startDate: a.start_date,
      renewalDate: a.renewal_date,
      tenureMonths: life?.tenureMonths ?? null,
      daysToRenewal: life?.daysToRenewal ?? null,
      lifecycleStage: life?.stage ?? null,
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

// Portfolio totals across all customers

export type PortfolioEconomics = {
  customerCount: number;
  totalMrr: number;
  totalTokenCost30d: number;
  blendedGrossMargin: number | null; // (total MRR - total token cost) / total MRR
  underwaterCount: number;
  negativeMarginCount: number; // token cost above MRR
  underwaterMrr: number;
  underwaterMrrShare: number | null; // underwater MRR / total MRR
  underwaterTokenCostShare: number | null; // underwater token cost / total token cost
  overageCount: number;
};

/** Totals over the per-customer economics rows. Blended margin weights each account by its MRR. */
export function calcPortfolioEconomics(rows: AccountEconomicsRow[]): PortfolioEconomics {
  const totalMrr = rows.reduce((s, r) => s + r.mrr, 0);
  const totalTokenCost30d = rows.reduce((s, r) => s + r.tokenCost30d, 0);
  const underwater = rows.filter((r) => r.underwater);
  const underwaterMrr = underwater.reduce((s, r) => s + r.mrr, 0);
  const underwaterCost = underwater.reduce((s, r) => s + r.tokenCost30d, 0);
  return {
    customerCount: rows.length,
    totalMrr,
    totalTokenCost30d,
    blendedGrossMargin: totalMrr > 0 ? (totalMrr - totalTokenCost30d) / totalMrr : null,
    underwaterCount: underwater.length,
    negativeMarginCount: rows.filter((r) => r.grossMargin !== null && r.grossMargin < 0).length,
    underwaterMrr,
    underwaterMrrShare: totalMrr > 0 ? underwaterMrr / totalMrr : null,
    underwaterTokenCostShare: totalTokenCost30d > 0 ? underwaterCost / totalTokenCost30d : null,
    overageCount: rows.filter((r) => r.overage).length,
  };
}

// Economics by segment

export type SegmentEconomicsRow = {
  segment: string;
  customers: number;
  mrr: number;
  tokenCost30d: number;
  grossMargin: number | null; // (segment MRR - segment token cost) / segment MRR
  underwaterCount: number;
  overageCount: number;
};

/** The portfolio totals, one row per segment (enterprise, mid-market, SMB). */
export function calcEconomicsBySegment(rows: AccountEconomicsRow[]): SegmentEconomicsRow[] {
  const segments = [...new Set(rows.map((r) => r.segment))].sort((x, y) => segmentRank(x) - segmentRank(y));
  return segments.map((segment) => {
    const p = calcPortfolioEconomics(rows.filter((r) => r.segment === segment));
    return {
      segment,
      customers: p.customerCount,
      mrr: p.totalMrr,
      tokenCost30d: p.totalTokenCost30d,
      grossMargin: p.blendedGrossMargin,
      underwaterCount: p.underwaterCount,
      overageCount: p.overageCount,
    };
  });
}

// Token cost by model

export type ModelCostRow = { model: string; tokens: number; cost: number; share: number | null };

/** Customers' 30-day token cost and tokens per model, largest cost first. Share = model cost / total. */
export function calcTokenCostByModel(accounts: AccountRow[], usage: UsageRow[], prices: ModelPriceRow[], asOf: string): ModelCostRow[] {
  const customerIds = new Set(customersOnly(accounts).map((a) => a.id));
  const cost = usageCoster(prices);
  const { start, end } = usageWindow(asOf);
  const byModel = new Map<string, { tokens: number; cost: number }>();
  for (const u of usage) {
    const d = day(u.date);
    if (d < start || d > end || !customerIds.has(u.account_id)) continue;
    const m = byModel.get(u.model) ?? { tokens: 0, cost: 0 };
    m.tokens += u.input_tokens + u.output_tokens;
    m.cost += cost(u);
    byModel.set(u.model, m);
  }
  const total = [...byModel.values()].reduce((s, m) => s + m.cost, 0);
  return [...byModel.entries()]
    .map(([model, m]) => ({ model, tokens: m.tokens, cost: m.cost, share: total > 0 ? m.cost / total : null }))
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

// Lifecycle mix

export type LifecycleMixRow = { stage: LifecycleStage; customers: number; mrr: number };

/** Customers and MRR per lifecycle stage, in stage order (stages with no customers included as 0). */
export function calcLifecycleMix(rows: AccountEconomicsRow[]): LifecycleMixRow[] {
  return LIFECYCLE_STAGES.map((stage) => {
    const list = rows.filter((r) => r.lifecycleStage === stage);
    return { stage, customers: list.length, mrr: list.reduce((s, r) => s + r.mrr, 0) };
  });
}

// ---------------------------------------------------------------------------
// Monthly revenue vs token cost (whole company)
// ---------------------------------------------------------------------------

/** Usage history in the database: the 90 days before asOf. */
export const USAGE_HISTORY_DAYS = 90;

export function usageHistory(asOf: string): { start: string; end: string } {
  return { start: addDays(asOf, -USAGE_HISTORY_DAYS), end: addDays(asOf, -1) };
}

/** Calendar months (first day, YYYY-MM-01) that usage history covers from first day to last. */
export function fullUsageMonths(asOf: string): string[] {
  const { start, end } = usageHistory(asOf);
  const months: string[] = [];
  for (let m = monthStart(start); m <= end; m = addMonths(m, 1)) {
    const lastDay = addDays(addMonths(m, 1), -1);
    if (m >= start && lastDay <= end) months.push(m);
  }
  return months;
}

export type MonthlyRevenueCostRow = {
  month: string; // YYYY-MM-01
  revenue: number; // sum of invoices for the month
  tokenCost: number; // priced usage for the month
  grossMargin: number | null; // (revenue - token cost) / revenue
};

/**
 * For each complete month of usage history: revenue = all invoices for that
 * month; token cost = all usage that month, priced per model. Covers every
 * account, including churned ones while they were still paying and using.
 * Partial months are left out so they don't look like a drop in cost.
 */
export function calcMonthlyRevenueVsTokenCost(
  invoices: InvoiceRow[],
  usage: UsageRow[],
  prices: ModelPriceRow[],
  asOf: string,
): MonthlyRevenueCostRow[] {
  const months = fullUsageMonths(asOf);
  const revenue = new Map(months.map((m) => [m, 0]));
  const tokenCost = new Map(months.map((m) => [m, 0]));
  const cost = usageCoster(prices);
  for (const i of invoices) {
    const m = monthStart(day(i.month));
    if (revenue.has(m)) revenue.set(m, revenue.get(m)! + i.amount_usd);
  }
  for (const u of usage) {
    const m = monthStart(day(u.date));
    if (tokenCost.has(m)) tokenCost.set(m, tokenCost.get(m)! + cost(u));
  }
  return months.map((month) => {
    const rev = revenue.get(month)!;
    const tc = tokenCost.get(month)!;
    return { month, revenue: rev, tokenCost: tc, grossMargin: rev > 0 ? (rev - tc) / rev : null };
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
  grr: number | null; // gross revenue retention = (starting - downgrades - churned) / starting
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
    upgradedCount: 0, downgradedCount: 0, churnedCount: 0, nrr: null, grr: null,
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
  r.grr = r.startingMrr > 0 ? (r.startingMrr - r.downgrades - r.churnedMrr) / r.startingMrr : null;
  return r;
}

// ---------------------------------------------------------------------------
// NPS trend per customer
// ---------------------------------------------------------------------------

export type NpsResponseRow = { account_id: string; responded_at: string; score: number };

export type NpsTrendRow = {
  accountId: string;
  name: string;
  latestNps: number | null;
  latestNpsAt: string | null;
  previousNps: number | null;
  previousNpsAt: string | null;
  /** latest minus previous; null unless both exist. Negative = sentiment falling. */
  npsChange: number | null;
};

/**
 * Latest and previous NPS score per customer, from responses on or before
 * today (asOf). npsChange = latest - previous, computed here, never stored.
 */
export function calcNpsTrend(accounts: AccountRow[], responses: NpsResponseRow[], asOf: string): NpsTrendRow[] {
  const byAccount = new Map<string, NpsResponseRow[]>();
  for (const n of responses) {
    if (n.responded_at.slice(0, 10) > asOf) continue;
    byAccount.set(n.account_id, [...(byAccount.get(n.account_id) ?? []), n]);
  }
  return accounts
    .filter((a) => a.status === "customer")
    .map((a) => {
      const list = (byAccount.get(a.id) ?? []).sort((x, y) => Date.parse(y.responded_at) - Date.parse(x.responded_at));
      const [latest, previous] = list;
      return {
        accountId: a.id,
        name: a.name,
        latestNps: latest?.score ?? null,
        latestNpsAt: latest?.responded_at ?? null,
        previousNps: previous?.score ?? null,
        previousNpsAt: previous?.responded_at ?? null,
        npsChange: latest && previous ? latest.score - previous.score : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Usage trend per customer: last 30 days vs the 30 days before
// ---------------------------------------------------------------------------

export type UsageTrendRow = {
  accountId: string;
  tokensLast30d: number;
  tokensPrior30d: number;
  /** (last - prior) / prior; null when there was no prior usage. -0.25 = down 25%. */
  usageChange: number | null;
};

export function priorUsageWindow(asOf: string): { start: string; end: string } {
  const last = usageWindow(asOf);
  return { start: addDays(last.start, -USAGE_WINDOW_DAYS), end: addDays(last.start, -1) };
}

export function calcUsageTrend(accounts: AccountRow[], usage: UsageRow[], asOf: string): UsageTrendRow[] {
  const last = usageWindow(asOf);
  const prior = priorUsageWindow(asOf);
  const totals = new Map<string, { last: number; prior: number }>();
  for (const u of usage) {
    const d = day(u.date);
    const t = totals.get(u.account_id) ?? { last: 0, prior: 0 };
    const tokens = u.input_tokens + u.output_tokens;
    if (d >= last.start && d <= last.end) t.last += tokens;
    else if (d >= prior.start && d <= prior.end) t.prior += tokens;
    totals.set(u.account_id, t);
  }
  return customersOnly(accounts).map((a) => {
    const t = totals.get(a.id) ?? { last: 0, prior: 0 };
    return {
      accountId: a.id,
      tokensLast30d: t.last,
      tokensPrior30d: t.prior,
      usageChange: t.prior > 0 ? (t.last - t.prior) / t.prior : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Renewal risk
// ---------------------------------------------------------------------------

/** Renewal-risk rule settings. A customer is flagged when its renewal is
 *  within `renewalWithinDays` AND at least one of the signals fires. */
export const RENEWAL_RISK_RULES = {
  renewalWithinDays: 120,
  npsBelow: 7, // latest NPS below 7
  npsDropOf: -2, // nps_change of -2 or worse
  usageDropBelow: -0.2, // usage down more than 20%, last 30 days vs prior 30
} as const;

export const RENEWAL_RISK_SIGNALS = ["Low NPS", "NPS dropping", "Usage declining", "Underwater margin"] as const;
export type RenewalRiskSignal = (typeof RENEWAL_RISK_SIGNALS)[number];

export type RenewalRiskRow = {
  accountId: string;
  name: string;
  segment: string;
  owner: string;
  arr: number;
  renewalDate: string;
  daysToRenewal: number;
  latestNps: number | null;
  npsChange: number | null;
  usageChange: number | null;
  grossMargin: number | null;
  signals: RenewalRiskSignal[];
  /** From renewalRiskLevel(); the HubSpot sync sends this same value. Flagged rows are Medium or High. */
  level: RenewalRiskLevel;
};

export type RenewalRiskResult = {
  rows: RenewalRiskRow[]; // soonest renewal first
  atRiskArr: number;
  renewingCount: number; // customers renewing within the window, flagged or not
  renewingArr: number;
  byLevel: Record<"High" | "Medium", { count: number; arr: number }>;
};

export function calcRenewalRisk(
  accounts: AccountRow[],
  usage: UsageRow[],
  prices: ModelPriceRow[],
  nps: NpsResponseRow[],
  asOf: string,
): RenewalRiskResult {
  const R = RENEWAL_RISK_RULES;
  const margin = new Map(calcGrossMargin(accounts, usage, prices, asOf).map((r) => [r.accountId, r]));
  const trend = new Map(calcUsageTrend(accounts, usage, asOf).map((r) => [r.accountId, r]));
  const sentiment = new Map(calcNpsTrend(accounts, nps, asOf).map((r) => [r.accountId, r]));

  const renewing = customersOnly(accounts)
    .filter((a) => a.renewal_date !== null)
    .map((a) => ({ a, days: daysBetween(asOf, a.renewal_date!) }))
    .filter(({ days }) => days >= 0 && days <= R.renewalWithinDays);

  const rows: RenewalRiskRow[] = [];
  for (const { a, days } of renewing) {
    const m = margin.get(a.id)!;
    const t = trend.get(a.id)!;
    const s = sentiment.get(a.id)!;
    const signals: RenewalRiskSignal[] = [];
    if (s.latestNps !== null && s.latestNps < R.npsBelow) signals.push("Low NPS");
    if (s.npsChange !== null && s.npsChange <= R.npsDropOf) signals.push("NPS dropping");
    if (t.usageChange !== null && t.usageChange < R.usageDropBelow) signals.push("Usage declining");
    if (m.underwater) signals.push("Underwater margin");
    if (signals.length === 0) continue;
    rows.push({
      accountId: a.id,
      name: a.name,
      segment: a.segment,
      owner: a.owner,
      arr: a.mrr_usd * 12,
      renewalDate: a.renewal_date!,
      daysToRenewal: days,
      latestNps: s.latestNps,
      npsChange: s.npsChange,
      usageChange: t.usageChange,
      grossMargin: m.grossMargin,
      signals,
      level: renewalRiskLevel(signals.length),
    });
  }
  rows.sort((x, y) => x.daysToRenewal - y.daysToRenewal || y.arr - x.arr);
  const levelTotals = (level: RenewalRiskLevel) => {
    const at = rows.filter((r) => r.level === level);
    return { count: at.length, arr: at.reduce((s, r) => s + r.arr, 0) };
  };
  return {
    rows,
    atRiskArr: rows.reduce((s, r) => s + r.arr, 0),
    renewingCount: renewing.length,
    renewingArr: renewing.reduce((s, { a }) => s + a.mrr_usd * 12, 0),
    byLevel: { High: levelTotals("High"), Medium: levelTotals("Medium") },
  };
}

// ---------------------------------------------------------------------------
// Deal risk (open deals only)
// ---------------------------------------------------------------------------

/** Deal-risk rule settings, all in one place. */
export const DEAL_RISK_RULES = {
  /** Max days a deal should sit in each stage before it counts as stuck. */
  maxDaysInStage: { Discovery: 28, Demo: 28, Proposal: 42, Negotiation: 42 } as Record<string, number>,
  /** Stages where a missing executive sponsor is a risk. */
  sponsorRequiredStages: ["Proposal", "Negotiation"],
  noActivityDays: 21, // no activity in 21+ days
} as const;

export const DEAL_RISK_SIGNALS = ["No exec sponsor", "Stuck in stage", "No recent activity", "Close date passed", "No next step"] as const;
export type DealRiskSignal = (typeof DEAL_RISK_SIGNALS)[number];

export type DealRiskInput = OpportunityRow & {
  executive_sponsor: string | null;
  stage_entered_date: string | null;
  last_activity_date: string | null;
  next_step: string | null;
};

export type DealRiskRow = {
  opportunityId: string;
  accountId: string;
  accountName: string;
  type: string;
  stage: string;
  amount: number;
  closeDate: string;
  daysInStage: number | null;
  maxDaysInStage: number;
  daysSinceActivity: number | null;
  executiveSponsor: string | null;
  nextStep: string | null;
  signals: DealRiskSignal[];
};

export type DealRiskResult = {
  rows: DealRiskRow[]; // largest deal first
  atRiskPipeline: number;
  openCount: number;
  openPipeline: number;
};

/** Days an open deal has been in its current stage; null when the stage entry date is unknown. */
export function dealDaysInStage(o: Pick<DealRiskInput, "stage_entered_date">, asOf: string): number | null {
  return o.stage_entered_date ? daysBetween(o.stage_entered_date, asOf) : null;
}

export function calcDealRisk(opportunities: DealRiskInput[], accounts: AccountRow[], asOf: string): DealRiskResult {
  const R = DEAL_RISK_RULES;
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const open = opportunities.filter(isOpen);
  const rows: DealRiskRow[] = [];
  for (const o of open) {
    const daysInStage = dealDaysInStage(o, asOf);
    const daysSinceActivity = o.last_activity_date ? daysBetween(o.last_activity_date, asOf) : null;
    const maxDays = R.maxDaysInStage[o.stage];
    const signals: DealRiskSignal[] = [];
    if (!o.executive_sponsor && (R.sponsorRequiredStages as readonly string[]).includes(o.stage)) signals.push("No exec sponsor");
    if (daysInStage !== null && daysInStage > maxDays) signals.push("Stuck in stage");
    if (daysSinceActivity === null || daysSinceActivity >= R.noActivityDays) signals.push("No recent activity");
    if (o.close_date < asOf) signals.push("Close date passed");
    if (!o.next_step) signals.push("No next step");
    if (signals.length === 0) continue;
    rows.push({
      opportunityId: o.id,
      accountId: o.account_id,
      accountName: nameOf.get(o.account_id) ?? o.account_id,
      type: o.type,
      stage: o.stage,
      amount: o.amount_usd,
      closeDate: o.close_date,
      daysInStage,
      maxDaysInStage: maxDays,
      daysSinceActivity,
      executiveSponsor: o.executive_sponsor,
      nextStep: o.next_step,
      signals,
    });
  }
  rows.sort((x, y) => y.amount - x.amount);
  return {
    rows,
    atRiskPipeline: rows.reduce((s, r) => s + r.amount, 0),
    openCount: open.length,
    openPipeline: open.reduce((s, o) => s + o.amount_usd, 0),
  };
}

// ---------------------------------------------------------------------------
// Upcoming renewals and deals by calendar quarter (this quarter and next)
// ---------------------------------------------------------------------------

export const UPCOMING_TOP_N = 10;

export type Quarter = { label: string; start: string; end: string }; // e.g. Q4 2026, 2026-10-01..2026-12-31

/** Calendar quarter containing asOf, shifted by `offset` quarters (0 = this quarter, 1 = next). */
export function calendarQuarter(asOf: string, offset = 0): Quarter {
  const d = parseDate(asOf);
  const index = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) + offset;
  const year = Math.floor(index / 4);
  const q = index % 4;
  const start = isoDate(new Date(Date.UTC(year, q * 3, 1)));
  const end = isoDate(new Date(Date.UTC(year, q * 3 + 3, 0)));
  return { label: `Q${q + 1} ${year}`, start, end };
}

export type UpcomingRenewalRow = {
  accountId: string;
  name: string;
  segment: string;
  owner: string;
  arr: number;
  renewalDate: string;
  daysToRenewal: number;
};
export type UpcomingRenewalsQuarter = { quarter: Quarter; count: number; totalArr: number; top: UpcomingRenewalRow[] };

/** Customers renewing in this and next calendar quarter (from today on), largest ARR first. */
export function calcUpcomingRenewals(accounts: AccountRow[], asOf: string, topN = UPCOMING_TOP_N): UpcomingRenewalsQuarter[] {
  return [0, 1].map((offset) => {
    const quarter = calendarQuarter(asOf, offset);
    const from = offset === 0 ? asOf : quarter.start;
    const rows = customersOnly(accounts)
      .filter((a) => a.renewal_date !== null && a.renewal_date >= from && a.renewal_date <= quarter.end)
      .map((a) => ({
        accountId: a.id,
        name: a.name,
        segment: a.segment,
        owner: a.owner,
        arr: a.mrr_usd * 12,
        renewalDate: a.renewal_date!,
        daysToRenewal: daysBetween(asOf, a.renewal_date!),
      }))
      .sort((x, y) => y.arr - x.arr || x.renewalDate.localeCompare(y.renewalDate));
    return { quarter, count: rows.length, totalArr: rows.reduce((s, r) => s + r.arr, 0), top: rows.slice(0, topN) };
  });
}

export type UpcomingDealRow = {
  opportunityId: string;
  accountId: string;
  accountName: string;
  type: string;
  stage: string;
  amount: number;
  probability: number;
  closeDate: string;
};
export type UpcomingDealsQuarter = { quarter: Quarter; count: number; totalAmount: number; weightedAmount: number; top: UpcomingDealRow[] };

/** Open deals with a close date in this and next calendar quarter, largest amount first. */
export function calcUpcomingDeals(opportunities: OpportunityRow[], accounts: AccountRow[], asOf: string, topN = UPCOMING_TOP_N): UpcomingDealsQuarter[] {
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const open = opportunities.filter(isOpen);
  return [0, 1].map((offset) => {
    const quarter = calendarQuarter(asOf, offset);
    const deals = open
      .filter((o) => o.close_date >= quarter.start && o.close_date <= quarter.end)
      .sort((x, y) => y.amount_usd - x.amount_usd || x.close_date.localeCompare(y.close_date));
    return {
      quarter,
      count: deals.length,
      totalAmount: deals.reduce((s, o) => s + o.amount_usd, 0),
      weightedAmount: deals.reduce((s, o) => s + weighted(o), 0),
      top: deals.slice(0, topN).map((o) => ({
        opportunityId: o.id,
        accountId: o.account_id,
        accountName: nameOf.get(o.account_id) ?? o.account_id,
        type: o.type,
        stage: o.stage,
        amount: o.amount_usd,
        probability: o.probability,
        closeDate: o.close_date,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// CRM sync: one set of values per account and per deal, for HubSpot
// Reuses the calculators above; the sync script only reformats these values.
// ---------------------------------------------------------------------------

export const RENEWAL_RISK_LEVELS = ["Low", "Medium", "High"] as const;
export type RenewalRiskLevel = (typeof RENEWAL_RISK_LEVELS)[number];
export const DEAL_RISK_LEVELS = ["None", "Amber", "Red"] as const;
export type DealRiskLevel = (typeof DEAL_RISK_LEVELS)[number];

/** Renewal risk level from the number of renewal-risk signals: 0 = Low, 1 = Medium, 2+ = High.
 *  Customers not flagged (including renewals beyond the 120-day window) are Low. */
export function renewalRiskLevel(signalCount: number): RenewalRiskLevel {
  return signalCount >= 2 ? "High" : signalCount === 1 ? "Medium" : "Low";
}

/** Deal risk level from the number of deal-risk signals: 0 = None, 1 = Amber, 2+ = Red. */
export function dealRiskLevel(signalCount: number): DealRiskLevel {
  return signalCount >= 2 ? "Red" : signalCount === 1 ? "Amber" : "None";
}

export type CrmAccountRow = {
  accountId: string;
  name: string;
  status: AccountRow["status"];
  segment: string;
  /** Customer-only values; null for prospects and churned accounts. */
  arr: number | null;
  renewalDate: string | null;
  grossMargin: number | null; // decimal, 0.42 = 42%
  capacityUsed: number | null; // decimal, 0.42 = 42%
  latestNps: number | null;
  npsChange: number | null;
  renewalRisk: RenewalRiskLevel | null;
  hasOpenDeal: boolean;
};

export type CrmDealRow = {
  opportunityId: string;
  accountId: string;
  accountName: string;
  type: string; // new, expansion, renewal
  stage: string;
  forecastCategory: string; // Pipeline, Best Case, Commit, Closed, Omitted
  amount: number;
  closeDate: string;
  executiveSponsor: string | null;
  /** Open deals only; null for closed deals. */
  daysInStage: number | null;
  dealRisk: DealRiskLevel | null;
};

export type CrmSyncData = { accounts: CrmAccountRow[]; deals: CrmDealRow[] };

/** Every account and every deal, with the values the CRM sync sends. Uses AS_OF_DATE-style asOf, never the real clock. */
export function calcCrmSyncData(
  accounts: AccountRow[],
  deals: DealRiskInput[],
  usage: UsageRow[],
  prices: ModelPriceRow[],
  nps: NpsResponseRow[],
  asOf: string,
): CrmSyncData {
  const margin = new Map(calcGrossMargin(accounts, usage, prices, asOf).map((r) => [r.accountId, r.grossMargin]));
  const capacity = new Map(calcCapacity(accounts, usage, prices, asOf).map((r) => [r.accountId, r.capacityUsed]));
  const sentiment = new Map(calcNpsTrend(accounts, nps, asOf).map((r) => [r.accountId, r]));
  // Same level the Renewals page shows: both read RenewalRiskRow.level.
  const renewalLevels = new Map(calcRenewalRisk(accounts, usage, prices, nps, asOf).rows.map((r) => [r.accountId, r.level]));
  const dealSignals = new Map(calcDealRisk(deals, accounts, asOf).rows.map((r) => [r.opportunityId, r.signals.length]));
  const withOpenDeal = new Set(deals.filter(isOpen).map((o) => o.account_id));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  return {
    accounts: accounts.map((a) => {
      const isCustomer = a.status === "customer";
      const s = sentiment.get(a.id);
      return {
        accountId: a.id,
        name: a.name,
        status: a.status,
        segment: a.segment,
        arr: isCustomer ? a.mrr_usd * 12 : null,
        renewalDate: isCustomer ? a.renewal_date : null,
        grossMargin: isCustomer ? (margin.get(a.id) ?? null) : null,
        capacityUsed: isCustomer ? (capacity.get(a.id) ?? null) : null,
        latestNps: isCustomer ? (s?.latestNps ?? null) : null,
        npsChange: isCustomer ? (s?.npsChange ?? null) : null,
        renewalRisk: isCustomer ? (renewalLevels.get(a.id) ?? renewalRiskLevel(0)) : null,
        hasOpenDeal: withOpenDeal.has(a.id),
      };
    }),
    deals: deals.map((o) => {
      const open = isOpen(o);
      return {
        opportunityId: o.id,
        accountId: o.account_id,
        accountName: nameOf.get(o.account_id) ?? o.account_id,
        type: o.type,
        stage: o.stage,
        forecastCategory: o.forecast_category,
        amount: o.amount_usd,
        closeDate: o.close_date,
        executiveSponsor: o.executive_sponsor,
        daysInStage: open ? dealDaysInStage(o, asOf) : null,
        dealRisk: open ? dealRiskLevel(dealSignals.get(o.id) ?? 0) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Contract lines: usage, capacity and active users per product line
// (account-level metrics above are unchanged; this only adds a per-line view)
// ---------------------------------------------------------------------------

export const PRODUCTS = ["Core", "Extract", "Code Review"] as const;
export type Product = (typeof PRODUCTS)[number];

/** Each usage feature belongs to exactly one product. */
export const PRODUCT_OF_FEATURE: Record<string, Product> = {
  chat_assistant: "Core",
  document_summary: "Core",
  data_extraction: "Extract",
  code_review: "Code Review",
};

export const ADOPTION_DROP_BELOW = -0.3; // adoption drop when line usage falls more than 30%, last 30 days vs prior 30

export type ContractLineRow = {
  id: string;
  account_id: string;
  contract_id: string;
  product: string;
  quantity: number;
  unit_price_usd: number;
  arr_usd: number;
  purchase_date: string;
  renewal_date: string;
  term_months: number;
  auto_renew: boolean;
  status: "active" | "expired" | "churned";
  included_tokens_monthly: number;
};

export type FeatureUsageRow = {
  account_id: string;
  date: string;
  feature: string;
  input_tokens: number;
  output_tokens: number;
  active_users: number | null;
};

export type ContractLineMetrics = {
  lineId: string;
  accountId: string;
  contractId: string;
  product: string;
  arr: number;
  purchaseDate: string;
  renewalDate: string;
  status: ContractLineRow["status"];
  tokensLast30d: number;
  tokensPrior30d: number;
  /** (last - prior) / prior; null when there was no prior usage. */
  usageChange: number | null;
  /** 30-day tokens / the line's included monthly tokens; null when the allowance is 0. */
  capacityUsed: number | null;
  /** Average daily active users (sum over the line's features), last 30 days and prior 30. */
  avgUsersLast30d: number;
  avgUsersPrior30d: number;
  usersChange: number | null;
  /** Usage fell more than 30%. */
  adoptionDrop: boolean;
  /** No usage at all in the last 60 days (owned but not used). */
  notAdopted: boolean;
};

const PRODUCT_ORDER = (p: string) => {
  const i = (PRODUCTS as readonly string[]).indexOf(p);
  return i === -1 ? PRODUCTS.length : i;
};

/** One row per contract line: usage and active users from the line's features, last 30 days vs prior 30. */
export function calcContractLineMetrics(lines: ContractLineRow[], usage: FeatureUsageRow[], asOf: string): ContractLineMetrics[] {
  const last = usageWindow(asOf);
  const prior = priorUsageWindow(asOf);
  type T = { tl: number; tp: number; ul: number; up: number };
  const totals = new Map<string, T>(); // `${account}|${product}`
  for (const u of usage) {
    const product = PRODUCT_OF_FEATURE[u.feature];
    if (!product) throw new Error(`Usage feature "${u.feature}" has no product in PRODUCT_OF_FEATURE`);
    const d = day(u.date);
    const inLast = d >= last.start && d <= last.end;
    const inPrior = d >= prior.start && d <= prior.end;
    if (!inLast && !inPrior) continue;
    const k = `${u.account_id}|${product}`;
    const t = totals.get(k) ?? { tl: 0, tp: 0, ul: 0, up: 0 };
    const tokens = u.input_tokens + u.output_tokens;
    const users = u.active_users ?? 0;
    if (inLast) {
      t.tl += tokens;
      t.ul += users;
    } else {
      t.tp += tokens;
      t.up += users;
    }
    totals.set(k, t);
  }
  const change = (now: number, before: number) => (before > 0 ? (now - before) / before : null);
  return [...lines]
    .sort((a, b) => a.account_id.localeCompare(b.account_id) || PRODUCT_ORDER(a.product) - PRODUCT_ORDER(b.product))
    .map((l) => {
      const t = totals.get(`${l.account_id}|${l.product}`) ?? { tl: 0, tp: 0, ul: 0, up: 0 };
      const usageChange = change(t.tl, t.tp);
      return {
        lineId: l.id,
        accountId: l.account_id,
        contractId: l.contract_id,
        product: l.product,
        arr: l.arr_usd,
        purchaseDate: day(l.purchase_date),
        renewalDate: day(l.renewal_date),
        status: l.status,
        tokensLast30d: t.tl,
        tokensPrior30d: t.tp,
        usageChange,
        capacityUsed: l.included_tokens_monthly > 0 ? t.tl / l.included_tokens_monthly : null,
        avgUsersLast30d: t.ul / USAGE_WINDOW_DAYS,
        avgUsersPrior30d: t.up / USAGE_WINDOW_DAYS,
        usersChange: change(t.ul, t.up),
        adoptionDrop: usageChange !== null && usageChange < ADOPTION_DROP_BELOW,
        notAdopted: t.tl === 0 && t.tp === 0,
      };
    });
}

// ---------------------------------------------------------------------------
// Renewal deals with their contract lines (joined on opportunities.contract_id)
// ---------------------------------------------------------------------------

export type RenewalDealInput = {
  id: string;
  account_id: string;
  stage: string;
  amount_usd: number;
  close_date: string;
  contract_id: string | null;
};

export type AdoptionStatus = "Adoption drop" | "Not adopted" | "In use";

export type RenewalDealLine = {
  lineId: string;
  product: string;
  arr: number;
  adoptionStatus: AdoptionStatus;
  usageChange: number | null;
  /** The line has an adoption drop (usage down more than 30%). */
  downsellRisk: boolean;
};

export type RenewalDealRow = {
  opportunityId: string;
  accountId: string;
  accountName: string;
  owner: string;
  stage: string;
  open: boolean;
  closeDate: string;
  amount: number;
  contractId: string | null;
  /** The contract's active lines, in product order. Empty for a churned contract. */
  lines: RenewalDealLine[];
  linesArr: number;
  /** amount - linesArr. Positive = uplift, negative = reduction. Null when there are no active lines to compare with. */
  difference: number | null;
  differenceKind: "uplift" | "reduction" | "matches" | "no active lines";
  downsellRiskArr: number;
};

export type DownsellRiskSummary = { arr: number; lines: number; deals: number };

function adoptionStatus(m: ContractLineMetrics): AdoptionStatus {
  if (m.notAdopted) return "Not adopted";
  if (m.adoptionDrop) return "Adoption drop";
  return "In use";
}

/**
 * One row per renewal deal with its full amount, and the active lines of the
 * contract it renews. Lines are found by joining the deal's contract_id to the
 * lines' contract_id. Differences under $1 count as "matches" (cents rounding);
 * a deal whose contract has no active lines (churned, or not linked) has no difference.
 */
export function calcRenewalDeals(deals: RenewalDealInput[], lineMetrics: ContractLineMetrics[], accounts: AccountRow[]): RenewalDealRow[] {
  const account = new Map(accounts.map((a) => [a.id, a]));
  const linesByContract = new Map<string, ContractLineMetrics[]>();
  for (const m of lineMetrics) {
    if (m.status !== "active") continue;
    const list = linesByContract.get(m.contractId);
    if (list) list.push(m);
    else linesByContract.set(m.contractId, [m]);
  }
  return deals.map((d) => {
    const lines: RenewalDealLine[] = (d.contract_id ? linesByContract.get(d.contract_id) ?? [] : [])
      .slice()
      .sort((a, b) => PRODUCT_ORDER(a.product) - PRODUCT_ORDER(b.product))
      .map((m) => ({
        lineId: m.lineId,
        product: m.product,
        arr: m.arr,
        adoptionStatus: adoptionStatus(m),
        usageChange: m.usageChange,
        downsellRisk: m.adoptionDrop,
      }));
    const linesArr = lines.reduce((s, l) => s + l.arr, 0);
    const difference = lines.length > 0 ? d.amount_usd - linesArr : null;
    const a = account.get(d.account_id);
    return {
      opportunityId: d.id,
      accountId: d.account_id,
      accountName: a?.name ?? d.account_id,
      owner: a?.owner ?? "",
      stage: d.stage,
      open: (OPEN_STAGES as readonly string[]).includes(d.stage),
      closeDate: day(d.close_date),
      amount: d.amount_usd,
      contractId: d.contract_id,
      lines,
      linesArr,
      difference,
      differenceKind: difference === null ? "no active lines" : Math.abs(difference) < 1 ? "matches" : difference > 0 ? "uplift" : "reduction",
      downsellRiskArr: lines.filter((l) => l.downsellRisk).reduce((s, l) => s + l.arr, 0),
    };
  });
}

/** ARR on lines with an adoption drop, across the given deals. A contract is counted once even if two deals point at it. */
export function calcDownsellRisk(rows: RenewalDealRow[]): DownsellRiskSummary {
  const seen = new Set<string>();
  let arr = 0;
  let lines = 0;
  let deals = 0;
  for (const r of rows) {
    if (r.downsellRiskArr > 0) deals++;
    for (const l of r.lines) {
      if (!l.downsellRisk || seen.has(l.lineId)) continue;
      seen.add(l.lineId);
      arr += l.arr;
      lines++;
    }
  }
  return { arr, lines, deals };
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

const PARALLEL_PAGES = 6; // pages read at the same time after the first

/**
 * Reads every matching row, 1,000 at a time, in a stable order. The first
 * page also returns the total row count, so the rest are read in parallel.
 */
async function fetchAll(table: string, columns: string, orderBy: string[], filter?: (q: Query) => Query): Promise<Record<string, unknown>[]> {
  const readPage = async (from: number, withCount: boolean) => {
    let q = db().from(table).select(columns, withCount ? { count: "exact" } : undefined) as unknown as Query;
    if (filter) q = filter(q);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error, count } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    return { rows: (data ?? []) as unknown as Record<string, unknown>[], count };
  };

  const first = await readPage(0, true);
  if (first.rows.length < PAGE_SIZE) return first.rows;
  if (first.count === null || first.count === undefined) throw new Error(`Reading ${table} failed: no row count returned`);

  const starts: number[] = [];
  for (let from = PAGE_SIZE; from < first.count; from += PAGE_SIZE) starts.push(from);
  const pages: Record<string, unknown>[][] = new Array(starts.length);
  let next = 0;
  const worker = async () => {
    while (next < starts.length) {
      const k = next++;
      pages[k] = (await readPage(starts[k], false)).rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PAGES, starts.length) }, worker));
  const rows = [first.rows, ...pages].flat();
  if (rows.length !== first.count) throw new Error(`Reading ${table} failed: expected ${first.count} rows, got ${rows.length}`);
  return rows;
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function loadAccounts(filter?: (q: Query) => Query): Promise<AccountRow[]> {
  const rows = await fetchAll(
    "accounts",
    "id, name, status, segment, mrr_usd, included_tokens_monthly, start_date, renewal_date, churn_date, owner",
    ["id"],
    filter,
  );
  return rows.map((r) => ({
    id: str(r.id),
    name: str(r.name),
    status: str(r.status) as AccountRow["status"],
    segment: str(r.segment),
    mrr_usd: num(r.mrr_usd),
    included_tokens_monthly: num(r.included_tokens_monthly),
    start_date: strOrNull(r.start_date),
    renewal_date: strOrNull(r.renewal_date),
    churn_date: strOrNull(r.churn_date),
    owner: str(r.owner),
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

async function loadUsageAndPrices(asOf: string, from?: string): Promise<{ usage: UsageRow[]; prices: ModelPriceRow[] }> {
  const window = usageWindow(asOf);
  const start = from && from < window.start ? from : window.start;
  const end = window.end;
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

async function loadInvoices(upToMonth: string): Promise<InvoiceRow[]> {
  const rows = await fetchAll("invoices", "account_id, month, amount_usd", ["account_id", "month"], (q) => q.lte("month", upToMonth));
  return rows.map((r) => ({ account_id: str(r.account_id), month: str(r.month), amount_usd: num(r.amount_usd) }));
}

export async function getNrr90d(asOf: string = AS_OF_DATE): Promise<NrrResult> {
  const [accounts, invoices] = await Promise.all([loadAccounts((q) => q.neq("status", "prospect")), loadInvoices(monthStart(asOf))]);
  return calcNrr90d(accounts, invoices, asOf);
}

async function loadNps(): Promise<NpsResponseRow[]> {
  const rows = await fetchAll("nps_responses", "account_id, responded_at, score", ["id"]);
  return rows.map((r) => ({ account_id: str(r.account_id), responded_at: str(r.responded_at), score: num(r.score) }));
}

export async function getNpsTrend(asOf: string = AS_OF_DATE): Promise<NpsTrendRow[]> {
  const [accounts, responses] = await Promise.all([loadAccounts(customerFilter), loadNps()]);
  return calcNpsTrend(accounts, responses, asOf);
}

export async function getRenewalRisk(asOf: string = AS_OF_DATE): Promise<RenewalRiskResult> {
  const [accounts, { usage, prices }, nps] = await Promise.all([
    loadAccounts(customerFilter),
    loadUsageAndPrices(asOf, priorUsageWindow(asOf).start),
    loadNps(),
  ]);
  return calcRenewalRisk(accounts, usage, prices, nps, asOf);
}

export async function getUpcomingRenewals(asOf: string = AS_OF_DATE): Promise<UpcomingRenewalsQuarter[]> {
  return calcUpcomingRenewals(await loadAccounts(customerFilter), asOf);
}

export async function getUpcomingDeals(asOf: string = AS_OF_DATE): Promise<UpcomingDealsQuarter[]> {
  const [accounts, opportunities] = await Promise.all([loadAccounts(), loadOpportunities((q) => q.in("stage", [...OPEN_STAGES]))]);
  return calcUpcomingDeals(opportunities, accounts, asOf);
}

async function loadOpenDealsWithRiskFields(): Promise<DealRiskInput[]> {
  return loadDealsWithRiskFields((q) => q.in("stage", [...OPEN_STAGES]));
}

async function loadDealsWithRiskFields(filter?: (q: Query) => Query): Promise<DealRiskInput[]> {
  const rows = await fetchAll(
    "opportunities",
    "id, account_id, type, source, stage, forecast_category, amount_usd, probability, created_date, close_date, executive_sponsor, stage_entered_date, last_activity_date, next_step",
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
    executive_sponsor: strOrNull(r.executive_sponsor),
    stage_entered_date: strOrNull(r.stage_entered_date),
    last_activity_date: strOrNull(r.last_activity_date),
    next_step: strOrNull(r.next_step),
  }));
}

export async function getDealRisk(asOf: string = AS_OF_DATE): Promise<DealRiskResult> {
  const [accounts, opportunities] = await Promise.all([loadAccounts(), loadOpenDealsWithRiskFields()]);
  return calcDealRisk(opportunities, accounts, asOf);
}

/** All accounts and all deals with the values the HubSpot sync sends. */
export async function getCrmSyncData(asOf: string = AS_OF_DATE): Promise<CrmSyncData> {
  const [accounts, deals, { usage, prices }, nps] = await Promise.all([
    loadAccounts(),
    loadDealsWithRiskFields(),
    loadUsageAndPrices(asOf, priorUsageWindow(asOf).start),
    loadNps(),
  ]);
  return calcCrmSyncData(accounts, deals, usage, prices, nps, asOf);
}

// ---------------------------------------------------------------------------
// Account page: one account with its contract lines
// ---------------------------------------------------------------------------

async function loadContractLines(accountId?: string): Promise<ContractLineRow[]> {
  const rows = await fetchAll(
    "contract_lines",
    "id, account_id, contract_id, product, quantity, unit_price_usd, arr_usd, purchase_date, renewal_date, term_months, auto_renew, status, included_tokens_monthly",
    ["id"],
    accountId ? (q) => q.eq("account_id", accountId) : undefined,
  );
  return rows.map((r) => ({
    id: str(r.id),
    account_id: str(r.account_id),
    contract_id: str(r.contract_id),
    product: str(r.product),
    quantity: num(r.quantity),
    unit_price_usd: num(r.unit_price_usd),
    arr_usd: num(r.arr_usd),
    purchase_date: str(r.purchase_date),
    renewal_date: str(r.renewal_date),
    term_months: num(r.term_months),
    auto_renew: Boolean(r.auto_renew),
    status: str(r.status) as ContractLineRow["status"],
    included_tokens_monthly: num(r.included_tokens_monthly),
  }));
}

/** Usage by feature for the last 60 days (the two 30-day windows), with active users. */
async function loadFeatureUsage(asOf: string, accountId?: string): Promise<FeatureUsageRow[]> {
  const prior = priorUsageWindow(asOf);
  const last = usageWindow(asOf);
  const rows = await fetchAll(
    "usage_daily",
    "account_id, date, feature, input_tokens, output_tokens, active_users",
    ["account_id", "date", "feature", "model"],
    (q) => {
      const ranged = q.gte("date", prior.start).lte("date", last.end);
      return accountId ? ranged.eq("account_id", accountId) : ranged;
    },
  );
  return rows.map((r) => ({
    account_id: str(r.account_id),
    date: str(r.date),
    feature: str(r.feature),
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    active_users: r.active_users === null || r.active_users === undefined ? null : num(r.active_users),
  }));
}

/** Renewal deals with the contract they renew (reads opportunities.contract_id; adds no columns). */
async function loadRenewalDeals(filter?: (q: Query) => Query): Promise<RenewalDealInput[]> {
  const rows = await fetchAll("opportunities", "id, account_id, stage, amount_usd, close_date, contract_id", ["id"], (q) => {
    const renewals = q.eq("type", "renewal");
    return filter ? filter(renewals) : renewals;
  });
  return rows.map((r) => ({
    id: str(r.id),
    account_id: str(r.account_id),
    stage: str(r.stage),
    amount_usd: num(r.amount_usd),
    close_date: str(r.close_date),
    contract_id: strOrNull(r.contract_id),
  }));
}

export type RenewalDealsResult = {
  deals: RenewalDealRow[]; // open renewal deals, soonest close first
  downsellRisk: DownsellRiskSummary; // on the contracts these open deals renew
  downsellRiskAllCustomers: { arr: number; lines: number; contracts: number }; // every active line with an adoption drop, for context
};

/** Open renewal deals with their contract lines, and the ARR at downsell risk. */
export async function getRenewalDeals(asOf: string = AS_OF_DATE): Promise<RenewalDealsResult> {
  const [accounts, deals, lines, usage] = await Promise.all([
    loadAccounts(),
    loadRenewalDeals((q) => q.in("stage", [...OPEN_STAGES])),
    loadContractLines(),
    loadFeatureUsage(asOf),
  ]);
  const metrics = calcContractLineMetrics(lines, usage, asOf);
  const rows = calcRenewalDeals(deals, metrics, accounts).sort(
    (a, b) => a.closeDate.localeCompare(b.closeDate) || b.amount - a.amount || a.opportunityId.localeCompare(b.opportunityId),
  );
  const allActive = metrics.filter((m) => m.status === "active" && m.adoptionDrop);
  return {
    deals: rows,
    downsellRisk: calcDownsellRisk(rows),
    downsellRiskAllCustomers: {
      arr: allActive.reduce((s, m) => s + m.arr, 0),
      lines: allActive.length,
      contracts: new Set(allActive.map((m) => m.contractId)).size,
    },
  };
}

export type AccountPageData = {
  account: AccountRow & { seats: number | null; arr: number };
  renewalRiskLevel: RenewalRiskLevel | null; // null when not renewing within the risk window
  products: ContractLineMetrics[];
  renewalDeals: RenewalDealRow[]; // every renewal deal for this account, latest close first
};

/** One account, its renewal-risk level, its contract lines with per-line usage, and its renewal deals. Null if the account doesn't exist. */
export async function getAccountPageData(accountId: string, asOf: string = AS_OF_DATE): Promise<AccountPageData | null> {
  const [accounts, seatRows, lines, usage, deals, risk] = await Promise.all([
    loadAccounts((q) => q.eq("id", accountId)),
    fetchAll("accounts", "id, seats", ["id"], (q) => q.eq("id", accountId)),
    loadContractLines(accountId),
    loadFeatureUsage(asOf, accountId),
    loadRenewalDeals((q) => q.eq("account_id", accountId)),
    getRenewalRisk(asOf),
  ]);
  const account = accounts[0];
  if (!account) return null;
  const seats = seatRows[0]?.seats;
  const products = calcContractLineMetrics(lines, usage, asOf);
  return {
    account: { ...account, seats: seats === null || seats === undefined ? null : num(seats), arr: account.status === "customer" ? account.mrr_usd * 12 : 0 },
    renewalRiskLevel: risk.rows.find((r) => r.accountId === accountId)?.level ?? null,
    products,
    renewalDeals: calcRenewalDeals(deals, products, accounts).sort(
      (a, b) => b.closeDate.localeCompare(a.closeDate) || a.opportunityId.localeCompare(b.opportunityId),
    ),
  };
}

// ---------------------------------------------------------------------------
// Workspace snapshot: one compact bundle of the numbers above, sent to Claude
// as the only data the Workspace analyst may answer from. Numbers are rounded
// for size; nothing new is calculated here.
// ---------------------------------------------------------------------------

const r0 = (n: number) => Math.round(n);
const r3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);

export async function getWorkspaceSnapshot(asOf: string = AS_OF_DATE) {
  const [home, renewalRisk, openDeals, nps, upcomingRenewals, upcomingDeals] = await Promise.all([
    getHomePageData(asOf),
    getRenewalRisk(asOf),
    loadOpenDealsWithRiskFields(),
    getNpsTrend(asOf),
    getUpcomingRenewals(asOf),
    getUpcomingDeals(asOf),
  ]);
  const accounts = await loadAccounts();
  const dealRisk = calcDealRisk(openDeals, accounts, asOf);
  const npsById = new Map(nps.map((n) => [n.accountId, n]));
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const usage = new Map(renewalRisk.rows.map((r) => [r.accountId, r.usageChange]));

  return {
    as_of_date: asOf,
    notes: {
      money: "USD. ARR = MRR x 12. Token cost and gross margin are for the last 30 days.",
      gross_margin: "(MRR - 30-day token cost) / MRR. Underwater = margin below 30%. Overage = 30-day tokens above included monthly tokens.",
      quarters: "Calendar quarters. this_quarter = " + upcomingRenewals[0].quarter.label + ", next_quarter = " + upcomingRenewals[1].quarter.label + ".",
      renewal_risk_rule: RENEWAL_RISK_RULES,
      deal_risk_rule: DEAL_RISK_RULES,
    },
    kpis: {
      arr: r0(home.arr.totalArr),
      customers: home.arr.customerCount,
      top10_arr_share: r3(home.arr.top10Share),
      arr_by_segment: home.arr.bySegment.map((x) => ({ segment: x.segment, arr: r0(x.arr), customers: x.customers })),
      open_pipeline: { value: r0(home.pipeline.total.value), weighted: r0(home.pipeline.total.weightedValue), deals: home.pipeline.total.count },
      pipeline_by_stage: home.pipeline.byStage.map((x) => ({ stage: x.key, value: r0(x.value), deals: x.count })),
      win_rate_last_6_months: { overall: r3(home.winRate.winRate), won: home.winRate.won, lost: home.winRate.lost, by_type: home.winRate.byType.map((t) => ({ type: t.type, win_rate: r3(t.winRate), won: t.won, lost: t.lost })) },
      avg_sales_cycle_days: home.winRate.avgSalesCycleDays === null ? null : r0(home.winRate.avgSalesCycleDays),
      token_cost_30d: r0(home.portfolio.totalTokenCost30d),
      blended_gross_margin: r3(home.portfolio.blendedGrossMargin),
      underwater_accounts: home.portfolio.underwaterCount,
      overage_accounts: home.portfolio.overageCount,
      margin_by_segment: home.bySegment.map((x) => ({ segment: x.segment, gross_margin: r3(x.grossMargin), customers: x.customers, underwater: x.underwaterCount })),
      token_cost_by_model_30d: home.tokenCostByModel.map((m) => ({ model: m.model, cost: r0(m.cost), share: r3(m.share) })),
      nrr_last_90_days: {
        nrr: r3(home.nrr.nrr),
        grr: r3(home.nrr.grr),
        starting_mrr: r0(home.nrr.startingMrr),
        upgrades: r0(home.nrr.upgrades),
        upgraded_accounts: home.nrr.upgradedCount,
        downgrades: r0(home.nrr.downgrades),
        downgraded_accounts: home.nrr.downgradedCount,
        churned_mrr: r0(home.nrr.churnedMrr),
        churned_accounts: home.nrr.churnedCount,
      },
      monthly_revenue_vs_token_cost: home.monthly.map((m) => ({ month: m.month, revenue: r0(m.revenue), token_cost: r0(m.tokenCost), gross_margin: r3(m.grossMargin) })),
    },
    customer_accounts: home.accounts.map((a) => ({
      id: a.accountId,
      name: a.name,
      segment: a.segment,
      owner: a.owner,
      customer_since: a.startDate,
      lifecycle: a.lifecycleStage,
      renewal_date: a.renewalDate,
      mrr: r0(a.mrr),
      token_cost_30d: r0(a.tokenCost30d),
      gross_margin: r3(a.grossMargin),
      capacity_used: r3(a.capacityUsed),
      underwater: a.underwater,
      overage: a.overage,
      latest_nps: npsById.get(a.accountId)?.latestNps ?? null,
      nps_change: npsById.get(a.accountId)?.npsChange ?? null,
      usage_change_30d: r3(usage.get(a.accountId) ?? null),
    })),
    renewals_by_quarter: upcomingRenewals.map((q) => ({ quarter: q.quarter.label, renewals: q.count, arr: r0(q.totalArr) })),
    renewal_risk_flags: {
      window_days: RENEWAL_RISK_RULES.renewalWithinDays,
      at_risk_arr: r0(renewalRisk.atRiskArr),
      renewing_accounts: renewalRisk.renewingCount,
      flagged: renewalRisk.rows.map((r) => ({ id: r.accountId, name: r.name, arr: r0(r.arr), renewal_date: r.renewalDate, days_to_renewal: r.daysToRenewal, latest_nps: r.latestNps, nps_change: r.npsChange, usage_change_30d: r3(r.usageChange), gross_margin: r3(r.grossMargin), signals: r.signals })),
    },
    deals_by_quarter: upcomingDeals.map((q) => ({ quarter: q.quarter.label, open_deals: q.count, value: r0(q.totalAmount), weighted: r0(q.weightedAmount) })),
    open_deals: openDeals.map((o) => ({
      id: o.id,
      account: nameOf.get(o.account_id) ?? o.account_id,
      type: o.type,
      stage: o.stage,
      amount: r0(o.amount_usd),
      probability: o.probability,
      close_date: o.close_date,
      stage_entered: o.stage_entered_date,
      last_activity: o.last_activity_date,
      executive_sponsor: o.executive_sponsor,
      next_step: o.next_step,
    })),
    deal_risk_flags: {
      at_risk_pipeline: r0(dealRisk.atRiskPipeline),
      flagged: dealRisk.rows.map((d) => ({ id: d.opportunityId, account: d.accountName, amount: r0(d.amount), stage: d.stage, days_in_stage: d.daysInStage, days_since_activity: d.daysSinceActivity, signals: d.signals })),
    },
  };
}

export async function getMonthlyRevenueVsTokenCost(asOf: string = AS_OF_DATE): Promise<MonthlyRevenueCostRow[]> {
  const months = fullUsageMonths(asOf);
  const [invoices, { usage, prices }] = await Promise.all([loadInvoices(monthStart(asOf)), loadUsageAndPrices(asOf, months[0])]);
  return calcMonthlyRevenueVsTokenCost(invoices, usage, prices, asOf);
}

export type HomePageData = {
  asOf: string;
  arr: ArrResult;
  pipeline: PipelineResult;
  winRate: WinRateResult;
  accounts: AccountEconomicsRow[];
  portfolio: PortfolioEconomics;
  bySegment: SegmentEconomicsRow[];
  tokenCostByModel: ModelCostRow[];
  lifecycleMix: LifecycleMixRow[];
  monthly: MonthlyRevenueCostRow[];
  nrr: NrrResult;
};

/** Everything the home page shows. Reads each table once, then runs the calculators. */
export async function getHomePageData(asOf: string = AS_OF_DATE): Promise<HomePageData> {
  const months = fullUsageMonths(asOf);
  const [accounts, opportunities, invoices, { usage, prices }] = await Promise.all([
    loadAccounts(),
    loadOpportunities(),
    loadInvoices(monthStart(asOf)),
    loadUsageAndPrices(asOf, months[0]),
  ]);
  const economics = calcAccountEconomics(accounts, usage, prices, asOf);
  return {
    asOf,
    arr: calcArr(accounts),
    pipeline: calcPipeline(opportunities),
    winRate: calcWinRateAndCycle(opportunities, asOf),
    accounts: economics,
    portfolio: calcPortfolioEconomics(economics),
    bySegment: calcEconomicsBySegment(economics),
    tokenCostByModel: calcTokenCostByModel(accounts, usage, prices, asOf),
    lifecycleMix: calcLifecycleMix(economics),
    monthly: calcMonthlyRevenueVsTokenCost(invoices, usage, prices, asOf),
    nrr: calcNrr90d(accounts, invoices, asOf),
  };
}
