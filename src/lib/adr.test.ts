// Tests for the ADR hygiene checks and insights in src/lib/metrics.ts, against a tiny hand-made dataset.
// Run with: npm test
//
// "Today" is 2026-11-13, so "now" is 2026-11-13T23:59:59.999Z. Key dates that follow from it:
//   insights window: from 2026-05-13 (6 months)
//   30-day SLA rate: MQLs from 2026-10-14T23:59:59.999Z whose 24 hours are up by now
//   handoff grace:   an SQL no later than 2026-11-10T23:59:59.999Z with no deal is a leak

import { test } from "node:test";
import assert from "node:assert/strict";
import { ADR_RULES, calcAdrHygiene, calcAdrInsights, type AdrEnrollmentRow, type AdrInputs, type AdrLeadRow } from "./metrics.ts";

const AS_OF = "2026-11-13";

const lead = (id: string, over: Partial<AdrLeadRow>): AdrLeadRow => ({
  id, account_id: "A1", contact_name: `Contact ${id}`, lead_source: "inbound demo request", lifecycle_stage: "lead",
  created_at: "2026-11-01T00:00:00Z", mql_at: null, first_touch_at: null, sql_at: null, assigned_adr_id: null, opportunity_id: null, ...over,
});

const LEADS: AdrLeadRow[] = [
  // L1: touched exactly 24h after becoming an MQL -> on time
  lead("L1", { lifecycle_stage: "MQL", mql_at: "2026-11-10T00:00:00Z", first_touch_at: "2026-11-11T00:00:00Z", assigned_adr_id: "d1" }),
  // L2: touched 24h + 1 minute after -> late (24.0167 hours)
  lead("L2", { lifecycle_stage: "MQL", mql_at: "2026-11-10T00:00:00Z", first_touch_at: "2026-11-11T00:01:00Z", assigned_adr_id: "d1" }),
  // L3: never touched, deadline 2026-11-13T23:00 has passed -> open breach, 0 days old
  lead("L3", { account_id: "A2", lead_source: "webinar", lifecycle_stage: "MQL", mql_at: "2026-11-12T23:00:00Z", assigned_adr_id: "d2" }),
  // L4: never touched, but its 24 hours aren't up yet (deadline 2026-11-14T01:00) -> not a breach, not in any rate
  lead("L4", { account_id: "A2", lead_source: "webinar", lifecycle_stage: "MQL", mql_at: "2026-11-13T01:00:00Z", assigned_adr_id: "d2" }),
  // L5: open lead with no ADR, created 2026-11-03 -> unassigned, 10 days; A1's owner Ann is paired with d1
  lead("L5", { lead_source: "content download", created_at: "2026-11-03T00:00:00Z" }),
  // L6: disqualified with no ADR -> not unassigned
  lead("L6", { account_id: "A2", lead_source: "content download", lifecycle_stage: "disqualified" }),
  // L7: SQL 2026-11-10T12:00 with no deal, past the 3-day grace -> handoff leak, 3 days old. Touched in 2h.
  lead("L7", { lifecycle_stage: "SQL", mql_at: "2026-11-08T00:00:00Z", first_touch_at: "2026-11-08T02:00:00Z", sql_at: "2026-11-10T12:00:00Z", assigned_adr_id: "d1" }),
  // L8: SQL 2026-11-11T12:00 with no deal, inside the grace period -> not a leak. Touched in 4h. No sequence meeting.
  lead("L8", { lifecycle_stage: "SQL", mql_at: "2026-11-09T00:00:00Z", first_touch_at: "2026-11-09T04:00:00Z", sql_at: "2026-11-11T12:00:00Z", assigned_adr_id: "d1" }),
  // L9: outbound, became deal O1 (still Stage 0.1). Touched in 5h.
  lead("L9", { account_id: "A2", lead_source: "outbound", lifecycle_stage: "SQL", created_at: "2026-09-01T00:00:00Z", mql_at: "2026-09-02T00:00:00Z", first_touch_at: "2026-09-02T05:00:00Z", sql_at: "2026-09-10T00:00:00Z", assigned_adr_id: "d2", opportunity_id: "O1" }),
  // L10: outbound, became deal O2 (now Discovery, so an opportunity). Touched in 10h.
  lead("L10", { account_id: "A2", lead_source: "outbound", lifecycle_stage: "SQL", created_at: "2026-08-01T00:00:00Z", mql_at: "2026-08-02T00:00:00Z", first_touch_at: "2026-08-02T10:00:00Z", sql_at: "2026-08-05T00:00:00Z", assigned_adr_id: "d2", opportunity_id: "O2" }),
  // L11: created before the 6-month window -> left out of the funnel
  lead("L11", { lead_source: "outbound", created_at: "2026-05-01T00:00:00Z", assigned_adr_id: "d1" }),
];

