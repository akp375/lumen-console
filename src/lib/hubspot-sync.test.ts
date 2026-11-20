// HubSpot mapping rules used by the sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dealName,
  decimal,
  fictionalContact,
  FORECAST_TO_HUBSPOT_LABEL,
  isBackwardLifecycleMove,
  lifecycleLabel,
  pickTestAccount,
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
  hasOpenDeal: false,
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

test("Fictional contacts: same every run, reserved .example domain", () => {
  const a = fictionalContact({ accountId: "acc_0001", name: "Northwind Labs, Inc." });
  assert.deepEqual(a, fictionalContact({ accountId: "acc_0001", name: "Northwind Labs, Inc." }));
  assert.match(a.email, /^[a-z]+\.[a-z]+@northwind-labs-inc\.example$/);
  assert.ok(a.firstname && a.lastname && a.jobtitle);
});
