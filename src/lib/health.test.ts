// Tests for the account health score in metrics.ts. Hand calculations are
// written next to each expected value. Run with `npm test`.
//
// Today (asOf) = 2026-11-13
// Last 30 days  = 2026-10-14 .. 2026-11-12
// Prior 30 days = 2026-09-14 .. 2026-10-13
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_CATEGORIES,
  HEALTH_WEIGHTS,
  calcContractLineMetrics,
  calcHealthScores,
  calcHealthSummary,
  calcHealthTrend,
  capacityScore,
  csatScore,
  healthBand,
  renewalHealth,
  lastTouchScore,
  latestNpsScore,
  lineAdoptionScore,
  netExpansionScore,
  npsChangeScore,
  openTicketsScore,
  overdueScore,
  resolutionScore,
  trendScore,
  type AccountRow,
  type ContractLineRow,
  type CsActivityRow,
  type FeatureUsageRow,
  type HealthInputs,
  type InvoiceStatusRow,
  type TicketRow,
} from "./metrics.ts";

const AS_OF = "2026-11-13";
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const account = (id: string, extra: Partial<AccountRow> = {}): AccountRow => ({
  id,
  name: id,
  status: "customer",
  segment: "SMB",
  mrr_usd: 1000,
  included_tokens_monthly: 1_000_000,
  start_date: "2025-01-01",
  renewal_date: "2027-01-01",
  churn_date: null,
  owner: "Owner",
  ...extra,
});
const line = (id: string, acc: string, product: string, arr: number, included: number): ContractLineRow => ({
  id,
  account_id: acc,
  contract_id: `C-${acc}`,
  product,
  quantity: 1,
  unit_price_usd: arr,
  arr_usd: arr,
  purchase_date: "2026-01-01",
  renewal_date: "2027-01-01",
  term_months: 12,
  auto_renew: true,
  status: "active",
  included_tokens_monthly: included,
});
const usage = (acc: string, date: string, feature: string, tokens: number, users: number): FeatureUsageRow => ({
  account_id: acc,
  date,
  feature,
  input_tokens: tokens,
  output_tokens: 0,
  active_users: users,
});
const ticket = (id: string, acc: string, opened: string, closed: string | null, severity: string, csat: number | null = null): TicketRow => ({
  id,
  account_id: acc,
  opened_at: `${opened}T00:00:00Z`,
  closed_at: closed ? `${closed}T00:00:00Z` : null,
  severity,
  status: closed ? "closed" : "open",
  csat_score: csat,
});
const activity = (acc: string, date: string, type: string, level: string): CsActivityRow => ({ account_id: acc, activity_date: date, type, attendee_level: level });
const invoice = (acc: string, month: string, amount: number, status: string): InvoiceStatusRow => ({ account_id: acc, month, amount_usd: amount, status });

test("Health weights: round numbers adding to 100", () => {
  const all = Object.values(HEALTH_WEIGHTS).flatMap((c) => Object.values(c) as number[]);
  assert.equal(all.reduce((s, w) => s + w, 0), 100);
  for (const w of all) assert.equal(w, Math.round(w));
  assert.deepEqual(Object.keys(HEALTH_WEIGHTS), [...HEALTH_CATEGORIES]);
  // Behavioral 35, Relationship 20, Feedback 20, Support 15, Financial 10
  const sum = (c: (typeof HEALTH_CATEGORIES)[number]) => (Object.values(HEALTH_WEIGHTS[c]) as number[]).reduce((s, w) => s + w, 0);
  assert.deepEqual(HEALTH_CATEGORIES.map(sum), [35, 20, 20, 15, 10]);
});

