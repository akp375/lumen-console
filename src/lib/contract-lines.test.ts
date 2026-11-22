// Tests for the per-contract-line metrics in metrics.ts. Hand calculations
// are written next to each expected value. Run with `npm test`.
//
// Today (asOf) = 2026-11-13
// Last 30 days  = 2026-10-14 .. 2026-11-12
// Prior 30 days = 2026-09-14 .. 2026-10-13
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcContractLineMetrics,
  calcDownsellRiskNext,
  calcMissingRenewalDeals,
  type ContractLineMetrics,
  calcRenewalDeals,
  type AccountRow,
  type ContractLineRow,
  type FeatureUsageRow,
  type RenewalDealInput,
} from "./metrics.ts";

const AS_OF = "2026-11-13";

function line(id: string, account: string, product: string, arr: number, included: number): ContractLineRow {
  return {
    id,
    account_id: account,
    contract_id: account.replace("A", "C"),
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
  };
}
function usageRow(account: string, date: string, feature: string, input: number, output: number, users: number | null): FeatureUsageRow {
  return { account_id: account, date, feature, input_tokens: input, output_tokens: output, active_users: users };
}

const LINES = [
  line("A3-code-review", "A3", "Code Review", 1_200, 200_000),
  line("A1-extract", "A1", "Extract", 2_400, 0),
  line("A2-core", "A2", "Core", 6_000, 500_000),
  line("A1-core", "A1", "Core", 9_600, 1_000_000),
];
const USAGE = [
  // A1 Core = chat_assistant + document_summary
  usageRow("A1", "2026-11-01", "chat_assistant", 300_000, 100_000, 6), // last: 400,000 tokens, 6 users
  usageRow("A1", "2026-10-20", "document_summary", 150_000, 50_000, 3), // last: 200,000 tokens, 3 users
  usageRow("A1", "2026-10-01", "chat_assistant", 800_000, 200_000, 12), // prior: 1,000,000 tokens, 12 users
  usageRow("A1", "2026-11-13", "chat_assistant", 999_999, 0, 50), // today: outside both windows
  usageRow("A1", "2026-09-13", "document_summary", 999_999, 0, 50), // before the prior window
  // A1 Extract = data_extraction
  usageRow("A1", "2026-11-05", "data_extraction", 75_000, 25_000, 2), // last: 100,000, 2 users
  usageRow("A1", "2026-09-20", "data_extraction", 60_000, 20_000, 2), // prior: 80,000, 2 users
  // A3 Code Review: down exactly 30%
  usageRow("A3", "2026-10-14", "code_review", 70_000, 0, null), // last: 70,000 (first day of the window), users unknown = 0
  usageRow("A3", "2026-10-13", "code_review", 100_000, 0, 1), // prior: 100,000 (last day of the prior window)
];

const rows = calcContractLineMetrics(LINES, USAGE, AS_OF);
const R = Object.fromEntries(rows.map((r) => [r.lineId, r]));

test("Contract lines: one row per line, by account then product order (Core, Extract, Code Review)", () => {
  assert.deepEqual(rows.map((r) => r.lineId), ["A1-core", "A1-extract", "A2-core", "A3-code-review"]);
});

test("Contract lines: usage comes from the line's own features, last 30 days vs prior 30", () => {
  // Core: 400,000 + 200,000 = 600,000 last; 1,000,000 prior. Today and older rows are ignored.
  assert.equal(R["A1-core"].tokensLast30d, 600_000);
  assert.equal(R["A1-core"].tokensPrior30d, 1_000_000);
  assert.equal(R["A1-core"].usageChange, -0.4); // (600,000 - 1,000,000) / 1,000,000
  // Extract: 100,000 vs 80,000 -> +25%
  assert.equal(R["A1-extract"].tokensLast30d, 100_000);
  assert.equal(R["A1-extract"].usageChange, 0.25);
});

test("Contract lines: capacity used = 30-day tokens / the line's included tokens", () => {
  assert.equal(R["A1-core"].capacityUsed, 0.6); // 600,000 / 1,000,000
  assert.equal(R["A1-extract"].capacityUsed, null); // allowance 0
  assert.equal(R["A3-code-review"].capacityUsed, 0.35); // 70,000 / 200,000
});

test("Contract lines: average daily active users over 30 days, and their change", () => {
  assert.equal(R["A1-core"].avgUsersLast30d, 9 / 30); // (6 + 3) / 30
  assert.equal(R["A1-core"].avgUsersPrior30d, 12 / 30);
  assert.equal(R["A1-core"].usersChange, -0.25); // (9 - 12) / 12
  assert.equal(R["A3-code-review"].avgUsersLast30d, 0); // unknown users count as 0
});

