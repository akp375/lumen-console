// Tests for src/lib/metrics.ts against a tiny hand-made dataset.
// Run with: npm test
//
// "Today" in these tests is fixed at 2026-11-13, so they never depend on the
// real clock or on AS_OF_DATE. Key dates that follow from it:
//   30-day usage window: 2026-10-14 to 2026-11-12 (today excluded)
//   win-rate window:     closed after 2026-05-13, up to 2026-11-13
//   NRR start:           2026-08-15 -> start month 2026-08, end month 2026-11

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcArr,
  calcPipeline,
  calcWinRateAndCycle,
  calcTokenCost30d,
  calcGrossMargin,
  calcCapacity,
  calcAccountEconomics,
  calcPortfolioEconomics,
  calcEconomicsBySegment,
  calcTokenCostByModel,
  calcLifecycle,
  calcLifecycleMix,
  calcMonthlyRevenueVsTokenCost,
  fullUsageMonths,
  calcNrr90d,
  calcNpsTrend,
  calcUsageTrend,
  calcRenewalRisk,
  calcDealRisk,
  calendarQuarter,
  calcUpcomingRenewals,
  calcUpcomingDeals,
  calcCrmSyncData,
  decideRenewalRisk,
  calcRenewalDealCoverage,
  RENEWAL_RISK_RULES,
  dealRiskLevel,
  type DealRiskInput,
  usageWindow,
  type AccountRow,
  type OpportunityRow,
  type UsageRow,
  type ModelPriceRow,
  type InvoiceRow,
} from "./metrics.ts";

const TODAY = "2026-11-13";