test("Health bands and every scoring band edge", () => {
  assert.equal(healthBand(70), "green");
  assert.equal(healthBand(69.9), "amber");
  assert.equal(healthBand(50), "amber");
  assert.equal(healthBand(49.9), "red");

  // Trend: +10% or more 1 | 0..+10% 0.8 | -10..0 0.6 | -20..-10 0.35 | -30..-20 0.15 | worse than -30% (adoption drop) 0 | none 0.5
  assert.deepEqual([0.1, 0.05, 0, -0.05, -0.1, -0.15, -0.2, -0.3, -0.31].map(trendScore), [1, 0.8, 0.8, 0.6, 0.6, 0.35, 0.35, 0.15, 0]);
  assert.equal(trendScore(null), 0.5);
  // Allowance used: under 25% 0.2 | 25-50% 0.5 | 50-80% 0.85 | 80-100% 1 | over 100% 0.9 | none 0.5
  assert.deepEqual([0.1, 0.25, 0.5, 0.8, 1, 1.2].map(capacityScore), [0.2, 0.5, 0.85, 1, 1, 0.9]);
  assert.equal(capacityScore(null), 0.5);
  // Latest NPS: 9-10 1 | 7-8 0.6 | 5-6 0.3 | 0-4 0 | none 0.4
  assert.deepEqual([10, 9, 8, 7, 6, 5, 4, 0].map(latestNpsScore), [1, 1, 0.6, 0.6, 0.3, 0.3, 0, 0]);
  assert.equal(latestNpsScore(null), 0.4);
  // NPS change: +1 or more 1 | 0 0.7 | -1 0.4 | -2 or worse 0 | only one response 0.5
  assert.deepEqual([3, 1, 0, -1, -2, -5].map(npsChangeScore), [1, 1, 0.7, 0.4, 0, 0]);
  assert.equal(npsChangeScore(null), 0.5);
  // CSAT: 4.5+ 1 | 4.0-4.4 0.75 | 3.0-3.9 0.4 | below 3 0 | none 0.5
  assert.deepEqual([5, 4.5, 4.4, 4, 3.9, 3, 2.9].map(csatScore), [1, 1, 0.75, 0.75, 0.4, 0.4, 0]);
  assert.equal(csatScore(null), 0.5);
  // Last touch: up to 30 days 1 | 31-60 0.6 | 61-90 0.3 | over 90 or never 0
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91].map(lastTouchScore), [1, 1, 0.6, 0.6, 0.3, 0.3, 0]);
  assert.equal(lastTouchScore(null), 0);
  // Open tickets: -10% per low/medium, -25% per high/urgent, floor 0
  close(openTicketsScore(0, 0), 1);
  close(openTicketsScore(2, 1), 0.55); // 1 - 0.2 - 0.25
  assert.equal(openTicketsScore(0, 5), 0);
  // Resolution: up to 2 days 1 | 2-5 0.7 | 5-10 0.35 | over 10 0 | none 0.5
  assert.deepEqual([1, 2, 2.1, 5, 5.1, 10, 10.1].map(resolutionScore), [1, 1, 0.7, 0.7, 0.35, 0.35, 0]);
  assert.equal(resolutionScore(null), 0.5);
  // Overdue invoices: none 1 | one 0.4 | two or more 0
  assert.deepEqual([0, 1, 2, 5].map(overdueScore), [1, 0.4, 0, 0]);
  // Invoice change over 12 months: up 1 | flat or no data 0.6 | down 0
  assert.deepEqual([100, 0, -100].map(netExpansionScore), [1, 0.6, 0]);
  assert.equal(netExpansionScore(null), 0.6);
});

test("Line adoption: usage 40%, allowance 30%, users 30%; not adopted scores 0", () => {
  // usage +20% -> 1; allowance 60% -> 0.85; users flat -> 0.8 => 0.4 + 0.255 + 0.24 = 0.895
  close(lineAdoptionScore({ notAdopted: false, usageChange: 0.2, capacityUsed: 0.6, usersChange: 0 }), 0.895);
  assert.equal(lineAdoptionScore({ notAdopted: true, usageChange: null, capacityUsed: 0, usersChange: null }), 0);
});

test("Line metrics: a short prior window compares daily averages (older snapshots)", () => {
  const lines = [line("L1", "A1", "Core", 1000, 1000)];
  const rows = [usage("A1", "2026-11-01", "chat_assistant", 600, 3), usage("A1", "2026-10-01", "chat_assistant", 400, 2)];
  // Full history: 600 vs 400 = +50%; users 3 vs 2 = +50%
  close(calcContractLineMetrics(lines, rows, AS_OF)[0].usageChange!, 0.5);
  // History starts 2026-09-24: prior window has 20 days (09-24..10-13), so 400 is scaled to 30 days: 400 x 30/20 = 600 -> 0%
  const short = calcContractLineMetrics(lines, rows, AS_OF, "2026-09-24")[0];
  close(short.usageChange!, 0);
  close(short.usersChange!, 0); // 3 vs 2 x 1.5 = 3
});

