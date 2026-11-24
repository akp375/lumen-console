// Tests for syncing ADR leads to HubSpot as contacts: the CRM fields and flags (metrics.ts) and the
// mapping and matching rules (hubspot-sync.ts). No network. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcAdrHygiene, calcLeadCrmRows, type AdrInputs, type AdrLeadRow, type LeadCrmRow } from "./metrics.ts";
import { pickTestQualifyingDeal } from "./hubspot-sync-run.ts";
import type { CrmDealRow } from "./metrics.ts";
import { FORECAST_TO_HUBSPOT_LABEL, hubspotStageLabel, isoTime, leadContactProperties, leadFlagProperties, leadLifecycleStage, leadProperties, pickTestLead, planLeadContacts, splitName, type ExistingContact } from "./hubspot-sync.ts";

const AS_OF = "2026-11-13";

const lead = (id: string, over: Partial<AdrLeadRow>): AdrLeadRow => ({
  id, account_id: "A1", contact_name: `Pat ${id}`, contact_title: "Head of Ops", lead_source: "inbound demo request", lead_stage: "new",
  created_at: "2026-11-01T00:00:00Z", engaged_at: null, mql_at: null, first_touch_at: null, sales_accepted_at: null, sales_qualified_at: null,
  meeting_booked_at: null, converted_at: null, disqualified_at: null, nurtured_at: null, disqualify_reason: null, assigned_adr_id: null, opportunity_id: null, ...over,
});

// Ada (d1) covers Alpha (A1, owner Ann).
const INPUT: AdrInputs = {
  leads: [
    // L1: Ada's MQL, never touched, past the SLA
    lead("L1", { lead_stage: "mql", engaged_at: "2026-11-01T00:00:00Z", mql_at: "2026-11-10T00:00:00Z", assigned_adr_id: "d1" }),
    // L2: New, no ADR -> on the Unassigned card
    lead("L2", { lead_source: "content download" }),
    // L3: disqualified at the qualifying call after Sales accepted, no ADR -> ended, so not Unassigned
    lead("L3", { lead_stage: "disqualified", engaged_at: "2026-10-01T00:00:00Z", mql_at: "2026-10-02T00:00:00Z", first_touch_at: "2026-10-02T03:00:00Z", sales_accepted_at: "2026-10-02T03:00:00Z", disqualified_at: "2026-10-05T00:00:00Z", disqualify_reason: "No budget" }),
    // L4: nurtured after reaching MQL
    lead("L4", { lead_stage: "nurture", engaged_at: "2026-10-01T00:00:00Z", mql_at: "2026-10-02T00:00:00Z", first_touch_at: "2026-10-02T05:00:00Z", nurtured_at: "2026-10-20T00:00:00Z", assigned_adr_id: "d1" }),
    // L5: converted
    lead("L5", { lead_stage: "converted", engaged_at: "2026-09-01T00:00:00Z", mql_at: "2026-09-01T00:00:00Z", first_touch_at: "2026-09-01T02:00:00Z", sales_accepted_at: "2026-09-01T02:00:00Z", sales_qualified_at: "2026-09-03T00:00:00Z", meeting_booked_at: "2026-09-05T00:00:00Z", converted_at: "2026-09-10T00:00:00Z", assigned_adr_id: "d1", opportunity_id: "O1" }),
    // L6: created after the as-of date -> not synced yet
    lead("L6", { created_at: "2026-11-20T00:00:00Z" }),
  ],
  enrollments: [],
  sequences: [],
  deals: [],
  accounts: [{ id: "A1", name: "Alpha", status: "prospect", owner: "Ann", icp_tier: 1, target_account: true, territory: "T1" }],
  team: [
    { id: "a1", name: "Ann", role: "AE", territory: "T1" },
    { id: "d1", name: "Ada Lane", role: "ADR", territory: "T1" },
  ],
  pairings: [{ adr_id: "d1", ae_id: "a1", effective_from: "2026-10-01" }],
};
const EMAILS = new Map(INPUT.leads.map((l) => [l.id, `${l.id.toLowerCase()}@alpha.example.com`]));
const rows = calcLeadCrmRows(INPUT, AS_OF, EMAILS);
const row = (id: string) => rows.find((r) => r.leadId === id)!;