test("Contract lines: adoption drop only when usage falls MORE than 30%", () => {
  assert.equal(R["A1-core"].adoptionDrop, true); // -40%
  assert.equal(R["A1-extract"].adoptionDrop, false); // +25%
  assert.equal(R["A3-code-review"].usageChange, -0.3); // (70,000 - 100,000) / 100,000
  assert.equal(R["A3-code-review"].adoptionDrop, false); // exactly -30% is not a drop
});

test("Contract lines: a line with no usage is 'not adopted', with no change and no drop", () => {
  const r = R["A2-core"];
  assert.equal(r.notAdopted, true);
  assert.equal(r.tokensLast30d, 0);
  assert.equal(r.usageChange, null);
  assert.equal(r.adoptionDrop, false);
  assert.equal(r.capacityUsed, 0); // 0 / 500,000
  assert.equal(R["A1-core"].notAdopted, false);
});

test("Contract lines: carries ARR, dates and status from the line", () => {
  assert.equal(R["A1-core"].arr, 9_600);
  assert.equal(R["A1-core"].purchaseDate, "2026-01-01");
  assert.equal(R["A1-core"].renewalDate, "2027-01-01");
  assert.equal(R["A1-core"].status, "active");
  assert.equal(R["A1-core"].contractId, "C1");
});

test("Contract lines: stops with a clear error for a feature with no product", () => {
  assert.throws(
    () => calcContractLineMetrics(LINES, [usageRow("A1", "2026-11-01", "voice_agent", 1, 1, 1)], AS_OF),
    /Usage feature "voice_agent" has no product/,
  );
});

// ---------------------------------------------------------------------------
// Renewal deals joined to their contract's lines (on contract_id)
//
// From the lines above:
//   C1 (A1): Core $9,600 (adoption drop, -40%) + Extract $2,400 (in use) = $12,000
//   C2 (A2): Core $6,000 (not adopted)
//   C3 (A3): Code Review $1,200 (exactly -30%, so in use)
//   C9: one churned line only (added below), so no active lines
// ---------------------------------------------------------------------------

const account = (id: string, name: string): AccountRow => ({
  id, name, status: "customer", segment: "SMB", mrr_usd: 0, included_tokens_monthly: 0,
  start_date: null, renewal_date: null, churn_date: null, owner: `Owner ${id}`,
});
const ACCOUNTS = [account("A1", "Alpha"), account("A2", "Beta"), account("A3", "Gamma"), account("A9", "Omega")];
const deal = (id: string, acc: string, stage: string, amount: number, contract: string | null): RenewalDealInput => ({
  id, account_id: acc, stage, amount_usd: amount, close_date: "2026-12-01", contract_id: contract,
});
const CHURNED_LINE = { ...rows[0], lineId: "C9-core", accountId: "A9", contractId: "C9", status: "churned" as const, arr: 5_000, adoptionDrop: true };
const METRICS = [...rows, CHURNED_LINE];

const deals = calcRenewalDeals(
  [
    deal("R1", "A1", "Proposal", 13_000, "C1"),
    deal("R2", "A2", "Closed Won", 5_400, "C2"),
    deal("R3", "A3", "Negotiation", 1_200.4, "C3"),
    deal("R4", "A1", "Closed Won", 12_000, "C1"),
    deal("R5", "A1", "Discovery", 3_000, null),
    deal("R6", "A9", "Closed Lost", 5_000, "C9"),
  ],
  METRICS,
  ACCOUNTS,
);
const D = Object.fromEntries(deals.map((d) => [d.opportunityId, d]));

test("Renewal deals: one row per deal with its full amount, lines joined on contract_id", () => {
  assert.equal(deals.length, 6);
  assert.equal(D.R1.amount, 13_000);
  assert.deepEqual(D.R1.lines.map((l) => l.product), ["Core", "Extract"]); // product order
  assert.equal(D.R1.linesArr, 12_000); // 9,600 + 2,400
  assert.equal(D.R1.accountName, "Alpha");
  assert.equal(D.R1.open, true);
  assert.equal(D.R2.open, false);
});

test("Renewal deals: difference = amount - sum of lines, labelled uplift or reduction", () => {
  assert.equal(D.R1.difference, 1_000); // 13,000 - 12,000
  assert.equal(D.R1.differenceKind, "uplift");
  assert.equal(D.R2.difference, -600); // 5,400 - 6,000
  assert.equal(D.R2.differenceKind, "reduction");
  assert.equal(D.R3.differenceKind, "matches"); // 1,200.40 - 1,200 = 0.40, under $1
  assert.equal(D.R4.differenceKind, "matches"); // 12,000 - 12,000
});