// One customer worked through by hand.
const A1: HealthInputs = {
  accounts: [account("A1"), account("P1", { status: "prospect" }), account("N1", { start_date: "2026-11-20" })],
  lines: [line("A1-core", "A1", "Core", 9000, 1000), line("A1-extract", "A1", "Extract", 1000, 1000)],
  featureUsage: [usage("A1", "2026-11-01", "chat_assistant", 600, 3), usage("A1", "2026-10-01", "chat_assistant", 500, 3)],
  nps: [
    { account_id: "A1", responded_at: "2026-03-01T00:00:00Z", score: 9 },
    { account_id: "A1", responded_at: "2026-09-15T00:00:00Z", score: 8 },
  ],
  tickets: [
    ticket("T1", "A1", "2026-10-01", "2026-10-04", "medium", 4), // 3 days
    ticket("T2", "A1", "2026-10-10", "2026-10-11", "low", 5), // 1 day
    ticket("T3", "A1", "2026-11-01", null, "high"),
    ticket("T4", "A1", "2026-11-05", null, "low"),
    ticket("T5", "A1", "2026-05-01", "2026-06-01", "urgent", 1), // closed outside 90 days: ignored
  ],
  activities: [
    activity("A1", "2026-09-29", "call", "manager"), // 45 days ago
    activity("A1", "2026-09-01", "exec meeting", "executive"), // 73 days ago: inside 90
    activity("A1", "2025-12-15", "QBR", "executive"), // before this term (from 2026-01-01)
    activity("A1", "2026-11-12", "email", "user"), // emails never count as a touch
  ],
  invoices: [invoice("A1", "2025-11-01", 800, "paid"), invoice("A1", "2026-10-01", 900, "overdue"), invoice("A1", "2026-11-01", 900, "open")],
  usageHistoryStart: "2026-08-15",
};

test("Health score: one customer by hand", () => {
  const rows = calcHealthScores(A1, AS_OF);
  assert.deepEqual(rows.map((r) => r.accountId), ["A1"]); // prospects and customers who haven't started are left out
  const r = rows[0];
  // Behavioral: Core 0.895 (usage +20%, 60% of allowance, users flat) x $9,000, Extract unused 0 x $1,000
  //   = 8,055 / 10,000 = 0.8055 -> 35 x 0.8055 = 28.1925
  close(r.inputs.adoption!, 0.8055);
  close(r.points.behavioral, 28.19);
  // Relationship: last touch 45 days 0.6 x 8 = 4.8; exec meeting in 90 days 7; no QBR this term 0 => 11.8
  assert.equal(r.inputs.lastTouchDays, 45);
  assert.equal(r.inputs.execMeetingIn90d, true);
  assert.equal(r.inputs.qbrThisTerm, false);
  close(r.points.relationship, 11.8);
  // Feedback: NPS 8 0.6 x 12 = 7.2; change -1 0.4 x 4 = 1.6; CSAT (4+5)/2 = 4.5 -> 1 x 4 = 4 => 12.8
  close(r.inputs.csatAvg!, 4.5);
  close(r.points.feedback, 12.8);
  // Support: open 1 low + 1 high = 1 - 0.1 - 0.25 = 0.65 x 10 = 6.5; resolution (3+1)/2 = 2 days -> 1 x 5 = 5 => 11.5
  assert.equal(r.inputs.openLowOrMedium, 1);
  assert.equal(r.inputs.openHighOrUrgent, 1);
  close(r.inputs.avgResolutionDays!, 2);
  close(r.points.support, 11.5);
  // Financial: 1 overdue in 6 months 0.4 x 5 = 2; invoices $800 -> $900 (expansion) 1 x 5 = 5 => 7
  assert.equal(r.inputs.overdueInvoices, 1);
  assert.equal(r.inputs.invoiceChange12m, 100);
  close(r.points.financial, 7);
  // Total 28.1925 + 11.8 + 12.8 + 11.5 + 7 = 71.2925 -> 71.3, green
  assert.equal(r.score, 71.3);
  assert.equal(r.band, "green");
  assert.deepEqual(
    r.lines.map((l) => [l.product, l.notAdopted]),
    [["Core", false], ["Extract", true]],
  );
  // Per line: Core's share of 35 is 35 x 9,000/10,000 = 31.5, earned 0.895 x 31.5 = 28.19; Extract 0 / 3.5
  assert.deepEqual(r.lines.map((l) => [l.earned, l.possible]), [[28.19, 31.5], [0, 3.5]]);
  // Per metric: earned / possible, matching the category totals above
  assert.deepEqual(r.metricPoints.lastTouch, { earned: 4.8, possible: 8 });
  assert.deepEqual(r.metricPoints.execMeeting, { earned: 7, possible: 7 });
  assert.deepEqual(r.metricPoints.qbrThisTerm, { earned: 0, possible: 5 });
  assert.deepEqual(r.metricPoints.openTickets, { earned: 6.5, possible: 10 });
  assert.deepEqual(r.metricPoints.overdueInvoices, { earned: 2, possible: 5 });
  assert.deepEqual(r.possible, { behavioral: 35, relationship: 20, feedback: 20, support: 15, financial: 10 });
});