test("Lead CRM rows: leads created by the as-of date, with names, emails and ADR", () => {
  assert.deepEqual(rows.map((r) => r.leadId), ["L1", "L2", "L3", "L4", "L5"]);
  assert.equal(row("L1").adrName, "Ada Lane");
  assert.equal(row("L2").adrName, null);
  assert.equal(row("L1").email, "l1@alpha.example.com");
  assert.equal(row("L1").accountName, "Alpha");
});

test("Lead CRM rows: the two flags are exactly the hygiene cards", () => {
  const h = calcAdrHygiene(INPUT, AS_OF);
  const card = (key: string) => h.checks.find((c) => c.key === key)!.items.map((i) => i.recordId).sort();
  assert.deepEqual(rows.filter((r) => r.mqlPastSla).map((r) => r.leadId), card("slaBreach"));
  assert.deepEqual(rows.filter((r) => r.unassigned).map((r) => r.leadId), card("unassigned"));
  assert.deepEqual(rows.filter((r) => r.mqlPastSla).map((r) => r.leadId), ["L1"]);
  assert.deepEqual(rows.filter((r) => r.unassigned).map((r) => r.leadId), ["L2"]); // L3 has no ADR but has ended
});

test("Lifecycle stage: Lead, MQL, SQL, Opportunity; endings keep the furthest stage reached", () => {
  const lc = (leadStage: LeadCrmRow["leadStage"], furthestStage: LeadCrmRow["furthestStage"] = leadStage) => leadLifecycleStage({ leadStage, furthestStage });
  assert.equal(lc("new"), "lead");
  assert.equal(lc("engaged"), "lead");
  assert.equal(lc("mql"), "marketingqualifiedlead");
  assert.equal(lc("sales_accepted"), "marketingqualifiedlead");
  assert.equal(lc("sales_qualified"), "salesqualifiedlead");
  assert.equal(lc("meeting_booked"), "salesqualifiedlead");
  assert.equal(lc("converted"), "opportunity");
  assert.equal(row("L3").furthestStage, "sales_accepted");
  assert.equal(leadLifecycleStage(row("L3")), "marketingqualifiedlead");
  assert.equal(row("L4").furthestStage, "mql");
  assert.equal(leadLifecycleStage(row("L4")), "marketingqualifiedlead");
  assert.equal(leadLifecycleStage(row("L5")), "opportunity");
});

test("Contact properties: what one lead sends", () => {
  assert.deepEqual(leadContactProperties(row("L1")), {
    email: "l1@alpha.example.com",
    firstname: "Pat",
    lastname: "L1",
    jobtitle: "Head of Ops",
    company: "Alpha",
    lifecyclestage: "marketingqualifiedlead",
    lumen_lead_id: "L1",
    lumen_lead_stage: "mql",
    lumen_lead_source: "inbound demo request",
    lumen_adr_owner: "Ada Lane",
    lumen_mql_date: "2026-11-10T00:00:00.000Z",
    lumen_first_touch_date: "",
    lumen_disqualify_reason: "",
    lumen_mql_past_sla: "true",
    lumen_unassigned: "false",
  });
  assert.equal(leadProperties(row("L3")).lumen_disqualify_reason, "No budget");
  assert.equal(leadProperties(row("L3")).lumen_lead_stage, "disqualified");
  assert.deepEqual(leadFlagProperties(row("L2")), { lumen_adr_owner: "", lumen_mql_past_sla: "false", lumen_unassigned: "true" });
});

test("Names and times", () => {
  assert.deepEqual(splitName("Mary Ann  O'Neil"), { firstname: "Mary Ann", lastname: "O'Neil" });
  assert.deepEqual(splitName("Prince"), { firstname: "Prince", lastname: "" });
  assert.equal(isoTime("2026-11-10T00:00:00+00:00"), "2026-11-10T00:00:00.000Z");
  assert.equal(isoTime(null), "");
});