function close(actual: number | null, expected: number, label = "") {
  assert.ok(actual !== null, `${label} should not be null`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label} expected ${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Hand-made dataset
// ---------------------------------------------------------------------------

const acc = (a: Partial<AccountRow> & Pick<AccountRow, "id" | "status">): AccountRow => ({
  name: a.id,
  segment: "SMB",
  mrr_usd: 0,
  included_tokens_monthly: 0,
  start_date: null,
  renewal_date: null,
  churn_date: null,
  owner: "Owner",
  ...a,
});

const ACCOUNTS: AccountRow[] = [
  // A1: long-time customer, upgraded since August
  acc({ id: "A1", status: "customer", mrr_usd: 1000, included_tokens_monthly: 10_000_000, start_date: "2025-01-10" }),
  // A2: long-time customer, downgraded since August, heavy usage
  acc({ id: "A2", status: "customer", mrr_usd: 500, included_tokens_monthly: 2_000_000, start_date: "2025-06-01" }),
  // A3: joined 2026-10-01 (inside the NRR period); sits exactly on both thresholds
  acc({ id: "A3", status: "customer", mrr_usd: 200, included_tokens_monthly: 108_000_000, start_date: "2026-10-01" }),
  // P1: prospect - never counts toward customer metrics
  acc({ id: "P1", status: "prospect" }),
  // C1: churned 2026-09-20 (after the NRR start date, so it is in the NRR cohort)
  acc({ id: "C1", status: "churned", start_date: "2024-03-01", churn_date: "2026-09-20" }),
  // C2: churned 2026-06-01 (before the NRR start date, so it is not in the cohort)
  acc({ id: "C2", status: "churned", start_date: "2023-01-01", churn_date: "2026-06-01" }),
];

const opp = (o: Partial<OpportunityRow> & Pick<OpportunityRow, "id" | "stage">): OpportunityRow => ({
  account_id: "A1",
  type: "new",
  source: "inbound",
  forecast_category: "Pipeline",
  amount_usd: 0,
  probability: 0,
  created_date: "2026-10-01",
  close_date: "2026-12-01",
  ...o,
});

const OPPORTUNITIES: OpportunityRow[] = [
  // Open deals
  opp({ id: "O1", account_id: "A1", type: "expansion", source: "inbound", stage: "Discovery", forecast_category: "Pipeline", amount_usd: 10_000, probability: 10 }),
  opp({ id: "O2", account_id: "P1", type: "new", source: "outbound", stage: "Demo", forecast_category: "Pipeline", amount_usd: 20_000, probability: 25 }),
  opp({ id: "O3", account_id: "P1", type: "new", source: "inbound", stage: "Proposal", forecast_category: "Best Case", amount_usd: 40_000, probability: 50 }),
  opp({ id: "O4", account_id: "A2", type: "renewal", source: "existing customer", stage: "Negotiation", forecast_category: "Commit", amount_usd: 6_000, probability: 70 }),
  // Closed in the last 6 months
  opp({ id: "W1", account_id: "A3", type: "new", source: "partner", stage: "Closed Won", forecast_category: "Closed", amount_usd: 2_400, probability: 100, created_date: "2026-08-02", close_date: "2026-09-01" }), // 30 days
  opp({ id: "W2", account_id: "A1", type: "expansion", source: "existing customer", stage: "Closed Won", forecast_category: "Closed", amount_usd: 12_000, probability: 100, created_date: "2026-06-01", close_date: "2026-07-21" }), // 50 days
  opp({ id: "L1", account_id: "C1", type: "renewal", source: "existing customer", stage: "Closed Lost", forecast_category: "Omitted", amount_usd: 3_600, created_date: "2026-08-01", close_date: "2026-09-15" }),
  opp({ id: "L2", account_id: "P1", type: "new", source: "outbound", stage: "Closed Lost", forecast_category: "Omitted", amount_usd: 5_000, created_date: "2026-04-01", close_date: "2026-06-10" }),
  // Closed too long ago (excluded)
  opp({ id: "W3", stage: "Closed Won", forecast_category: "Closed", amount_usd: 9_999, probability: 100, created_date: "2026-05-01", close_date: "2026-05-13" }), // exactly 6 months ago: excluded
  opp({ id: "L3", stage: "Closed Lost", forecast_category: "Omitted", amount_usd: 9_999, created_date: "2026-01-01", close_date: "2026-03-01" }),
];

// Prices per million tokens: big = $10 in / $50 out, small = $1 in / $5 out
const PRICES: ModelPriceRow[] = [
  { model: "big", input_usd_per_million: 10, output_usd_per_million: 50 },
  { model: "small", input_usd_per_million: 1, output_usd_per_million: 5 },
];

const usageRow = (account_id: string, date: string, model: string, input_tokens: number, output_tokens: number): UsageRow => ({
  account_id, date, model, input_tokens, output_tokens,
});

const USAGE: UsageRow[] = [
  // A1 inside the window: $20 + $4 = $24, 3.6M tokens
  usageRow("A1", "2026-11-01", "big", 1_000_000, 200_000), // 1M x $10 + 0.2M x $50 = $10 + $10 = $20
  usageRow("A1", "2026-10-14", "small", 2_000_000, 400_000), // first day of window: 2M x $1 + 0.4M x $5 = $2 + $2 = $4
  // A1 outside the window (must be ignored)
  usageRow("A1", "2026-10-13", "big", 9_000_000, 0), // the day before the window
  usageRow("A1", "2026-11-13", "big", 9_000_000, 0), // today
  // A2: 20M x $10 + 4M x $50 = $200 + $200 = $400, 24M tokens
  usageRow("A2", "2026-11-12", "big", 20_000_000, 4_000_000), // last day of window
  // A3: 100M x $1 + 8M x $5 = $100 + $40 = $140, 108M tokens
  usageRow("A3", "2026-11-05", "small", 100_000_000, 8_000_000),
  // C1 (churned) inside the window: not a customer, must not appear
  usageRow("C1", "2026-10-20", "big", 5_000_000, 1_000_000),
];

const INVOICES: InvoiceRow[] = [
  // A1: $800 in August -> $1,000 in November (upgrade +$200)
  { account_id: "A1", month: "2026-07-01", amount_usd: 800 },
  { account_id: "A1", month: "2026-08-01", amount_usd: 800 },
  { account_id: "A1", month: "2026-11-01", amount_usd: 1000 },
  // A2: $600 in August -> $500 in November (downgrade -$100)
  { account_id: "A2", month: "2026-08-01", amount_usd: 600 },
  { account_id: "A2", month: "2026-11-01", amount_usd: 500 },
  // A3: joined in October - excluded from NRR
  { account_id: "A3", month: "2026-10-01", amount_usd: 200 },
  { account_id: "A3", month: "2026-11-01", amount_usd: 200 },
  // C1: $300 in August, billed to August, churned in September (churn -$300)
  { account_id: "C1", month: "2026-08-01", amount_usd: 300 },
  // C2: churned before the period - excluded
  { account_id: "C2", month: "2026-05-01", amount_usd: 400 },
];

// ---------------------------------------------------------------------------
// 1. ARR
// ---------------------------------------------------------------------------

test("ARR: MRR x 12 for customers only", () => {
  const r = calcArr(ACCOUNTS);
  // A1 1,000 x 12 = 12,000; A2 500 x 12 = 6,000; A3 200 x 12 = 2,400. Total 20,400.
  assert.equal(r.totalArr, 20_400);
  assert.equal(r.customerCount, 3);
  assert.deepEqual(
    r.byAccount.map((a) => [a.accountId, a.arr]),
    [["A1", 12_000], ["A2", 6_000], ["A3", 2_400]],
  );
});

// ---------------------------------------------------------------------------
// 2. Pipeline
// ---------------------------------------------------------------------------

test("Pipeline: open deals only, with count, value and weighted value", () => {
  const r = calcPipeline(OPPORTUNITIES);
  const rows = (b: { key: string; count: number; value: number; weightedValue: number }[]) =>
    b.map((x) => [x.key, x.count, x.value, x.weightedValue]);

  // Weighted: O1 10,000 x 10% = 1,000; O2 20,000 x 25% = 5,000;
  //           O3 40,000 x 50% = 20,000; O4 6,000 x 70% = 4,200. Sum 30,200.
  assert.deepEqual([r.total.count, r.total.value, r.total.weightedValue], [4, 76_000, 30_200]);

  // Growth = new + expansion: O1 + O2 + O3 = 70,000, weighted 1,000 + 5,000 + 20,000 = 26,000
  assert.deepEqual([r.growth.count, r.growth.value, r.growth.weightedValue], [3, 70_000, 26_000]);
  // Renewal: O4 = 6,000, weighted 4,200. Growth + renewal = total.
  assert.deepEqual([r.renewal.count, r.renewal.value, r.renewal.weightedValue], [1, 6_000, 4_200]);

  assert.deepEqual(rows(r.byStage), [
    ["Discovery", 1, 10_000, 1_000],
    ["Demo", 1, 20_000, 5_000],
    ["Proposal", 1, 40_000, 20_000],
    ["Negotiation", 1, 6_000, 4_200],
  ]);
  assert.deepEqual(rows(r.bySource), [
    ["inbound", 2, 50_000, 21_000], // O1 + O3
    ["outbound", 1, 20_000, 5_000], // O2
    ["existing customer", 1, 6_000, 4_200], // O4
  ]);
  assert.deepEqual(rows(r.byType), [
    ["new", 2, 60_000, 25_000], // O2 + O3
    ["expansion", 1, 10_000, 1_000], // O1
    ["renewal", 1, 6_000, 4_200], // O4
  ]);
  assert.deepEqual(rows(r.byForecastCategory), [
    ["Pipeline", 2, 30_000, 6_000], // O1 + O2
    ["Best Case", 1, 40_000, 20_000], // O3
    ["Commit", 1, 6_000, 4_200], // O4
  ]);
});

// ---------------------------------------------------------------------------
// 3. Win rate and sales cycle
// ---------------------------------------------------------------------------

test("Win rate and sales cycle: deals closed in the last 6 months", () => {
  const r = calcWinRateAndCycle(OPPORTUNITIES, TODAY);
  // In window: W1, W2 won; L1, L2 lost. W3 (exactly 6 months ago) and L3 excluded.
  assert.equal(r.windowStart, "2026-05-13");
  assert.equal(r.won, 2);
  assert.equal(r.lost, 2);
  close(r.winRate, 0.5, "win rate"); // 2 / (2 + 2)
  close(r.avgSalesCycleDays, 40, "sales cycle"); // won only: (30 + 50) / 2
});

test("Win rate and sales cycle by deal type", () => {
  const r = calcWinRateAndCycle(OPPORTUNITIES, TODAY);
  const byType = Object.fromEntries(r.byType.map((t) => [t.type, t]));
  assert.deepEqual(r.byType.map((t) => t.type), ["new", "expansion", "renewal"]);
  // new: W1 won (30 days), L2 lost -> 1 / 2 = 50%, cycle 30
  assert.deepEqual([byType.new.won, byType.new.lost], [1, 1]);
  close(byType.new.winRate, 0.5, "new win rate");
  close(byType.new.avgSalesCycleDays, 30, "new cycle");
  // expansion: W2 won (50 days) -> 100%, cycle 50
  assert.deepEqual([byType.expansion.won, byType.expansion.lost], [1, 0]);
  close(byType.expansion.winRate, 1, "expansion win rate");
  close(byType.expansion.avgSalesCycleDays, 50, "expansion cycle");
  // renewal: L1 lost -> 0%, no won deals so no cycle
  assert.deepEqual([byType.renewal.won, byType.renewal.lost], [0, 1]);
  close(byType.renewal.winRate, 0, "renewal win rate");
  assert.equal(byType.renewal.avgSalesCycleDays, null);
});

test("Win rate and sales cycle: null when nothing closed", () => {
  const r = calcWinRateAndCycle([], TODAY);
  assert.equal(r.winRate, null);
  assert.equal(r.avgSalesCycleDays, null);
});

// ---------------------------------------------------------------------------
// 4. 30-day token cost
// ---------------------------------------------------------------------------

test("30-day window is the 30 days before today", () => {
  assert.deepEqual(usageWindow(TODAY), { start: "2026-10-14", end: "2026-11-12" });
});

test("Token cost: input and output priced separately, window only, customers only", () => {
  const r = calcTokenCost30d(ACCOUNTS, USAGE, PRICES, TODAY);
  assert.deepEqual(r.map((x) => x.accountId), ["A1", "A2", "A3"]); // no P1, C1, C2
  const byId = Object.fromEntries(r.map((x) => [x.accountId, x]));
  close(byId.A1.tokenCost30d, 24, "A1 cost"); // $20 + $4; rows on 10-13 and 11-13 ignored
  close(byId.A2.tokenCost30d, 400, "A2 cost");
  close(byId.A3.tokenCost30d, 140, "A3 cost");
  assert.equal(byId.A1.inputTokens, 3_000_000);
  assert.equal(byId.A1.outputTokens, 600_000);
});

test("Token cost: a customer with no usage costs $0", () => {
  const r = calcTokenCost30d(ACCOUNTS, [], PRICES, TODAY);
  assert.ok(r.every((x) => x.tokenCost30d === 0));
});

test("Token cost: stops with a clear error for a model with no price", () => {
  assert.throws(
    () => calcTokenCost30d(ACCOUNTS, [usageRow("A1", "2026-11-01", "mystery", 1, 1)], PRICES, TODAY),
    /No price in model_prices for model "mystery"/,
  );
});

// ---------------------------------------------------------------------------
// 5. Gross margin
// ---------------------------------------------------------------------------

test("Gross margin: (MRR - token cost) / MRR, underwater below 30%", () => {
  const r = calcGrossMargin(ACCOUNTS, USAGE, PRICES, TODAY);
  const byId = Object.fromEntries(r.map((x) => [x.accountId, x]));
  close(byId.A1.grossMargin, 0.976, "A1"); // (1,000 - 24) / 1,000
  assert.equal(byId.A1.underwater, false);
  close(byId.A2.grossMargin, 0.2, "A2"); // (500 - 400) / 500
  assert.equal(byId.A2.underwater, true);
  close(byId.A3.grossMargin, 0.3, "A3"); // (200 - 140) / 200: exactly 30% is NOT underwater
  assert.equal(byId.A3.underwater, false);
});

test("Gross margin: not available when MRR is 0", () => {
  const zero = [acc({ id: "Z", status: "customer", mrr_usd: 0, start_date: "2025-01-01" })];
  const [row] = calcGrossMargin(zero, [], PRICES, TODAY);
  assert.equal(row.grossMargin, null);
  assert.equal(row.underwater, false);
});

// ---------------------------------------------------------------------------
// 6. Capacity used
// ---------------------------------------------------------------------------

test("Capacity: 30-day tokens / included monthly tokens, overage above 100%", () => {
  const r = calcCapacity(ACCOUNTS, USAGE, PRICES, TODAY);
  const byId = Object.fromEntries(r.map((x) => [x.accountId, x]));
  close(byId.A1.capacityUsed, 0.36, "A1"); // 3.6M / 10M
  assert.equal(byId.A1.overage, false);
  close(byId.A2.capacityUsed, 12, "A2"); // 24M / 2M = 1,200%
  assert.equal(byId.A2.overage, true);
  close(byId.A3.capacityUsed, 1, "A3"); // 108M / 108M: exactly 100% is NOT overage
  assert.equal(byId.A3.overage, false);
});

test("Capacity: not available when the allowance is 0", () => {
  const zero = [acc({ id: "Z", status: "customer", mrr_usd: 100, included_tokens_monthly: 0, start_date: "2025-01-01" })];
  const [row] = calcCapacity(zero, [], PRICES, TODAY);
  assert.equal(row.capacityUsed, null);
  assert.equal(row.overage, false);
});

// ---------------------------------------------------------------------------
// 4-6 together: account economics
// ---------------------------------------------------------------------------

test("Account economics: one row per customer with cost, margin and capacity", () => {
  const r = calcAccountEconomics(ACCOUNTS, USAGE, PRICES, TODAY);
  assert.deepEqual(r.map((x) => x.accountId), ["A1", "A2", "A3"]);
  const a2 = r.find((x) => x.accountId === "A2")!;
  // A2: MRR 500, cost 400, margin 20% (underwater), 24M of 2M tokens = 1,200% (overage)
  assert.equal(a2.mrr, 500);
  close(a2.tokenCost30d, 400, "A2 cost");
  close(a2.grossMargin, 0.2, "A2 margin");
  assert.equal(a2.underwater, true);
  assert.equal(a2.tokens30d, 24_000_000);
  assert.equal(a2.includedTokensMonthly, 2_000_000);
  close(a2.capacityUsed, 12, "A2 capacity");
  assert.equal(a2.overage, true);
  // Same answers as the separate calculators
  const margin = calcGrossMargin(ACCOUNTS, USAGE, PRICES, TODAY);
  const capacity = calcCapacity(ACCOUNTS, USAGE, PRICES, TODAY);
  r.forEach((row, i) => {
    assert.equal(row.grossMargin, margin[i].grossMargin);
    assert.equal(row.capacityUsed, capacity[i].capacityUsed);
  });
});

test("Account economics: carries each customer's segment", () => {
  const withSegments = ACCOUNTS.map((a) => (a.id === "A1" ? { ...a, segment: "enterprise" } : a));
  const r = calcAccountEconomics(withSegments, USAGE, PRICES, TODAY);
  assert.deepEqual(r.map((x) => [x.accountId, x.segment]), [["A1", "enterprise"], ["A2", "SMB"], ["A3", "SMB"]]);
});

test("Portfolio economics: totals and blended margin across customers", () => {
  const p = calcPortfolioEconomics(calcAccountEconomics(ACCOUNTS, USAGE, PRICES, TODAY));
  assert.equal(p.customerCount, 3);
  assert.equal(p.totalMrr, 1_700); // 1,000 + 500 + 200
  close(p.totalTokenCost30d, 564, "total cost"); // 24 + 400 + 140
  close(p.blendedGrossMargin, 1_136 / 1_700, "blended margin"); // (1,700 - 564) / 1,700 = 66.8%
  assert.equal(p.underwaterCount, 1); // A2
  assert.equal(p.overageCount, 1); // A2
});

// A1 enterprise; A2 and A3 SMB. A2 renews 2027-01-15 (63 days away).
const SEGMENTED = ACCOUNTS.map((a) =>
  a.id === "A1" ? { ...a, segment: "enterprise" } : a.id === "A2" ? { ...a, renewal_date: "2027-01-15" } : a,
);

test("ARR: split by segment, and the top-10 share", () => {
  const r = calcArr(SEGMENTED);
  assert.deepEqual(
    r.bySegment.map((s) => [s.segment, s.customers, s.arr]),
    [["enterprise", 1, 12_000], ["SMB", 2, 8_400]], // SMB: 6,000 + 2,400
  );
  close(r.bySegment[0].share, 12_000 / 20_400, "enterprise share"); // 58.8%
  close(r.top10Share, 1, "top 10"); // only 3 customers, so all ARR
});

test("Portfolio economics: how much underwater accounts weigh", () => {
  const p = calcPortfolioEconomics(calcAccountEconomics(ACCOUNTS, USAGE, PRICES, TODAY));
  assert.equal(p.underwaterMrr, 500); // A2
  close(p.underwaterMrrShare, 500 / 1_700, "MRR share"); // 29.4%
  close(p.underwaterTokenCostShare, 400 / 564, "cost share"); // 70.9%
  assert.equal(p.negativeMarginCount, 0); // A2 is at +20%
});

test("Economics by segment: MRR, token cost and margin per segment", () => {
  const r = calcEconomicsBySegment(calcAccountEconomics(SEGMENTED, USAGE, PRICES, TODAY));
  assert.deepEqual(r.map((s) => [s.segment, s.customers, s.mrr, s.underwaterCount, s.overageCount]), [
    ["enterprise", 1, 1_000, 0, 0],
    ["SMB", 2, 700, 1, 1], // A2 is both
  ]);
  close(r[0].tokenCost30d, 24, "enterprise cost");
  close(r[0].grossMargin, 0.976, "enterprise margin"); // (1,000 - 24) / 1,000
  close(r[1].tokenCost30d, 540, "SMB cost"); // 400 + 140
  close(r[1].grossMargin, 160 / 700, "SMB margin"); // (700 - 540) / 700 = 22.9%
});

test("Token cost by model: customers only, last 30 days, largest first", () => {
  const r = calcTokenCostByModel(ACCOUNTS, USAGE, PRICES, TODAY);
  assert.deepEqual(r.map((m) => [m.model, m.tokens]), [
    ["big", 25_200_000], // A1 1.2M + A2 24M (C1 is churned, days outside the window ignored)
    ["small", 110_400_000], // A1 2.4M + A3 108M
  ]);
  close(r[0].cost, 420, "big cost"); // A1 20 + A2 400
  close(r[1].cost, 144, "small cost"); // A1 4 + A3 140
  close(r[0].share, 420 / 564, "big share"); // 74.5%
});

test("Lifecycle stage: boundaries", () => {
  const stage = (start: string, renewal: string | null) => calcLifecycle(start, renewal, TODAY).stage;
  assert.equal(stage("2026-09-01", "2027-09-01"), "Onboarding"); // 73 days in
  assert.equal(stage("2026-08-15", "2027-08-15"), "First year"); // exactly 90 days in
  assert.equal(stage("2025-11-14", "2026-11-14"), "Renewal due"); // renews tomorrow
  assert.equal(stage("2025-11-13", "2027-11-13"), "Established"); // exactly 365 days in
  assert.equal(stage("2024-06-01", "2027-02-11"), "Renewal due"); // renewal exactly 90 days away
  assert.equal(stage("2024-06-01", "2027-02-12"), "Established"); // 91 days away: not due yet
  assert.equal(stage("2026-01-01", "2027-01-01"), "Renewal due"); // first year, but renewal due wins
});

test("Lifecycle: tenure in whole months and days to renewal", () => {
  assert.equal(calcLifecycle("2025-01-10", null, TODAY).tenureMonths, 22); // Jan 2025 -> Nov 2026
  assert.equal(calcLifecycle("2026-09-14", null, TODAY).tenureMonths, 1); // 14 Nov not reached yet
  assert.equal(calcLifecycle("2026-09-14", "2027-01-15", TODAY).daysToRenewal, 63);
});

test("Lifecycle mix: customers and MRR per stage, all stages listed", () => {
  const r = calcLifecycleMix(calcAccountEconomics(SEGMENTED, USAGE, PRICES, TODAY));
  // A3 started 2026-10-01 (Onboarding); A1 started 2025 (Established); A2 renews in 63 days (Renewal due)
  assert.deepEqual(r.map((s) => [s.stage, s.customers, s.mrr]), [
    ["Onboarding", 1, 200],
    ["First year", 0, 0],
    ["Established", 1, 1_000],
    ["Renewal due", 1, 500],
  ]);
});

// ---------------------------------------------------------------------------
// Monthly revenue vs token cost
// ---------------------------------------------------------------------------

test("Monthly chart: only months the 90-day usage history fully covers", () => {
  // History runs 2026-08-15 to 2026-11-12: August and November are partial.
  assert.deepEqual(fullUsageMonths(TODAY), ["2026-09-01", "2026-10-01"]);
});

test("Monthly chart: invoices vs priced usage, all accounts, complete months only", () => {
  const invoices: InvoiceRow[] = [
    { account_id: "X", month: "2026-08-01", amount_usd: 900 }, // partial month: left out
    { account_id: "X", month: "2026-09-01", amount_usd: 1_000 },
    { account_id: "Y", month: "2026-09-01", amount_usd: 500 }, // churned later, still counts while paying
    { account_id: "X", month: "2026-10-01", amount_usd: 1_000 },
  ];
  const usage: UsageRow[] = [
    usageRow("X", "2026-08-20", "big", 50_000_000, 0), // partial month: left out
    usageRow("X", "2026-09-10", "big", 10_000_000, 0), // 10M x $10 = $100
    usageRow("X", "2026-10-05", "small", 100_000_000, 20_000_000), // 100M x $1 + 20M x $5 = $200
    usageRow("X", "2026-11-01", "big", 50_000_000, 0), // partial month: left out
  ];
  const r = calcMonthlyRevenueVsTokenCost(invoices, usage, PRICES, TODAY);
  assert.deepEqual(r.map((x) => [x.month, x.revenue, x.tokenCost]), [
    ["2026-09-01", 1_500, 100],
    ["2026-10-01", 1_000, 200],
  ]);
  close(r[0].grossMargin, 1_400 / 1_500, "Sep margin"); // 93.3%
  close(r[1].grossMargin, 0.8, "Oct margin"); // (1,000 - 200) / 1,000
});

// ---------------------------------------------------------------------------
// 7. NRR
// ---------------------------------------------------------------------------

test("NRR: August -> November for accounts that were customers 90 days ago", () => {
  const r = calcNrr90d(ACCOUNTS, INVOICES, TODAY);
  assert.equal(r.startDate, "2026-08-15");
  assert.equal(r.startMonth, "2026-08-01");
  assert.equal(r.endMonth, "2026-11-01");
  // Cohort: A1, A2, C1. A3 joined in October, C2 churned in June, P1 is a prospect.
  assert.equal(r.accountsInCohort, 3);
  assert.equal(r.startingMrr, 1_700); // 800 + 600 + 300
  assert.equal(r.upgrades, 200); // A1 800 -> 1,000
  assert.equal(r.downgrades, 100); // A2 600 -> 500
  assert.equal(r.churnedMrr, 300); // C1
  assert.equal(r.endingMrr, 1_500); // 1,000 + 500 + 0
  assert.deepEqual([r.upgradedCount, r.downgradedCount, r.churnedCount], [1, 1, 1]);
  close(r.nrr, 15 / 17, "NRR"); // (1,700 + 200 - 100 - 300) / 1,700 = 88.2%
  close(r.grr, 13 / 17, "GRR"); // (1,700 - 100 - 300) / 1,700 = 76.5%
});

test("NRR: a customer that churned in late August uses its last invoice as starting MRR", () => {
  // Churned 2026-08-20 (after the 08-15 start), so billed only up to July.
  const accounts = [acc({ id: "E", status: "churned", start_date: "2024-01-01", churn_date: "2026-08-20" })];
  const invoices = [{ account_id: "E", month: "2026-07-01", amount_usd: 250 }];
  const r = calcNrr90d(accounts, invoices, TODAY);
  assert.equal(r.startingMrr, 250);
  assert.equal(r.churnedMrr, 250);
  close(r.nrr, 0, "NRR");
});

test("NRR: null when nobody was a customer 90 days ago", () => {
  assert.equal(calcNrr90d([], [], TODAY).nrr, null);
});

test("NPS trend: latest, previous and change per customer, up to today only", () => {
  const nps = [
    { account_id: "A1", responded_at: "2026-06-01T10:00:00Z", score: 9 },
    { account_id: "A1", responded_at: "2026-10-01T10:00:00Z", score: 6 }, // latest for A1
    { account_id: "A1", responded_at: "2026-08-01T10:00:00Z", score: 8 }, // previous for A1
    { account_id: "A1", responded_at: "2026-11-20T10:00:00Z", score: 0 }, // after today: ignored
    { account_id: "A2", responded_at: "2026-09-15T10:00:00Z", score: 7 }, // only one response
    { account_id: "C1", responded_at: "2026-09-15T10:00:00Z", score: 2 }, // churned: not a customer
    { account_id: "P1", responded_at: "2026-09-15T10:00:00Z", score: 10 }, // prospect: not a customer
  ];
  const rows = Object.fromEntries(calcNpsTrend(ACCOUNTS, nps, TODAY).map((r) => [r.accountId, r]));
  assert.deepEqual(Object.keys(rows).sort(), ["A1", "A2", "A3"]);
  assert.equal(rows.A1.latestNps, 6);
  assert.equal(rows.A1.previousNps, 8);
  assert.equal(rows.A1.npsChange, -2);
  assert.equal(rows.A2.latestNps, 7);
  assert.equal(rows.A2.previousNps, null);
  assert.equal(rows.A2.npsChange, null);
  assert.equal(rows.A3.latestNps, null);
  assert.equal(rows.A3.npsChange, null);
});

// Renewal and deal risk: small, separate datasets so each rule is easy to check.
// Windows for TODAY = 2026-11-13: last 30 days = 2026-10-14..2026-11-12, prior 30 = 2026-09-14..2026-10-13.

test("Usage trend: last 30 days vs the 30 before", () => {
  const accounts = [acc({ id: "U1", status: "customer" }), acc({ id: "U2", status: "customer" })];
  const usage = [
    usageRow("U1", "2026-10-14", "small", 600, 0), // last window
    usageRow("U1", "2026-10-13", "small", 1000, 0), // prior window
    usageRow("U1", "2026-09-13", "small", 9999, 0), // before both: ignored
    usageRow("U2", "2026-11-01", "small", 500, 0), // no prior usage
  ];
  const rows = Object.fromEntries(calcUsageTrend(accounts, usage, TODAY).map((r) => [r.accountId, r]));
  close(rows.U1.usageChange, -0.4, "U1 down 40%");
  assert.equal(rows.U2.usageChange, null);
});

test("Renewal risk: health drives the level, inside each segment's window", () => {
  // Windows from today (2026-11-13): enterprise 180 days, mid-market 120, SMB 90.
  const base = { status: "customer" as const, mrr_usd: 1000 };
  const accounts = [
    acc({ id: "H1", ...base, segment: "SMB", renewal_date: "2026-12-01" }), // health 45: below 50 = High
    acc({ id: "H2", ...base, segment: "SMB", renewal_date: "2026-12-02" }), // health 60 and down 12 on last week = High
    acc({ id: "H3", ...base, segment: "SMB", renewal_date: "2026-12-03" }), // health 60, 30% of ARR at downsell risk = High
    acc({ id: "H4", ...base, segment: "SMB", renewal_date: "2026-12-04" }), // health 60, underwater = High
    acc({ id: "M1", ...base, segment: "SMB", renewal_date: "2026-12-05" }), // health 60, 10% at downsell risk (under 25%) = Medium
    acc({ id: "M2", ...base, segment: "SMB", renewal_date: "2026-12-06" }), // health 80, a line at downsell risk = Medium
    acc({ id: "L1", ...base, segment: "SMB", renewal_date: "2026-12-07" }), // health 80, nothing else = Low
    acc({ id: "W1", ...base, segment: "SMB", renewal_date: "2027-02-20" }), // health 30 but 99 days out: past SMB's 90 = Low
    acc({ id: "W2", ...base, segment: "enterprise", renewal_date: "2027-04-01" }), // health 30, 139 days: inside enterprise 180 = High
    acc({ id: "W3", ...base, segment: "mid-market", renewal_date: "2027-04-01" }), // health 30, 139 days: past mid-market 120 = Low
  ];
  const line = (arr: number, adoptionDrop: boolean) => ({ arr, adoptionDrop });
  const healthy = [line(10_000, false), line(2_000, false)];
  const health = new Map<string, { score: number; change: number | null; npsChange: number | null; lines: { arr: number; adoptionDrop: boolean }[] }>([
    ["H1", { score: 45, change: 0, npsChange: null, lines: healthy }],
    ["H2", { score: 60, change: -12, npsChange: null, lines: healthy }],
    ["H3", { score: 60, change: 0, npsChange: null, lines: [line(7_000, false), line(3_000, true)] }], // 3,000 / 10,000 = 30%
    ["H4", { score: 60, change: 0, npsChange: null, lines: healthy }],
    ["M1", { score: 60, change: -9, npsChange: null, lines: [line(9_000, false), line(1_000, true)] }], // 10%; down 9 is not 10+
    ["M2", { score: 80, change: 0, npsChange: null, lines: [line(9_000, false), line(1_000, true)] }],
    ["L1", { score: 80, change: -20, npsChange: null, lines: healthy }], // a big drop alone doesn't flag a green account
    ["W1", { score: 30, change: 0, npsChange: null, lines: healthy }],
    ["W2", { score: 30, change: 0, npsChange: null, lines: healthy }],
    ["W3", { score: 30, change: 0, npsChange: null, lines: healthy }],
  ]);
  const usage = [usageRow("H4", "2026-11-01", "big", 80_000_000, 0)]; // 80M x $10/M = $800 on $1,000 MRR: margin 20%, underwater
  const result = calcRenewalRisk(accounts, usage, PRICES, health, TODAY);
  const byId = Object.fromEntries(result.all.map((r) => [r.accountId, r]));

  assert.deepEqual(byId.H1.reasons, ["Health below 50"]);
  assert.deepEqual(byId.H2.reasons, ["Health 50–69", "Health down 10+"]);
  assert.deepEqual(byId.H3.reasons, ["Health 50–69", "25%+ ARR at downsell risk"]);
  close(byId.H3.downsellShare!, 0.3, "H3 downsell share");
  assert.deepEqual(byId.H4.reasons, ["Health 50–69", "Underwater margin"]);
  assert.deepEqual(byId.M1.reasons, ["Health 50–69"]);
  assert.deepEqual(byId.M2.reasons, ["Downsell risk"]);
  assert.deepEqual(byId.L1.reasons, []);
  assert.equal(byId.W1.inWindow, false);
  assert.equal(byId.W2.windowDays, 180);
  assert.equal(byId.W3.windowDays, 120);
  assert.deepEqual(
    result.all.map((r) => [r.accountId, r.level]),
    [["H1", "High"], ["H2", "High"], ["H3", "High"], ["H4", "High"], ["M1", "Medium"], ["M2", "Medium"], ["L1", "Low"], ["W1", "Low"], ["W2", "High"], ["W3", "Low"]],
  );
  // rows: High and Medium only, High first, then soonest renewal
  assert.deepEqual(result.rows.map((r) => r.accountId), ["H1", "H2", "H3", "H4", "W2", "M1", "M2"]);
  assert.deepEqual(result.byLevel, { High: { count: 5, arr: 60_000 }, Medium: { count: 2, arr: 24_000 } });
  assert.equal(result.renewingCount, 8); // all but W1 and W3
  assert.equal(result.atRiskArr, 7 * 12_000);
});

test("Renewal risk: no exec sponsor or sponsor left (enterprise and mid-market only)", () => {
  const dec = (healthScore: number | null, sponsorGap: "none" | "left" | null, extra: Partial<Parameters<typeof decideRenewalRisk>[0]> = {}) =>
    decideRenewalRisk({ healthScore, healthChange: 0, underwater: false, downsellShare: 0, sponsorGap, ...extra });
  // Health 70+: Medium on its own
  assert.deepEqual(dec(70, "none"), { level: "Medium", reasons: ["No exec sponsor"] });
  assert.deepEqual(dec(85, "left"), { level: "Medium", reasons: ["Exec sponsor left"] });
  assert.deepEqual(dec(85, "none", { underwater: true }), { level: "Medium", reasons: ["Underwater margin", "No exec sponsor"] });
  // Health below 70: High
  assert.deepEqual(dec(69.9, "none"), { level: "High", reasons: ["Health 50–69", "No exec sponsor"] });
  assert.deepEqual(dec(45, "left"), { level: "High", reasons: ["Health below 50", "Exec sponsor left"] });
  // No health score: still Medium on its own
  assert.equal(dec(null, "none").level, "Medium");
  // Active sponsor (no gap): the health rule alone
  assert.equal(dec(85, null).level, "Low");
  // With an NPS drop as well, a Medium account lists both
  assert.deepEqual(dec(85, "none", { npsChange: -4 }), { level: "Medium", reasons: ["No exec sponsor", "NPS down 3+"] });

  // End to end: the segment and the window decide whether the sponsor counts
  const base = { status: "customer" as const, mrr_usd: 1000 };
  const accounts = [
    acc({ id: "S1", ...base, segment: "enterprise", renewal_date: "2027-04-01", sponsor_status: "left" }), // 139 days: inside 180
    acc({ id: "S2", ...base, segment: "mid-market", renewal_date: "2026-12-20", sponsor_status: "none" }),
    acc({ id: "S3", ...base, segment: "mid-market", renewal_date: "2026-12-20", sponsor_status: "active" }),
    acc({ id: "S4", ...base, segment: "SMB", renewal_date: "2026-12-20", sponsor_status: "none" }), // SMB: never penalised
    acc({ id: "S5", ...base, segment: "mid-market", renewal_date: "2027-04-01", sponsor_status: "none" }), // 139 days: past mid-market 120
  ];
  const lines = [{ arr: 12_000, adoptionDrop: false }];
  const health = new Map(["S1", "S2", "S3", "S4", "S5"].map((id) => [id, { score: id === "S2" ? 60 : 85, change: 0, npsChange: null, lines }]));
  const byId = Object.fromEntries(calcRenewalRisk(accounts, [], PRICES, health, TODAY).all.map((r) => [r.accountId, r]));
  assert.deepEqual([byId.S1.level, byId.S1.reasons], ["Medium", ["Exec sponsor left"]]);
  assert.deepEqual([byId.S2.level, byId.S2.reasons], ["High", ["Health 50–69", "No exec sponsor"]]);
  assert.equal(byId.S3.level, "Low");
  assert.equal(byId.S4.level, "Low");
  assert.equal(byId.S5.level, "Low");
  assert.equal(byId.S1.sponsorStatus, "left");
  assert.deepEqual(RENEWAL_RISK_RULES.sponsorRequiredSegments, ["enterprise", "mid-market"]);
});

test("Renewal risk: NPS down 3+ since the previous survey is Medium, inside the window only", () => {
  const base = { status: "customer" as const, mrr_usd: 1000, segment: "SMB" };
  const accounts = [
    acc({ id: "N1", ...base, renewal_date: "2026-12-01" }), // 18 days: inside SMB's 90
    acc({ id: "N2", ...base, renewal_date: "2027-03-01" }), // 108 days: outside SMB's 90
  ];
  const lines = [{ arr: 12_000, adoptionDrop: false }];
  const health = new Map([
    ["N1", { score: 85, change: 0, npsChange: -3, lines }],
    ["N2", { score: 85, change: 0, npsChange: -6, lines }],
  ]);
  const byId = Object.fromEntries(calcRenewalRisk(accounts, [], PRICES, health, TODAY).all.map((r) => [r.accountId, r]));
  assert.equal(byId.N1.level, "Medium");
  assert.deepEqual(byId.N1.reasons, ["NPS down 3+"]);
  assert.equal(byId.N1.npsChange, -3);
  assert.equal(byId.N2.level, "Low");
});

test("Renewal risk: the level rule at every boundary", () => {
  const d = (healthScore: number | null, extra: Partial<Parameters<typeof decideRenewalRisk>[0]> = {}) =>
    decideRenewalRisk({ healthScore, healthChange: 0, underwater: false, downsellShare: 0, ...extra }).level;
  assert.equal(d(49.9), "High");
  assert.equal(d(50), "Medium");
  assert.equal(d(69.9), "Medium");
  assert.equal(d(70), "Low");
  assert.equal(d(60, { healthChange: -10 }), "High"); // exactly 10 down counts
  assert.equal(d(60, { healthChange: -9.9 }), "Medium");
  assert.equal(d(60, { downsellShare: 0.25 }), "High"); // exactly 25% counts
  assert.equal(d(60, { downsellShare: 0.249 }), "Medium");
  assert.equal(d(75, { underwater: true }), "Medium");
  assert.equal(d(75, { downsellShare: 0.01 }), "Medium");
  assert.equal(d(75, { healthChange: -30 }), "Low");
  assert.equal(d(null), "Low"); // no health score: no level beyond Low
  // NPS down 3+ since the previous survey: Medium on its own, never High
  assert.deepEqual(decideRenewalRisk({ healthScore: 85, healthChange: 0, underwater: false, downsellShare: 0, npsChange: -3 }), {
    level: "Medium",
    reasons: ["NPS down 3+"],
  });
  assert.equal(d(85, { npsChange: -2 }), "Low"); // a 2-point drop isn't enough
  assert.deepEqual(decideRenewalRisk({ healthScore: 60, healthChange: 0, underwater: false, downsellShare: 0, npsChange: -4 }).reasons, ["Health 50–69", "NPS down 3+"]);
  assert.deepEqual(decideRenewalRisk({ healthScore: 45, healthChange: 0, underwater: false, downsellShare: 0, npsChange: -5 }), {
    level: "High",
    reasons: ["Health below 50"],
  }); // already High: stays High with its own reason
  assert.deepEqual(RENEWAL_RISK_RULES.windowDays, { enterprise: 180, "mid-market": 120, SMB: 90 });
});

test("Deal risk: open deals only, each rule fires on its own", () => {
  const accounts = [acc({ id: "A1", status: "customer", name: "Acme" })];
  const healthy = { executive_sponsor: "Pat, CTO", stage_entered_date: "2026-11-01", last_activity_date: "2026-11-10", next_step: "Send proposal" };
  const deal = (o: Partial<DealRiskInput> & Pick<DealRiskInput, "id" | "stage">): DealRiskInput => ({
    ...opp({ close_date: "2026-12-31", amount_usd: 1000, ...o }),
    ...healthy,
    ...o,
  });
  const opps = [
    deal({ id: "D1", stage: "Proposal", executive_sponsor: null }), // no sponsor in Proposal
    deal({ id: "D2", stage: "Discovery", executive_sponsor: null }), // no sponsor, but Discovery: fine
    deal({ id: "D3", stage: "Demo", stage_entered_date: "2026-10-15" }), // 29 days in Demo > 28
    deal({ id: "D4", stage: "Demo", stage_entered_date: "2026-10-16" }), // 28 days: fine
    deal({ id: "D5", stage: "Negotiation", last_activity_date: "2026-10-23" }), // 21 days: no recent activity
    deal({ id: "D6", stage: "Negotiation", close_date: "2026-11-12" }), // close date passed
    deal({ id: "D7", stage: "Negotiation", next_step: null }), // no next step
    deal({ id: "D8", stage: "Closed Lost", executive_sponsor: null, next_step: null }), // closed: ignored
  ];
  const result = calcDealRisk(opps, accounts, TODAY);
  const byId = Object.fromEntries(result.rows.map((r) => [r.opportunityId, r.signals]));
  assert.deepEqual(Object.keys(byId).sort(), ["D1", "D3", "D5", "D6", "D7"]);
  assert.deepEqual(byId.D1, ["No exec sponsor"]);
  assert.deepEqual(byId.D3, ["Stuck in stage"]);
  assert.deepEqual(byId.D5, ["No recent activity"]);
  assert.deepEqual(byId.D6, ["Close date passed"]);
  assert.deepEqual(byId.D7, ["No next step"]);
  assert.equal(result.atRiskPipeline, 5000);
  assert.equal(result.openCount, 7);
  assert.equal(result.rows[0].accountName, "Acme");
});

test("Calendar quarters: this and next, across a year end", () => {
  assert.deepEqual(calendarQuarter(TODAY), { label: "Q4 2026", start: "2026-10-01", end: "2026-12-31" });
  assert.deepEqual(calendarQuarter(TODAY, 1), { label: "Q1 2027", start: "2027-01-01", end: "2027-03-31" });
  assert.deepEqual(calendarQuarter("2026-03-31", 0), { label: "Q1 2026", start: "2026-01-01", end: "2026-03-31" });
});

test("Upcoming renewals: customers renewing this quarter (from today) and next, largest ARR first, top N", () => {
  const accounts = [
    acc({ id: "R1", status: "customer", mrr_usd: 100, renewal_date: "2026-12-01" }),
    acc({ id: "R2", status: "customer", mrr_usd: 300, renewal_date: "2026-11-20" }),
    acc({ id: "R3", status: "customer", mrr_usd: 200, renewal_date: "2026-12-31" }),
    acc({ id: "R4", status: "customer", mrr_usd: 500, renewal_date: "2026-11-01" }), // already past today: not upcoming
    acc({ id: "R5", status: "customer", mrr_usd: 400, renewal_date: "2027-02-01" }), // next quarter
    acc({ id: "R6", status: "customer", mrr_usd: 900, renewal_date: "2027-04-01" }), // two quarters out: excluded
    acc({ id: "C1", status: "churned", mrr_usd: 999, renewal_date: "2026-12-01" }), // not a customer
  ];
  const [thisQ, nextQ] = calcUpcomingRenewals(accounts, TODAY, 2);
  assert.equal(thisQ.count, 3);
  assert.equal(thisQ.totalArr, (100 + 300 + 200) * 12);
  assert.deepEqual(thisQ.top.map((r) => r.accountId), ["R2", "R3"]); // top 2 only
  assert.equal(thisQ.top[0].daysToRenewal, 7);
  assert.deepEqual(nextQ.top.map((r) => r.accountId), ["R5"]);
});

test("Upcoming deals: open deals closing this and next quarter, largest first", () => {
  const accounts = [acc({ id: "A1", status: "customer", name: "Acme" })];
  const opps = [
    opp({ id: "D1", stage: "Proposal", amount_usd: 1000, probability: 50, close_date: "2026-12-15" }),
    opp({ id: "D2", stage: "Demo", amount_usd: 3000, probability: 25, close_date: "2026-10-05" }), // this quarter, date passed: still counted
    opp({ id: "D3", stage: "Negotiation", amount_usd: 2000, probability: 70, close_date: "2027-03-01" }), // next quarter
    opp({ id: "D4", stage: "Closed Won", amount_usd: 9000, probability: 100, close_date: "2026-11-01" }), // closed: excluded
    opp({ id: "D5", stage: "Discovery", amount_usd: 9000, probability: 10, close_date: "2027-05-01" }), // too far out
  ];
  const [thisQ, nextQ] = calcUpcomingDeals(opps, accounts, TODAY);
  assert.deepEqual(thisQ.top.map((r) => r.opportunityId), ["D2", "D1"]);
  assert.equal(thisQ.totalAmount, 4000);
  assert.equal(thisQ.weightedAmount, 3000 * 0.25 + 1000 * 0.5);
  assert.deepEqual(nextQ.top.map((r) => r.opportunityId), ["D3"]);
  assert.equal(nextQ.top[0].accountName, "Acme");
});

// ---------------------------------------------------------------------------
// CRM sync values (HubSpot)
// ---------------------------------------------------------------------------

test("Deal risk levels: 0 = None, 1 = Amber, 2+ = Red", () => {
  assert.deepEqual([0, 1, 2, 5].map(dealRiskLevel), ["None", "Amber", "Red", "Red"]);
});

test("CRM sync: customer-only values, risk levels for every customer and open deal", () => {
  const accounts = [
    // K1: enterprise, renews in 49 days, health 45 = High
    acc({ id: "K1", name: "Kilo", status: "customer", segment: "enterprise", mrr_usd: 1000, included_tokens_monthly: 10_000_000, renewal_date: "2027-01-01" }),
    // K2: health 30 but renews in 200 days, outside every window: Low
    acc({ id: "K2", status: "customer", mrr_usd: 500, renewal_date: "2027-06-01" }),
    // K3: renews in 32 days, health 60 = Medium
    acc({ id: "K3", status: "customer", mrr_usd: 200, renewal_date: "2026-12-15" }),
    acc({ id: "P1", status: "prospect" }), // has an open deal
    acc({ id: "P2", status: "prospect" }), // closed deal only
    acc({ id: "C1", status: "churned", churn_date: "2026-09-01" }),
  ];
  const nps = [
    { account_id: "K1", responded_at: "2026-08-01T10:00:00Z", score: 9 },
    { account_id: "K1", responded_at: "2026-10-01T10:00:00Z", score: 6 },
    { account_id: "K2", responded_at: "2026-10-01T10:00:00Z", score: 3 },
    { account_id: "K3", responded_at: "2026-10-01T10:00:00Z", score: 6 },
  ];
  // K1: 1M input tokens on "big" = $10 in the 30-day window -> margin (1000 - 10) / 1000 = 0.99; capacity 1M / 10M = 0.1
  const usage = [usageRow("K1", "2026-11-01", "big", 1_000_000, 0)];
  const healthy = { executive_sponsor: "Pat, CTO", stage_entered_date: "2026-11-01", last_activity_date: "2026-11-10", next_step: "Send proposal" };
  const deal = (o: Partial<DealRiskInput> & Pick<DealRiskInput, "id" | "stage" | "account_id">): DealRiskInput => ({
    ...opp({ close_date: "2026-12-31", amount_usd: 1000, ...o }),
    ...healthy,
    ...o,
  });
  const deals = [
    deal({ id: "E1", account_id: "P1", stage: "Proposal", executive_sponsor: null, next_step: null }), // 2 signals: Red
    deal({ id: "E2", account_id: "K1", stage: "Negotiation", forecast_category: "Commit" }), // healthy: None
    deal({ id: "E3", account_id: "K2", stage: "Demo", next_step: null }), // 1 signal: Amber
    deal({ id: "E4", account_id: "P2", stage: "Closed Lost", forecast_category: "Omitted", executive_sponsor: null }), // closed: no risk, no days
  ];

  const lines = [{ arr: 1000, adoptionDrop: false }];
  const health = new Map([
    ["K1", { score: 45, change: 0, npsChange: null, lines }],
    ["K2", { score: 30, change: 0, npsChange: null, lines }],
    ["K3", { score: 60, change: 0, npsChange: null, lines }],
  ]);
  const { accounts: a, deals: d } = calcCrmSyncData(accounts, deals, usage, PRICES, nps, TODAY, health);
  const A = Object.fromEntries(a.map((r) => [r.accountId, r]));
  const D = Object.fromEntries(d.map((r) => [r.opportunityId, r]));

  assert.equal(a.length, 6);
  assert.equal(A.K1.arr, 12_000);
  assert.equal(A.K1.renewalDate, "2027-01-01");
  close(A.K1.grossMargin, 0.99, "K1 margin as a decimal");
  close(A.K1.capacityUsed, 0.1, "K1 capacity as a decimal");
  assert.equal(A.K1.latestNps, 6);
  assert.equal(A.K1.npsChange, -3);
  assert.equal(A.K1.segment, "enterprise");
  assert.deepEqual([A.K1.renewalRisk, A.K2.renewalRisk, A.K3.renewalRisk], ["High", "Low", "Medium"]);
  assert.equal(A.K1.hasOpenDeal, true);

  // The Renewals page and the sync must never disagree: every flagged row's level is what the sync sends.
  const page = calcRenewalRisk(accounts, usage, PRICES, health, TODAY);
  assert.deepEqual(page.rows.map((r) => [r.accountId, r.level]), [["K1", "High"], ["K3", "Medium"]]); // High first
  for (const r of page.all) assert.equal(A[r.accountId].renewalRisk, r.level);
  assert.deepEqual(page.byLevel, { High: { count: 1, arr: 12_000 }, Medium: { count: 1, arr: 2_400 } });

  // Prospects and churned accounts: no customer values
  for (const id of ["P1", "P2", "C1"]) {
    assert.equal(A[id].arr, null);
    assert.equal(A[id].grossMargin, null);
    assert.equal(A[id].renewalRisk, null);
  }
  assert.equal(A.P1.hasOpenDeal, true);
  assert.equal(A.P2.hasOpenDeal, false);

  assert.equal(d.length, 4);
  assert.deepEqual([D.E1.dealRisk, D.E2.dealRisk, D.E3.dealRisk, D.E4.dealRisk], ["Red", "None", "Amber", null]);
  assert.equal(D.E2.daysInStage, 12); // 2026-11-01 -> 2026-11-13
  assert.equal(D.E4.daysInStage, null);
  assert.equal(D.E2.forecastCategory, "Commit");
  assert.equal(D.E1.accountName, "P1");
});

test("Renewal deal coverage: missing only inside the window with no open renewal deal", () => {
  const base = { status: "customer" as const, mrr_usd: 1000, segment: "SMB" };
  const accounts = [
    acc({ id: "G1", ...base, renewal_date: "2026-12-01" }), // 18 days: inside SMB's 90
    acc({ id: "G2", ...base, renewal_date: "2027-03-01" }), // 108 days: outside
  ];
  const health = new Map(["G1", "G2"].map((id) => [id, { score: 85, change: 0, npsChange: null, lines: [{ arr: 12_000, adoptionDrop: false }] }]));
  const byId = Object.fromEntries(calcRenewalRisk(accounts, [], PRICES, health, TODAY).all.map((r) => [r.accountId, r]));
  // Inside the window: no deals, or only a closed one = missing; an open one = covered
  assert.equal(calcRenewalDealCoverage(byId.G1, []).missing, true);
  assert.equal(calcRenewalDealCoverage(byId.G1, [{ stage: "Closed Won" }]).missing, true);
  assert.deepEqual(calcRenewalDealCoverage(byId.G1, [{ stage: "Proposal" }]), {
    renewalDate: "2026-12-01",
    daysToRenewal: 18,
    inWindow: true,
    windowDays: 90,
    hasOpenRenewalDeal: true,
    missing: false,
  });
  // Outside the window: not needed yet
  assert.equal(calcRenewalDealCoverage(byId.G2, []).missing, false);
});