test("Renewal deals: adoption status per line, and adoption drops are downsell risk", () => {
  const [core, extract] = D.R1.lines;
  assert.equal(core.adoptionStatus, "Adoption drop");
  assert.equal(core.downsellRisk, true);
  assert.equal(extract.adoptionStatus, "In use");
  assert.equal(extract.downsellRisk, false);
  assert.equal(D.R1.downsellRiskArr, 9_600);
  assert.equal(D.R2.lines[0].adoptionStatus, "Not adopted");
  assert.equal(D.R2.lines[0].downsellRisk, false); // not adopted is not a drop
  assert.equal(D.R3.lines[0].adoptionStatus, "In use"); // exactly -30%
});

test("Renewal deals: only active lines; no contract or a churned contract means no lines", () => {
  assert.deepEqual(D.R5.lines, []);
  assert.equal(D.R5.linesArr, 0);
  assert.equal(D.R5.difference, null); // nothing to compare with, so no uplift
  assert.equal(D.R5.differenceKind, "no active lines");
  assert.equal(D.R6.differenceKind, "no active lines");
  assert.deepEqual(D.R6.lines, []); // C9's only line is churned
  assert.equal(D.R6.downsellRiskArr, 0);
});

// ---------------------------------------------------------------------------
// Next 180 days: downsell risk and missing renewal deals
//
// Today = 2026-11-13, so today + 180 days = 2027-05-12 (inside); 2027-05-13 is day 181.
// ---------------------------------------------------------------------------

function metric(lineId: string, accountId: string, contractId: string, arr: number, renewalDate: string, adoptionDrop: boolean, status: ContractLineMetrics["status"] = "active"): ContractLineMetrics {
  return { ...rows[0], lineId, accountId, contractId, product: "Core", arr, renewalDate, adoptionDrop, status, notAdopted: false };
}
const AHEAD = [
  metric("C1-core", "A1", "C1", 9_600, "2027-01-01", true), // day 49, drop
  metric("C1-extract", "A1", "C1", 2_400, "2027-01-01", false), // day 49, no drop
  metric("C4-core", "A4", "C4", 5_000, "2027-05-12", true), // day 180: inside
  metric("C5-core", "A5", "C5", 3_000, "2027-05-13", true), // day 181: outside
  metric("C6-core", "A6", "C6", 4_000, "2026-11-12", true), // yesterday: outside
  metric("C7-core", "A7", "C7", 7_000, "2027-02-20", false), // day 99, has an open renewal deal
  metric("C8-core", "A8", "C8", 1_000, "2026-12-13", false), // day 30, only a won renewal deal
  metric("C9-core", "A9", "C9", 8_000, "2027-01-01", true, "churned"), // churned line
];

test("ARR at downsell risk, next 180 days: adoption-drop lines renewing from today to day 180", () => {
  // C1 Core 9,600 (day 49) + C4 Core 5,000 (day 180). Not C5 (day 181), C6 (past) or C9 (churned).
  assert.deepEqual(calcDownsellRiskNext(AHEAD, AS_OF), { arr: 14_600, lines: 2, contracts: 2 });
  // Small print, all customers: every active drop line, any date: 9,600 + 5,000 + 3,000 + 4,000
  assert.deepEqual(calcDownsellRiskNext(AHEAD, AS_OF, null), { arr: 21_600, lines: 4, contracts: 4 });
});

test("Missing renewal deal: customer contracts renewing within 180 days with no open renewal deal", () => {
  const accts = ["A1", "A4", "A5", "A6", "A7", "A8"].map((id) => account(id, `Acct ${id}`));
  const r = calcMissingRenewalDeals(
    [...accts, { ...account("A9", "Churned co"), status: "churned" }],
    AHEAD,
    [deal("D7", "A7", "Proposal", 7_000, "C7"), deal("D8", "A8", "Closed Won", 1_000, "C8")],
    new Map([["A1", "High" as const]]),
    AS_OF,
  );
  // In the window: C8 (day 30), C1 (day 49), C7 (day 99), C4 (day 180). C7 has an open deal, so it's covered.
  // C8's only deal is closed, so it still needs one.
  assert.deepEqual(r.rows.map((x) => x.contractId), ["C8", "C1", "C4"]); // soonest renewal first
  assert.equal(r.count, 3);
  assert.equal(r.arr, 18_000); // 1,000 + (9,600 + 2,400) + 5,000
  const by = Object.fromEntries(r.rows.map((x) => [x.contractId, x]));
  assert.equal(by.C1.arr, 12_000);
  assert.equal(by.C1.downsellRiskArr, 9_600);
  assert.equal(by.C1.riskLevel, "High"); // flagged by the renewal-risk rule
  assert.equal(by.C8.riskLevel, "Low"); // not High or Medium
  assert.equal(by.C4.riskLevel, "Low"); // every customer has a level now: no entry means Low
  assert.equal(by.C8.daysToRenewal, 30);
});
