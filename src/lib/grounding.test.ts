// Tests for src/lib/grounding.ts. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGrounding } from "./grounding.ts";

const INPUT = {
  as_of: "13 Nov 2026",
  rules: { sla_hours: 24 },
  arr_at_risk: 34800,
  speed: [{ adr: "Kenji Watanabe", on_time_pct: 64.5, points_vs_team: -4.9 }],
  tiers: ["Tier 3"],
  pairing_from: "1 Oct 2026",
};

const flagged = (text: string) => checkGrounding({ f: text }, INPUT).ungrounded.map((u) => u.text);

test("Grounding: numbers from the input pass, however they are written", () => {
  assert.deepEqual(flagged("Kenji touched 64.5% of MQLs within 24 hours, -4.9 points vs the team."), []);
  assert.deepEqual(flagged("$34,800 of ARR is at risk; 34800 again."), []);
  assert.deepEqual(flagged("Tier 3 accounts; the 24-hour SLA."), []); // numbers inside input text
  assert.deepEqual(flagged("64.50% on time."), []); // same value
});

test("Grounding: invented, rounded or abbreviated numbers are flagged", () => {
  assert.deepEqual(flagged("About 65% on time."), ["65%"]);
  assert.deepEqual(flagged("$35K at risk."), ["$35"]);
  assert.deepEqual(flagged("Lift SLA to 80% to gain 12 meetings."), ["80%", "12"]);
});

test("Grounding: dates are checked whole", () => {
  assert.deepEqual(flagged("As of 13 Nov 2026."), []);
  assert.deepEqual(flagged("Since 1 Oct, deals..."), []); // no year: matches 1 Oct 2026
  assert.deepEqual(flagged("By 13 November 2026."), []); // long month name
  assert.deepEqual(flagged("By 30 Nov 2026."), ["30 Nov 2026"]);
  assert.deepEqual(flagged("Sofia Marin 12 deals"), ["12"]); // "Marin" isn't read as a month
});

test("Grounding: counts every number checked, per field", () => {
  const r = checkGrounding({ headline: "64.5% vs 70%", action: "none" }, INPUT);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.ungrounded, [{ field: "headline", text: "70%" }]);
});
