// Tests for the lead lifecycle builder in scripts/adr-lib.ts (buildLeadStages). Run with: npm test
// "Today" is 2026-11-13.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeadStages } from "./adr-lib.ts";

const AS_OF = "2026-11-13";
type In = Parameters<typeof buildLeadStages>[0];
const base: In = {
  id: "lead_x", lead_source: "content download", lifecycle_stage: "lead", created_at: "2026-06-01T10:00:00Z",
  mql_at: null, first_touch_at: null, sql_at: null, assigned_adr_id: "tm_12", disqualify_reason: null, opportunity_id: null,
};
const run = (over: Partial<In>, dealStage: string | null = null, id = "lead_x") => buildLeadStages({ ...base, id, ...over }, dealStage, AS_OF);
const ms = (s: string | null) => Date.parse(s!);

test("Lead stages: a lead with a Qualifying deal reaches Meeting booked at sql_at, in order", () => {
  const { fields: f } = run({ lead_source: "inbound demo request", lifecycle_stage: "SQL", created_at: "2026-10-01T09:00:00Z", mql_at: "2026-10-01T09:00:00Z", first_touch_at: "2026-10-01T15:00:00Z", sql_at: "2026-10-06T11:00:00Z", opportunity_id: "opp_s01_001" }, "Stage 0.1");
  assert.equal(f.lead_stage, "meeting_booked");
  assert.equal(f.engaged_at, "2026-10-01T09:00:00Z"); // a demo request is engaged at creation
  assert.equal(f.sales_accepted_at, "2026-10-01T15:00:00Z"); // the first touch
  assert.equal(f.meeting_booked_at, "2026-10-06T11:00:00Z");
  assert.ok(ms(f.sales_qualified_at) > ms(f.sales_accepted_at) && ms(f.sales_qualified_at) < ms(f.meeting_booked_at));
  assert.equal(f.converted_at, null);
});

test("Lead stages: a deal past Qualifying means Converted, on the day of the meeting", () => {
  const { fields: f } = run({ lead_source: "outbound", lifecycle_stage: "SQL", created_at: "2026-07-01T09:00:00Z", mql_at: "2026-07-05T09:00:00Z", first_touch_at: "2026-07-01T09:30:00Z", sql_at: "2026-07-12T10:00:00Z", opportunity_id: "opp_0050" }, "Discovery");
  assert.equal(f.lead_stage, "converted");
  assert.equal(f.converted_at, "2026-07-12T10:00:00Z");
  assert.equal(f.sales_accepted_at, "2026-07-05T09:00:00Z"); // outbound email came before the MQL: accepted at the MQL
  assert.ok(ms(f.engaged_at) <= ms("2026-07-05T09:00:00Z"));
});

test("Lead stages: no Meeting booked without a deal; disqualified at the qualifying call", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const { fields: f, disqualifyReason } = run({ lead_source: "outbound", lifecycle_stage: "disqualified", created_at: "2026-06-01T09:00:00Z", mql_at: "2026-06-03T09:00:00Z", first_touch_at: "2026-06-03T12:00:00Z", sql_at: "2026-06-10T10:00:00Z", disqualify_reason: "Not a fit at the qualifying call" }, null, `lead_dq_${i}`);
    assert.equal(f.lead_stage, "disqualified");
    assert.equal(f.meeting_booked_at, null);
    assert.ok(f.disqualified_at && ms(f.disqualified_at) >= ms("2026-06-10T10:00:00Z"));
    seen.add(f.sales_qualified_at ? `qualified: ${disqualifyReason}` : `accepted: ${disqualifyReason}`);
  }
  assert.deepEqual([...seen].sort(), ["accepted: Not a fit at the qualifying call", "qualified: No budget this year"]);
});

test("Lead stages: an open qualified lead with no deal stays at Sales qualified (a handoff leak)", () => {
  const { fields: f } = run({ lead_source: "event", lifecycle_stage: "SQL", created_at: "2026-06-01T09:00:00Z", mql_at: "2026-06-02T09:00:00Z", first_touch_at: "2026-06-02T12:00:00Z", sql_at: "2026-06-09T10:00:00Z" });
  assert.equal(f.lead_stage, "sales_qualified");
  assert.equal(f.sales_qualified_at, "2026-06-09T10:00:00Z");
  assert.equal(f.meeting_booked_at, null);
});

test("Lead stages: untouched or unassigned MQLs stay at MQL, however old (they are SLA breaches)", () => {
  assert.equal(run({ lifecycle_stage: "MQL", mql_at: "2026-06-05T09:00:00Z" }).fields.lead_stage, "mql");
  const unassigned = run({ lifecycle_stage: "MQL", mql_at: "2026-06-05T09:00:00Z", first_touch_at: "2026-06-05T12:00:00Z", assigned_adr_id: null }).fields;
  assert.equal(unassigned.lead_stage, "mql");
  assert.equal(unassigned.sales_accepted_at, null);
});

test("Lead stages: stalled Sales accepted leads go to Nurture; recent ones stay open", () => {
  const old = run({ lifecycle_stage: "MQL", mql_at: "2026-08-01T09:00:00Z", first_touch_at: "2026-08-01T12:00:00Z" }).fields;
  assert.equal(old.lead_stage, "nurture");
  assert.ok(ms(old.nurtured_at) >= ms("2026-08-22T12:00:00Z") && ms(old.nurtured_at) <= ms("2026-08-31T12:00:00Z")); // 21-30 days after acceptance
  const recent = run({ lifecycle_stage: "MQL", mql_at: "2026-11-01T09:00:00Z", first_touch_at: "2026-11-01T12:00:00Z" }).fields;
  assert.equal(recent.lead_stage, "sales_accepted");
});

test("Lead stages: leads that never reach MQL go to Nurture after 30-45 days, if 45+ days old", () => {
  const old = run({ created_at: "2026-06-01T10:00:00Z" }).fields;
  assert.equal(old.lead_stage, "nurture");
  const days = (ms(old.nurtured_at) - ms("2026-06-01T10:00:00Z")) / 86_400_000;
  assert.ok(days >= 30 && days <= 46);
  const recent = run({ created_at: "2026-11-01T10:00:00Z" }).fields;
  assert.ok(recent.lead_stage === "new" || recent.lead_stage === "engaged");
  assert.equal(recent.nurtured_at, null);
});

test("Lead stages: the same lead always gets the same path", () => {
  const a = run({ lifecycle_stage: "MQL", mql_at: "2026-08-01T09:00:00Z", first_touch_at: "2026-08-01T12:00:00Z" });
  const b = run({ lifecycle_stage: "MQL", mql_at: "2026-08-01T09:00:00Z", first_touch_at: "2026-08-01T12:00:00Z" });
  assert.deepEqual(a, b);
});
