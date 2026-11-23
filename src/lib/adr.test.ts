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
  id, account_id: "A1", contact_name: `Contact ${id}`, contact_title: "Head of Operations", lead_source: "inbound demo request", lead_stage: "new",
  created_at: "2026-11-01T00:00:00Z", engaged_at: null, mql_at: null, first_touch_at: null, sales_accepted_at: null, sales_qualified_at: null,
  meeting_booked_at: null, converted_at: null, disqualified_at: null, nurtured_at: null, disqualify_reason: null,
  assigned_adr_id: null, opportunity_id: null, ...over,
});
// Every lead that reached MQL was Engaged at creation (keeps the hand counts simple).
const mqlLead = (id: string, over: Partial<AdrLeadRow>) => lead(id, { lead_stage: "mql", engaged_at: over.created_at ?? "2026-11-01T00:00:00Z", ...over });

const LEADS: AdrLeadRow[] = [
  // L1: touched exactly 24h after becoming an MQL -> on time; Sales accepted at the touch
  mqlLead("L1", { lead_stage: "sales_accepted", mql_at: "2026-11-10T00:00:00Z", first_touch_at: "2026-11-11T00:00:00Z", sales_accepted_at: "2026-11-11T00:00:00Z", assigned_adr_id: "d1" }),
  // L2: touched 24h + 1 minute after -> late (24.0167 hours)
  mqlLead("L2", { lead_stage: "sales_accepted", mql_at: "2026-11-10T00:00:00Z", first_touch_at: "2026-11-11T00:01:00Z", sales_accepted_at: "2026-11-11T00:01:00Z", assigned_adr_id: "d1" }),
  // L3: still at MQL, never touched, deadline 2026-11-13T23:00 has passed -> open breach, 0 days old
  mqlLead("L3", { account_id: "A2", lead_source: "webinar", mql_at: "2026-11-12T23:00:00Z", assigned_adr_id: "d2" }),
  // L4: still at MQL, never touched, but its 24 hours aren't up yet (deadline 2026-11-14T01:00) -> not a breach, not in any rate
  mqlLead("L4", { account_id: "A2", lead_source: "webinar", mql_at: "2026-11-13T01:00:00Z", assigned_adr_id: "d2" }),
  // L5: New, no ADR, created 2026-11-03 -> unassigned, 10 days; A1's owner Ann is paired with d1
  lead("L5", { lead_source: "content download", created_at: "2026-11-03T00:00:00Z" }),
  // L6: disqualified with no ADR -> not unassigned
  lead("L6", { account_id: "A2", lead_source: "content download", lead_stage: "disqualified", disqualified_at: "2026-11-02T00:00:00Z", disqualify_reason: "Not ICP" }),
  // L7: Sales qualified 2026-11-10T12:00, no meeting booked, past the 3-day grace -> handoff leak, 3 days old. Touched in 2h.
  mqlLead("L7", { lead_stage: "sales_qualified", mql_at: "2026-11-08T00:00:00Z", first_touch_at: "2026-11-08T02:00:00Z", sales_accepted_at: "2026-11-08T02:00:00Z", sales_qualified_at: "2026-11-10T12:00:00Z", assigned_adr_id: "d1" }),
  // L8: Sales qualified 2026-11-11T12:00, inside the grace period -> not a leak. Touched in 4h.
  mqlLead("L8", { lead_stage: "sales_qualified", mql_at: "2026-11-09T00:00:00Z", first_touch_at: "2026-11-09T04:00:00Z", sales_accepted_at: "2026-11-09T04:00:00Z", sales_qualified_at: "2026-11-11T12:00:00Z", assigned_adr_id: "d1" }),
  // L9: outbound, Meeting booked with deal O1 (still Qualifying). Touched in 5h.
  mqlLead("L9", { account_id: "A2", lead_source: "outbound", lead_stage: "meeting_booked", created_at: "2026-09-01T00:00:00Z", mql_at: "2026-09-02T00:00:00Z", first_touch_at: "2026-09-02T05:00:00Z", sales_accepted_at: "2026-09-02T05:00:00Z", sales_qualified_at: "2026-09-08T00:00:00Z", meeting_booked_at: "2026-09-10T00:00:00Z", assigned_adr_id: "d2", opportunity_id: "O1" }),
  // L10: outbound, Converted: deal O2 is now Discovery. Touched in 10h.
  mqlLead("L10", { account_id: "A2", lead_source: "outbound", lead_stage: "converted", created_at: "2026-08-01T00:00:00Z", mql_at: "2026-08-02T00:00:00Z", first_touch_at: "2026-08-02T10:00:00Z", sales_accepted_at: "2026-08-02T10:00:00Z", sales_qualified_at: "2026-08-04T00:00:00Z", meeting_booked_at: "2026-08-05T00:00:00Z", converted_at: "2026-08-05T00:00:00Z", assigned_adr_id: "d2", opportunity_id: "O2" }),
  // L11: created before the 6-month window -> left out of the funnel
  lead("L11", { lead_source: "outbound", created_at: "2026-05-01T00:00:00Z", assigned_adr_id: "d1" }),
];

