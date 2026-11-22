// HubSpot mapping rules used by the sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkbox,
  dealName,
  decimal,
  fictionalContact,
  FORECAST_TO_HUBSPOT_LABEL,
  isBackwardLifecycleMove,
  lifecycleLabel,
  multiSelect,
  pickTestAccount,
  reasonsText,
  sponsorContact,
  sponsorRoleLabel,
} from "./hubspot-sync.ts";
import type { CrmAccountRow } from "./metrics.ts";

const account = (a: Partial<CrmAccountRow> & Pick<CrmAccountRow, "accountId" | "status">): CrmAccountRow => ({
  name: a.accountId,
  segment: "SMB",
  arr: null,
  renewalDate: null,
  grossMargin: null,
  capacityUsed: null,
  latestNps: null,
  npsChange: null,
  renewalRisk: null,
  renewalRiskReasons: null,
  healthScore: null,
  healthDeclining: null,
  downsellArr: null,
  missingRenewalDeal: null,
  sponsorStatus: null,
  hasOpenDeal: false,
  ae: null,
  csm: null,
  productsOwned: null,
  productArr: null,
  sponsor: null,
  ...a,
});

test("Lifecycle: customer, prospect with/without open deal, churned", () => {
  assert.equal(lifecycleLabel({ status: "customer", hasOpenDeal: false }), "Customer");
  assert.equal(lifecycleLabel({ status: "prospect", hasOpenDeal: true }), "Opportunity");
  assert.equal(lifecycleLabel({ status: "prospect", hasOpenDeal: false }), "Lead");
  assert.equal(lifecycleLabel({ status: "churned", hasOpenDeal: true }), "Other");
});

test("Lifecycle: backward moves need clearing first", () => {
  assert.equal(isBackwardLifecycleMove("opportunity", "lead"), true);
  assert.equal(isBackwardLifecycleMove("customer", "other"), false); // Other sits after Customer
  assert.equal(isBackwardLifecycleMove(null, "lead"), false);
  assert.equal(isBackwardLifecycleMove("lead", "lead"), false);
});

test("Forecast categories: every one of ours has a HubSpot label", () => {
  for (const ours of ["Pipeline", "Best Case", "Commit", "Closed", "Omitted"]) assert.ok(FORECAST_TO_HUBSPOT_LABEL[ours], ours);
  assert.equal(FORECAST_TO_HUBSPOT_LABEL.Omitted, "Not forecasted");
});

test("Percents go as decimals, rounded to 4 places; empty when unknown", () => {
  assert.equal(decimal(0.42), "0.42");
  assert.equal(decimal(0.123456), "0.1235");
  assert.equal(decimal(null), "");
});

test("Deal name", () => {
  assert.equal(dealName({ accountName: "Acme", type: "renewal" }), "Acme – Renewal");
  assert.equal(dealName({ accountName: "Acme", type: "new" }), "Acme – New business");
});

test("--one picks the largest-ARR customer with an open deal and margin and capacity figures", () => {
  const picked = pickTestAccount({
    accounts: [
      account({ accountId: "big-no-deal", status: "customer", arr: 900, grossMargin: 0.5, capacityUsed: 0.5 }),
      account({ accountId: "mid", status: "customer", arr: 500, grossMargin: 0.5, capacityUsed: 0.5, hasOpenDeal: true }),
      account({ accountId: "small", status: "customer", arr: 100, grossMargin: 0.5, capacityUsed: 0.5, hasOpenDeal: true }),
      account({ accountId: "no-margin", status: "customer", arr: 800, capacityUsed: 0.5, hasOpenDeal: true }),
      account({ accountId: "prospect", status: "prospect", hasOpenDeal: true }),
    ],
    deals: [],
  });
  assert.equal(picked?.accountId, "mid");
});

test("Fictional contacts: same every run, reserved example.com subdomain", () => {
  const a = fictionalContact({ accountId: "acc_0001", name: "Northwind Labs, Inc." });
  assert.deepEqual(a, fictionalContact({ accountId: "acc_0001", name: "Northwind Labs, Inc." }));
  assert.match(a.email, /^[a-z]+\.[a-z]+@northwind-labs-inc\.example\.com$/);
  assert.ok(a.firstname && a.lastname && a.jobtitle);
});

test("Fictional contacts: names vary across accounts", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `acc_${String(i + 1).padStart(4, "0")}`);
  const people = ids.map((accountId) => fictionalContact({ accountId, name: accountId }));
  assert.ok(new Set(people.map((p) => p.lastname)).size >= 10, "at least 10 different last names in 30");
  assert.ok(new Set(people.map((p) => `${p.firstname} ${p.lastname}`)).size >= 25, "mostly unique full names");
});

test("Checkbox and reasons: HubSpot text values, blank when the value doesn't apply", () => {
  assert.deepEqual([checkbox(true), checkbox(false), checkbox(null)], ["true", "false", ""]);
  assert.equal(reasonsText(["Health below 50", "Downsell risk"]), "Health below 50; Downsell risk");
  assert.equal(reasonsText([]), ""); // Low: no reasons
  assert.equal(reasonsText(null), ""); // not a customer
});

test("Products owned: option values joined by semicolons", () => {
  assert.equal(multiSelect(["Core", "Code Review"]), "core;code review");
  assert.equal(multiSelect([]), ""); // customer with no active lines
  assert.equal(multiSelect(null), ""); // not a customer
});

test("Sponsor contact: name split, made-up email at <company>.example.com, role by status", () => {
  assert.deepEqual(sponsorContact({ name: "Ionic Retail" }, { name: "Priyanka Lindqvist", title: "Chief Data Officer" }), {
    firstname: "Priyanka",
    lastname: "Lindqvist",
    jobtitle: "Chief Data Officer",
    email: "priyanka.lindqvist@ionic-retail.example.com",
  });
  // Apostrophes and extra spaces never reach the email; a missing title is blank
  assert.equal(sponsorContact({ name: "O'Brien & Co" }, { name: "  Liam  O'Connor ", title: null }).email, "liam.o-connor@o-brien-co.example.com");
  assert.equal(sponsorContact({ name: "Acme" }, { name: "Cher", title: null }).email, "cher@acme.example.com");
  assert.deepEqual([sponsorRoleLabel("active"), sponsorRoleLabel("left")], ["Executive sponsor", "Former sponsor"]);
});