test("Matching: email first, then lumen_lead_id, else create; never a duplicate", () => {
  const c = (id: string, email: string, leadId: string | null, lifecyclestage: string | null = "lead"): ExistingContact => ({ id, email, leadId, lifecyclestage });
  const byEmail = new Map([
    ["l1@alpha.example.com", c("hs1", "l1@alpha.example.com", "L1")], // L1 synced before
    ["l2@alpha.example.com", c("hs2", "l2@alpha.example.com", null)], // a sponsor or prospect contact with L2's email
  ]);
  const byLeadId = new Map([
    ["L1", c("hs1", "l1@alpha.example.com", "L1")],
    ["L3", c("hs3", "old.l3@alpha.example.com", "L3")], // L3's email changed in Cockpit
  ]);
  const plans = planLeadContacts(rows, byEmail, byLeadId);
  const plan = (id: string) => plans.find((p) => p.leadId === id)!;

  assert.equal(plans.length, rows.length);
  // L1: found by email -> updated in place with everything
  assert.equal(plan("L1").kind, "upsert");
  assert.equal(plan("L1").existing?.id, "hs1");
  assert.equal(plan("L1").properties.firstname, "Pat");
  // L2: email belongs to another contact -> only the Lead fields (and lifecycle); its name and title are kept
  assert.equal(plan("L2").kind, "upsert");
  assert.equal(plan("L2").existing?.id, "hs2");
  assert.equal(plan("L2").properties.firstname, undefined);
  assert.equal(plan("L2").properties.jobtitle, undefined);
  assert.equal(plan("L2").properties.lumen_lead_id, "L2");
  // L3: not found by email, found by lumen_lead_id -> updated by its HubSpot id, with the new email
  const l3 = plan("L3");
  assert.equal(l3.kind, "update");
  if (l3.kind === "update") {
    assert.equal(l3.hubspotId, "hs3");
    assert.equal(l3.properties.email, "l3@alpha.example.com");
  }
  // L4, L5: new
  assert.equal(plan("L4").existing, null);
  assert.equal(plan("L5").existing, null);
  // Every contact is reached once: no two plans write the same email or HubSpot id.
  const targets = plans.map((p) => (p.kind === "update" ? `id:${p.hubspotId}` : `email:${p.email}`));
  assert.equal(new Set(targets).size, targets.length);
});

test("Matching: a re-run finds every lead by email and creates nothing", () => {
  const byEmail = new Map(rows.map((r, i) => [r.email, { id: `hs${i}`, email: r.email, leadId: r.leadId, lifecyclestage: leadLifecycleStage(r) }]));
  const plans = planLeadContacts(rows, byEmail, new Map());
  assert.ok(plans.every((p) => p.existing !== null));
});

test("Lead CRM rows: each lead carries the deal it became, for the deal -> contact link", () => {
  assert.equal(row("L5").opportunityId, "O1");
  assert.equal(row("L1").opportunityId, null);
});

test("Qualifying deals: Stage 0.1 goes to HubSpot's Qualifying stage, Not forecasted", () => {
  assert.equal(hubspotStageLabel("Stage 0.1"), "Qualifying");
  assert.equal(hubspotStageLabel("Discovery"), "Discovery");
  assert.equal(hubspotStageLabel("Closed Won"), "Closed Won");
  // Qualifying deals carry forecast category Omitted in Cockpit's data, which is HubSpot's "Not forecasted".
  assert.equal(FORECAST_TO_HUBSPOT_LABEL.Omitted, "Not forecasted");
});

test("Test Qualifying deal: the largest one", () => {
  const deal = (opportunityId: string, stage: string, amount: number) => ({ opportunityId, stage, amount }) as CrmDealRow;
  const picked = pickTestQualifyingDeal([deal("o1", "Stage 0.1", 24000), deal("o2", "Discovery", 900000), deal("o3", "Stage 0.1", 127200)]);
  assert.equal(picked?.opportunityId, "o3");
  assert.equal(pickTestQualifyingDeal([deal("o2", "Discovery", 1)]), undefined);
});

test("Test lead: the first MQL past the SLA that an ADR owns", () => {
  assert.equal(pickTestLead(rows)?.leadId, "L1");
});