test("Declining = down 10+ points on last week (a low score alone is not declining)", () => {
  // B1: no lines, NPS, activities or invoices. 4 urgent tickets opened on 2026-11-10.
  //   Both weeks: behavioral 35 x 0.5 = 17.5; relationship 0; feedback 12 x 0.4 + 4 x 0.5 + 4 x 0.5 = 8.8;
  //   resolution 5 x 0.5 = 2.5; financial 5 + 5 x 0.6 = 8.
  //   Last week (11-06) no open tickets: +10 => 46.8. This week all 4 open: +0 => 36.8. Change -10 => declining.
  // D1: the same account without the tickets: 46.8 both weeks. Below 50, but not declining.
  const input: HealthInputs = {
    ...A1,
    accounts: [account("A1"), account("B1"), account("D1")],
    tickets: [...A1.tickets, ...[1, 2, 3, 4].map((k) => ticket(`U${k}`, "B1", "2026-11-10", null, "urgent"))],
  };
  const trend = Object.fromEntries(calcHealthTrend(input, AS_OF).map((r) => [r.accountId, r]));
  assert.deepEqual(trend.B1.history.map((h) => h.date), ["2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30", "2026-11-06", "2026-11-13"]);
  assert.equal(trend.B1.history[4].score, 46.8);
  assert.equal(trend.B1.score, 36.8);
  assert.equal(trend.B1.change, -10);
  assert.equal(trend.B1.declining, true);

  assert.equal(trend.D1.score, 46.8);
  assert.equal(trend.D1.change, 0);
  assert.equal(trend.D1.declining, false);

  assert.equal(trend.A1.change, 0); // 71.3 both weeks
});

test("Renewal risk input: each customer's score, weekly change and lines from the health trend", () => {
  const map = renewalHealth(calcHealthTrend(A1, AS_OF));
  const a1 = map.get("A1")!;
  assert.equal(a1.score, 71.3);
  assert.equal(a1.change, 0);
  assert.deepEqual(a1.lines.map((l) => [l.arr, l.adoptionDrop]), [[9000, false], [1000, false]]);
});

test("Health summary: band counts, declining and ARR at risk (customers below 50)", () => {
  const s = calcHealthSummary([
    { band: "green", declining: false, arr: 10_000 },
    { band: "amber", declining: true, arr: 20_000 },
    { band: "red", declining: true, arr: 30_000 },
    { band: "red", declining: false, arr: 5_000 },
  ]);
  // ARR at risk = 30,000 + 5,000 (the two red customers)
  assert.deepEqual(s, { customers: 4, arr: 65_000, green: 1, amber: 1, red: 2, declining: 2, arrAtRisk: 35_000 });
  assert.deepEqual(calcHealthSummary([]), { customers: 0, arr: 0, green: 0, amber: 0, red: 0, declining: 0, arrAtRisk: 0 });
});