const enr = (id: string, seq: string, over: Partial<AdrEnrollmentRow> = {}): AdrEnrollmentRow => ({
  id, sequence_id: seq, lead_id: `X${id}`, adr_id: null, enrolled_at: "2026-10-01T00:00:00Z", opens: 0, replies: 0, bounces: 0, meeting_booked: false, meeting_booked_at: null, ...over,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const meeting = (lead_id: string, adr_id: string) => ({ lead_id, adr_id, meeting_booked: true, meeting_booked_at: "2026-10-05T00:00:00Z" });

const ENROLLMENTS: AdrEnrollmentRow[] = [
  // S1: 20 enrollments; 10 opened, 6 replied, 1 bounced, 5 meetings (L7 and X1 for d1; L9, L10 and X2 for d2)
  ...range(20).map((i) =>
    enr(`s1_${i}`, "S1", {
      opens: i < 10 ? 1 : 0,
      replies: i < 6 ? 1 : 0,
      bounces: i === 19 ? 1 : 0,
      ...(i === 0 ? meeting("L7", "d1") : i === 1 ? meeting("X1", "d1") : i === 2 ? meeting("L9", "d2") : i === 3 ? meeting("L10", "d2") : i === 4 ? meeting("X2", "d2") : {}),
    }),
  ),
  // S2: 20 enrollments, no meetings, 4 bounced (20%: above the 10% alert)
  ...range(20).map((i) => enr(`s2_${i}`, "S2", { bounces: i < 4 ? 1 : 0 })),
  // S3: 20 enrollments, no meetings, 2 bounced (exactly 10%: not an alert)
  ...range(20).map((i) => enr(`s3_${i}`, "S3", { bounces: i < 2 ? 1 : 0 })),
  // S4: 19 enrollments, 10 meetings: the best rate, but too few enrollments to be ranked
  ...range(19).map((i) => enr(`s4_${i}`, "S4", i < 10 ? { meeting_booked: true, meeting_booked_at: "2026-10-02T00:00:00Z" } : {})),
  // S5: one enrollment before the window, with a meeting for d1 -> counted nowhere
  enr("s5_0", "S5", { enrolled_at: "2026-04-01T00:00:00Z", meeting_booked: true, meeting_booked_at: "2026-04-02T00:00:00Z", adr_id: "d1" }),
];

const INPUT: AdrInputs = {
  leads: LEADS,
  enrollments: ENROLLMENTS,
  sequences: ["S1", "S2", "S3", "S4", "S5"].map((id) => ({ id, name: `Sequence ${id}`, owner_id: "d1" })),
  deals: [
    // O1: Stage 0.1, last update 2026-10-30 = 14 days ago -> stale. Bob (a2) with his paired ADR d2, so no mismatch.
    { id: "O1", account_id: "A2", stage: "Stage 0.1", created_date: "2026-10-20", last_activity_date: "2026-10-30", ae_id: "a2", adr_id: "d2" },
    // O3: Stage 0.1, 13 days since update -> not stale; ADR d2 with AE a1 (paired with d1), created after 1 Oct -> mismatch, 19 days
    { id: "O3", account_id: "A1", stage: "Stage 0.1", created_date: "2026-10-25", last_activity_date: "2026-10-31", ae_id: "a1", adr_id: "d2" },
    // O2: Discovery, d1 with a2, but created before the pairing date -> not judged
    { id: "O2", account_id: "A2", stage: "Discovery", created_date: "2026-08-10", last_activity_date: "2026-11-01", ae_id: "a2", adr_id: "d1" },
    // O4: closed -> not judged
    { id: "O4", account_id: "A1", stage: "Closed Lost", created_date: "2026-10-05", last_activity_date: "2026-10-20", ae_id: "a1", adr_id: "d2" },
    // O5: Demo created on the pairing date itself -> mismatch, 43 days
    { id: "O5", account_id: "A1", stage: "Demo", created_date: "2026-10-01", last_activity_date: "2026-11-10", ae_id: "a1", adr_id: "d2" },
    // O6: created the day before the pairing date -> not judged
    { id: "O6", account_id: "A1", stage: "Demo", created_date: "2026-09-30", last_activity_date: "2026-11-10", ae_id: "a1", adr_id: "d2" },
  ],
  accounts: [
    { id: "A1", name: "Alpha", status: "prospect", owner: "Ann", icp_tier: 1, target_account: true, territory: "T1" }, // clean
    { id: "A2", name: "Bravo", status: "prospect", owner: "Bob", icp_tier: null, target_account: false, territory: "T2" }, // no tier
    { id: "A3", name: "Charlie", status: "customer", owner: "Ann", icp_tier: 3, target_account: true, territory: null }, // tier 3 target + no territory
    { id: "A4", name: "Delta", status: "customer", owner: "Bob", icp_tier: 2, target_account: false, territory: "T1" }, // wrong territory
    { id: "A5", name: "Echo", status: "churned", owner: "Ann", icp_tier: null, target_account: false, territory: null }, // churned: ignored
  ],
  team: [
    { id: "a1", name: "Ann", role: "AE", territory: "T1" },
    { id: "a2", name: "Bob", role: "AE", territory: "T2" },
    { id: "d1", name: "Ada", role: "ADR", territory: "T1" },
    { id: "d2", name: "Dan", role: "ADR", territory: "T2" },
    { id: "m1", name: "Mia", role: "ADR manager", territory: null },
  ],
  pairings: [
    { adr_id: "d1", ae_id: "a1", effective_from: "2026-10-01" },
    { adr_id: "d2", ae_id: "a2", effective_from: "2026-10-01" },
  ],
};

const counts = (r: ReturnType<typeof calcAdrHygiene>) => Object.fromEntries(r.checks.map((c) => [c.key, c.count]));

test("ADR rules: the agreed thresholds", () => {
  assert.equal(ADR_RULES.slaHours, 24);
  assert.equal(ADR_RULES.staleStage01Days, 14);
  assert.equal(ADR_RULES.slaBreachRateDays, 30);
  assert.equal(ADR_RULES.sequenceMinEnrollments, 20);
  assert.equal(ADR_RULES.sequenceBounceAlertAbove, 0.1);
});

test("ADR hygiene: every check, its edges and the total", () => {
  const h = calcAdrHygiene(INPUT, AS_OF);
  // unassigned L5; open breach L3 (not L4); stale O1 (14 days, not O3 at 13); leak L7 (not L8 inside the grace);
  // mismatches O3 and O5 (not O2/O6 before the date, not closed O4); tags: A2, A3 x2, A4 (not churned A5)
  assert.deepEqual(counts(h), { unassigned: 1, slaBreach: 1, staleStage01: 1, handoffLeak: 1, pairingMismatch: 2, accountTags: 4 });
  assert.equal(h.total, 10);
  const items = (k: string) => h.checks.find((c) => c.key === k)!.items;
  assert.equal(items("unassigned")[0].recordId, "L5");
  assert.equal(items("unassigned")[0].ageDays, 10);
  assert.equal(items("unassigned")[0].owner, "Unassigned (territory ADR: Ada)");
  assert.equal(items("slaBreach")[0].recordId, "L3");
  assert.equal(items("slaBreach")[0].ageDays, 0);
  assert.equal(items("staleStage01")[0].recordId, "O1");
  // Users see "Qualifying", never the stored stage value "Stage 0.1"
  assert.equal(h.checks.find((c) => c.key === "staleStage01")!.title, "Stale Qualifying deals");
  assert.equal(items("pairingMismatch").find((i) => i.recordId === "O3")!.problem, "Qualifying: Ann is paired with Ada");
  assert.equal(items("pairingMismatch").find((i) => i.recordId === "O5")!.problem, "Demo: Ann is paired with Ada");
  assert.equal(items("staleStage01")[0].ageDays, 14);
  assert.equal(items("handoffLeak")[0].recordId, "L7");
  assert.equal(items("handoffLeak")[0].ageDays, 3);
  assert.deepEqual(items("pairingMismatch").map((i) => [i.recordId, i.ageDays]), [["O5", 43], ["O3", 19]]); // oldest first
  assert.deepEqual(items("accountTags").map((i) => `${i.recordId}: ${i.problem}`).sort(), [
    "A2: No ICP tier",
    "A3: No territory",
    "A3: Tier 3 marked as target",
    "A4: Territory is T1, owner's is T2",
  ]);
  assert.ok(items("accountTags").every((i) => i.ageDays === null)); // not recorded
});

test("ADR hygiene: 30-day SLA breach rate counts late and never-touched MQLs whose 24 hours are up", () => {
  // Eligible: L1, L2, L3, L7, L8 (L4's 24 hours aren't up; L9, L10 are older than 30 days). Breached: L2 (late), L3 (never).
  assert.deepEqual(calcAdrHygiene(INPUT, AS_OF).slaBreachRate30d, { breached: 2, eligible: 5, rate: 0.4 });
});

test("ADR hygiene: the ADR filter splits every issue to one ADR", () => {
  const d1 = calcAdrHygiene(INPUT, AS_OF, "d1");
  const d2 = calcAdrHygiene(INPUT, AS_OF, "d2");
  // d1: L5 (territory), L7, A3 x2 (Ann's accounts). d2: L3, O1, O3, O5, A2, A4 (Bob's accounts).
  assert.deepEqual(counts(d1), { unassigned: 1, slaBreach: 0, staleStage01: 0, handoffLeak: 1, pairingMismatch: 0, accountTags: 2 });
  assert.deepEqual(counts(d2), { unassigned: 0, slaBreach: 1, staleStage01: 1, handoffLeak: 0, pairingMismatch: 2, accountTags: 2 });
  assert.equal(d1.total + d2.total, 10);
  assert.deepEqual(d1.slaBreachRate30d, { breached: 1, eligible: 4, rate: 0.25 }); // L1, L2, L7, L8; L2 late
});

test("ADR insights: funnel by source, with the window and Qualifying / opportunity rules", () => {
  const f = calcAdrInsights(INPUT, AS_OF).funnel;
  const row = (s: string) => f.find((x) => x.source === s)!;
  // Outbound: L9 (deal O1, still Stage 0.1) and L10 (deal O2, now Discovery). L11 is before the window.
  assert.deepEqual(
    { leads: row("outbound").leads, mql: row("outbound").mql, sql: row("outbound").sql, s01: row("outbound").stage01, opp: row("outbound").opportunity },
    { leads: 2, mql: 2, sql: 2, s01: 2, opp: 1 },
  );
  assert.equal(row("outbound").stage01ToOpportunity, 0.5);
  assert.equal(row("outbound").leadToOpportunity, 0.5);
  assert.deepEqual([row("inbound demo request").leads, row("inbound demo request").sql, row("inbound demo request").stage01], [4, 2, 0]);
  assert.equal(row("inbound demo request").sqlToStage01, 0);
  assert.equal(row("content download").mqlToSql, null); // no MQLs: no rate, not 0%
  assert.equal(f[0].source, "outbound"); // best lead-to-opportunity first
  const all = f[f.length - 1];
  assert.deepEqual([all.source, all.leads, all.mql, all.sql, all.stage01, all.opportunity], ["All sources", 10, 8, 4, 2, 1]);
});

test("ADR insights: speed to lead per ADR and for the team", () => {
  const s = calcAdrInsights(INPUT, AS_OF);
  const ada = s.speed.find((x) => x.adrId === "d1")!;
  const dan = s.speed.find((x) => x.adrId === "d2")!;
  // Ada: L1 24h (on time), L2 24.0167h (late), L7 2h, L8 4h. Median of 2, 4, 24, 24.0167 = (4 + 24) / 2 = 14.
  assert.deepEqual([ada.mqls, ada.onTime, ada.late, ada.never, ada.onTimeRate, ada.medianHoursToTouch], [4, 3, 1, 0, 0.75, 14]);
  // Dan: L3 never, L9 5h, L10 10h (L4 not due yet). Median of touched = 7.5; the never-touched MQL is a count, not in the median.
  assert.deepEqual([dan.mqls, dan.onTime, dan.late, dan.never, dan.medianHoursToTouch], [3, 2, 0, 1, 7.5]);
  assert.equal(s.speed.some((x) => x.adrId === null), false); // no unassigned MQLs here
  // Team: 7 MQLs, 5 on time. Median of 2, 4, 5, 10, 24, 24.0167 = 7.5
  assert.deepEqual([s.team.mqls, s.team.onTime, s.team.late, s.team.never, s.team.medianHoursToTouch], [7, 5, 1, 1, 7.5]);
});

test("ADR insights: sequence rates, best and worst, bounce alert", () => {
  const seq = calcAdrInsights(INPUT, AS_OF).sequences;
  const by = (id: string) => seq.find((x) => x.id === id)!;
  assert.deepEqual([by("S1").enrollments, by("S1").openRate, by("S1").replyRate, by("S1").meetingRate, by("S1").bounceRate], [20, 0.5, 0.3, 0.25, 0.05]);
  assert.equal(by("S1").rank, "best");
  // S2 and S3 tie at 0% meetings; S2 bounces more, so it is the worst
  assert.equal(by("S2").rank, "worst");
  assert.equal(by("S3").rank, null);
  assert.equal(by("S4").rank, null); // 19 enrollments: too few to rank, even with the best rate
  assert.equal(by("S2").bounceAlert, true); // 20%
  assert.equal(by("S3").bounceAlert, false); // exactly 10%
  assert.equal(by("S5").enrollments, 0); // its one enrollment is before the window
  assert.equal(by("S5").meetingRate, null);
});

test("ADR insights: per-ADR table counts meetings from sequence enrollments", () => {
  const s = calcAdrInsights(INPUT, AS_OF);
  const ada = s.scorecard.find((x) => x.adrId === "d1")!;
  const dan = s.scorecard.find((x) => x.adrId === "d2")!;
  // Ada owns L1, L2, L7, L8 (L11 is before the window). Meetings: L7 and X1 in S1 (the S5 meeting is before the window).
  assert.deepEqual([ada.leadsOwned, ada.slaRate, ada.meetingsBooked, ada.stage01Created], [4, 0.75, 2, 0]);
  // Dan owns L3, L4, L9, L10. Meetings: L9, L10, X2. Deals: L9 and L10.
  assert.deepEqual([dan.leadsOwned, dan.meetingsBooked, dan.stage01Created], [4, 3, 2]);
  // SQLs in the window with no sequence meeting: L8 only
  assert.equal(s.sqlsWithoutSequenceMeeting, 1);
});
