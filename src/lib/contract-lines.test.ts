// Tests for the per-contract-line metrics in metrics.ts. Hand calculations
// are written next to each expected value. Run with `npm test`.
//
// Today (asOf) = 2026-11-13
// Last 30 days  = 2026-10-14 .. 2026-11-12
// Prior 30 days = 2026-09-14 .. 2026-10-13
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcContractLineMetrics, type ContractLineRow, type FeatureUsageRow } from "./metrics.ts";

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