const enr = (id: string, seq: string, over: Partial<AdrEnrollmentRow> = {}): AdrEnrollmentRow => ({
  id, sequence_id: seq, lead_id: `X${id}`, adr_id: null, enrolled_at: "2026-10-01T00:00:00Z", emails_sent: 1, opens: 0, clicks: 0, replies: 0, bounces: 0, meeting_booked: false, meeting_booked_at: null, ...over,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const meeting = (lead_id: string, adr_id: string) => ({ lead_id, adr_id, meeting_booked: true, meeting_booked_at: "2026-10-05T00:00:00Z" });

const ENROLLMENTS: AdrEnrollmentRow[] = [
  // S1: 20 enrollments, 2 emails each = 40 emails; 10 opened, 2 clicked, 6 replies, 1 bounce; 5 calls booked
  // (L7 and X1 for d1; L9, L10 and X2 for d2)
  ...range(20).map((i) =>
    enr(`s1_${i}`, "S1", {
      emails_sent: 2,
      opens: i < 10 ? 1 : 0,
      clicks: i < 2 ? 1 : 0,
      replies: i < 6 ? 1 : 0,
      bounces: i === 19 ? 1 : 0,
      ...(i === 0 ? meeting("L7", "d1") : i === 1 ? meeting("X1", "d1") : i === 2 ? meeting("L9", "d2") : i === 3 ? meeting("L10", "d2") : i === 4 ? meeting("X2", "d2") : {}),
    }),
  ),
  // S2: 20 enrollments of 1 email, no calls, 4 bounced (20% of emails: above the 10% alert)
  ...range(20).map((i) => enr(`s2_${i}`, "S2", { bounces: i < 4 ? 1 : 0 })),
  // S3: 20 enrollments of 1 email, no calls, 2 bounced (exactly 10% of emails: not an alert)
  ...range(20).map((i) => enr(`s3_${i}`, "S3", { bounces: i < 2 ? 1 : 0 })),
  // S4: 19 enrollments, 10 meetings: the best rate, but too few enrollments to be ranked
  ...range(19).map((i) => enr(`s4_${i}`, "S4", i < 10 ? { meeting_booked: true, meeting_booked_at: "2026-10-02T00:00:00Z" } : {})),
  // S5: one enrollment before the window, with a meeting for d1 -> counted nowhere
  enr("s5_0", "S5", { enrolled_at: "2026-04-01T00:00:00Z", meeting_booked: true, meeting_booked_at: "2026-04-02T00:00:00Z", adr_id: "d1" }),
  // S6 (not in the sequence table): L5 (open, no ADR) enrolled 2026-11-04 -> in a sequence with no owner, 9 days.
  // L6 (Disqualified, no ADR) is enrolled too, but has ended -> not counted.
  enr("s6_L5", "S6", { lead_id: "L5", enrolled_at: "2026-11-04T00:00:00Z" }),
  enr("s6_L6", "S6", { lead_id: "L6", enrolled_at: "2026-11-02T00:00:00Z" }),
];

const INPUT: AdrInputs = {
  leads: LEADS,
  enrollments: ENROLLMENTS,
  sequences: ["S1", "S2", "S3", "S4", "S5"].map((id) => ({ id, name: `Sequence ${id}`, owner_id: "d1" })),
  deals: [
    // O1: Stage 0.1, last update 2026-10-30 = 14 days ago -> stale. Bob (a2) with his paired ADR d2, so no mismatch.
    { type: "new", amount_usd: 24000, id: "O1", account_id: "A2", stage: "Stage 0.1", created_date: "2026-10-20", last_activity_date: "2026-10-30", ae_id: "a2", adr_id: "d2" },
    // O3: Stage 0.1, 13 days since update -> not stale; ADR d2 with AE a1 (paired with d1), created after 1 Oct -> mismatch, 19 days
    { type: "new", amount_usd: 24000, id: "O3", account_id: "A1", stage: "Stage 0.1", created_date: "2026-10-25", last_activity_date: "2026-10-31", ae_id: "a1", adr_id: "d2" },
    // O2: Discovery, d1 with a2, but created before the pairing date -> not judged
    { type: "new", amount_usd: 24000, id: "O2", account_id: "A2", stage: "Discovery", created_date: "2026-08-10", last_activity_date: "2026-11-01", ae_id: "a2", adr_id: "d1" },
    // O4: closed -> not judged
    { type: "new", amount_usd: 24000, id: "O4", account_id: "A1", stage: "Closed Lost", created_date: "2026-10-05", last_activity_date: "2026-10-20", ae_id: "a1", adr_id: "d2" },
    // O5: Demo created on the pairing date itself -> mismatch, 43 days
    { type: "new", amount_usd: 24000, id: "O5", account_id: "A1", stage: "Demo", created_date: "2026-10-01", last_activity_date: "2026-11-10", ae_id: "a1", adr_id: "d2" },
    // O6: created the day before the pairing date -> not judged
    { type: "new", amount_usd: 24000, id: "O6", account_id: "A1", stage: "Demo", created_date: "2026-09-30", last_activity_date: "2026-11-10", ae_id: "a1", adr_id: "d2" },
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
  assert.deepEqual(counts(h), { unassigned: 1, slaBreach: 1, staleStage01: 1, handoffLeak: 1, pairingMismatch: 2, sequenceNoOwner: 1, accountTags: 4 });
  // The sequence-with-no-owner card repeats unassigned leads, so it isn't added to the total
  assert.equal(h.total, 10);
  assert.equal(h.checks.find((c) => c.key === "sequenceNoOwner")!.inTotal, false);
  const noOwner = h.checks.find((c) => c.key === "sequenceNoOwner")!.items[0];
  assert.deepEqual([noOwner.recordId, noOwner.ageDays, noOwner.ownerAdrId, noOwner.adrId], ["L5", 9, null, "d1"]);
  // ownerAdrId is the ADR who owns it, never the territory ADR
  assert.equal(h.checks.find((c) => c.key === "unassigned")!.items[0].ownerAdrId, null);
  assert.equal(h.checks.find((c) => c.key === "handoffLeak")!.items[0].ownerAdrId, "d1");
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
  // The first column: the contact (with job title) for lead checks, the deal (with its ID) for deal checks, none for account tags
  assert.deepEqual(h.checks.map((c) => [c.key, c.recordColumn]), [
    ["unassigned", "Contact"], ["slaBreach", "Contact"], ["staleStage01", "Deal"], ["handoffLeak", "Contact"], ["pairingMismatch", "Deal"], ["sequenceNoOwner", "Contact"], ["accountTags", null],
  ]);
  assert.deepEqual([items("unassigned")[0].record, items("unassigned")[0].recordDetail], ["Contact L5", "Head of Operations"]);
  assert.deepEqual([items("staleStage01")[0].record, items("staleStage01")[0].recordDetail], ["New business, $24,000", "O1"]);
  assert.equal(items("accountTags")[0].recordDetail, null);
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
  assert.deepEqual(counts(d1), { unassigned: 1, slaBreach: 0, staleStage01: 0, handoffLeak: 1, pairingMismatch: 0, sequenceNoOwner: 1, accountTags: 2 });
  assert.deepEqual(counts(d2), { unassigned: 0, slaBreach: 1, staleStage01: 1, handoffLeak: 0, pairingMismatch: 2, sequenceNoOwner: 0, accountTags: 2 });
  assert.equal(d1.total + d2.total, 10);
  assert.deepEqual(d1.slaBreachRate30d, { breached: 1, eligible: 4, rate: 0.25 }); // L1, L2, L7, L8; L2 late
});

test("ADR insights: funnel by source, every stage with conversion from the stage before", () => {
  const f = calcAdrInsights(INPUT, AS_OF).funnel;
  const row = (src: string) => f.find((x) => x.source === src)!;
  // Columns: New, Engaged, MQL, Sales accepted, Sales qualified, Meeting booked, Converted
  // Outbound: L9 (Meeting booked, deal O1) and L10 (Converted). L11 is before the window.
  assert.deepEqual(row("outbound").reached, [2, 2, 2, 2, 2, 2, 1]);
  assert.deepEqual(row("outbound").stepRates, [null, 1, 1, 1, 1, 1, 0.5]);
  assert.equal(row("outbound").overall, 0.5);
  assert.deepEqual([row("outbound").disqualified, row("outbound").nurture, row("outbound").open], [0, 0, 1]);
  // Demo requests: L1, L2 (Sales accepted), L7, L8 (Sales qualified)
  assert.deepEqual(row("inbound demo request").reached, [4, 4, 4, 4, 2, 0, 0]);
  assert.equal(row("inbound demo request").stepRates[5], 0); // Sales qualified -> Meeting booked: 0 of 2
  assert.equal(row("inbound demo request").stepRates[6], null); // nothing at Meeting booked: no rate, not 0%
  // Content downloads: L5 (New) and L6 (Disqualified)
  assert.deepEqual(row("content download").reached, [2, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([row("content download").disqualified, row("content download").open], [1, 1]);
  assert.equal(f[0].source, "outbound"); // best New -> Converted first
  const all = f[f.length - 1];
  assert.equal(all.source, "All sources");
  assert.deepEqual(all.reached, [10, 8, 8, 6, 4, 2, 1]);
  assert.deepEqual([all.disqualified, all.nurture, all.open], [1, 0, 8]);
  assert.equal(all.overall, 0.1);
});

test("ADR insights: unassigned MQLs are their own row, outside the team rate", () => {
  // Add an unassigned MQL, never touched, whose 24 hours are up
  const extra = lead("L12", { lead_stage: "mql", engaged_at: "2026-11-01T00:00:00Z", mql_at: "2026-11-05T00:00:00Z" });
  const s = calcAdrInsights({ ...INPUT, leads: [...LEADS, extra] }, AS_OF);
  const un = s.speed.find((x) => x.adrId === null)!;
  assert.deepEqual([un.name, un.mqls, un.never], ["Unassigned", 1, 1]);
  // The team is unchanged: 7 assigned MQLs, 5 on time
  assert.deepEqual([s.team.name, s.team.mqls, s.team.onTime, s.team.never], ["Team (assigned ADRs)", 7, 5, 1]);
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

test("ADR insights: sequence rates per email sent, call booked per enrollment, best and worst, bounce alert, Used by", () => {
  const seq = calcAdrInsights(INPUT, AS_OF).sequences;
  const by = (id: string) => seq.find((x) => x.id === id)!;
  const s1 = by("S1");
  // Per email (40 sent): open 10/40, click-through 2/40, reply 6/40, bounce 1/40. Call booked per enrollment: 5/20.
  assert.deepEqual([s1.enrollments, s1.emailsSent, s1.openRate, s1.clickRate, s1.replyRate, s1.bounceRate], [20, 40, 0.25, 0.05, 0.15, 0.025]);
  assert.deepEqual([s1.callsBooked, s1.callBookedRate], [5, 0.25]);
  assert.deepEqual(s1.usedBy, ["Dan", "Ada"]); // Dan enrolled 3, Ada 2 (most first)
  assert.equal(s1.unassignedEnrollments, 15);
  assert.equal(s1.rank, "best");
  // S2 and S3 tie at 0% calls booked; S2 bounces more, so it is the worst
  assert.equal(by("S2").rank, "worst");
  assert.equal(by("S3").rank, null);
  assert.equal(by("S4").rank, null); // 19 enrollments: too few to rank, even with the best rate
  assert.equal(by("S2").bounceAlert, true); // 20% of emails
  assert.equal(by("S3").bounceAlert, false); // exactly 10% of emails
  assert.deepEqual(by("S3").usedBy, []); // no ADR enrolled anyone
  assert.equal(by("S5").enrollments, 0); // its one enrollment is before the window
  assert.equal(by("S5").callBookedRate, null);
  assert.equal(by("S5").openRate, null); // no emails sent: no rate, not 0%
});

test("ADR insights: per-ADR table counts stages reached and Meeting booked from the lead", () => {
  const s = calcAdrInsights(INPUT, AS_OF);
  const ada = s.scorecard.find((x) => x.adrId === "d1")!;
  const dan = s.scorecard.find((x) => x.adrId === "d2")!;
  // Ada owns L1, L2, L7, L8 (L11 is before the window): all Sales accepted, L7 and L8 Sales qualified, no meetings.
  // Her sequence meetings (L7, X1 in S1) don't count: Meetings booked comes from the lead's Meeting booked stage.
  assert.deepEqual(
    [ada.leadsOwned, ada.slaRate, ada.salesAccepted, ada.salesQualified, ada.meetingsBooked, ada.qualifyingDealsCreated, ada.converted],
    [4, 0.75, 4, 2, 0, 0, 0],
  );
  // Dan owns L3, L4, L9, L10. L9 and L10 reached Meeting booked with deals; L10 converted.
  assert.deepEqual([dan.leadsOwned, dan.salesAccepted, dan.salesQualified, dan.meetingsBooked, dan.qualifyingDealsCreated, dan.converted], [4, 2, 2, 2, 2, 1]);
});
