// Syncs Supabase -> HubSpot: companies, deals (with their company), and one made-up contact per prospect.
// All numbers come from metrics.ts (getCrmSyncData); mapping rules live in src/lib/hubspot-sync.ts.
// Records are matched on lumen_account_id / lumen_opportunity_id / email, so re-runs update instead of duplicating.
// Never deletes anything in HubSpot.
//
// Run with: npm run hubspot:sync                  (everything)
//           npm run hubspot:sync -- --one         (one customer and its deals only)
//           npm run hubspot:sync -- --dry-run     (build everything, send nothing; add --one to preview the single account)

import { getCrmSyncData, type CrmAccountRow, type CrmDealRow } from "../src/lib/metrics.ts";
import { hubspot } from "../src/lib/hubspot.ts";
import {
  DEAL_TYPE_TO_HUBSPOT_LABEL,
  dealName,
  decimal,
  fictionalContact,
  FORECAST_TO_HUBSPOT_LABEL,
  isBackwardLifecycleMove,
  lifecycleLabel,
  optionValue,
  pickTestAccount,
} from "../src/lib/hubspot-sync.ts";
import { readFileSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");
const ONE = process.argv.includes("--one");
const BATCH = 100; // HubSpot batch endpoints take up to 100 records per call

type Props = Record<string, string>;
type Input = { idProperty: string; id: string; properties: Props };
type BatchResult = { results: { id: string; properties: Props; new?: boolean }[]; errors?: { message: string; context?: unknown }[]; numErrors?: number };
type HsOption = { label: string; value: string };
type HsPipeline = { id: string; label: string; stages: { id: string; label: string }[] };

const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / BATCH) }, (_, i) => xs.slice(i * BATCH, (i + 1) * BATCH));
const str = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function fail(msg: string): never {
  throw new Error(msg);
}

function checkBatch(what: string, r: BatchResult) {
  if (r.numErrors || r.errors?.length) {
    const first = r.errors?.slice(0, 3).map((e) => e.message).join(" | ");
    fail(`${what}: HubSpot reported ${r.numErrors ?? r.errors?.length} error(s): ${first}`);
  }
}

/** Option label -> value for a HubSpot dropdown, read from HubSpot itself. */
async function optionsOf(object: string, property: string): Promise<Map<string, string>> {
  const p = await hubspot<{ options: HsOption[] }>("GET", `/crm/v3/properties/${object}/${property}`);
  return new Map(p.options.map((o) => [o.label, o.value]));
}

function valueFor(options: Map<string, string>, label: string, what: string): string {
  return options.get(label) ?? fail(`${what}: HubSpot has no option labelled "${label}". Options are: ${[...options.keys()].join(", ")}. Stopping.`);
}

/** Checks a value we send to one of our own dropdowns exists in HubSpot. */
function ownOption(options: Map<string, string>, label: string, what: string): string {
  const v = optionValue(label);
  if (![...options.values()].includes(v)) fail(`${what}: HubSpot has no option "${v}". Run npm run hubspot:setup. Stopping.`);
  return v;
}

async function upsert(object: string, inputs: Input[]): Promise<Map<string, { id: string; isNew: boolean }>> {
  const ids = new Map<string, { id: string; isNew: boolean }>();
  for (const part of chunks(inputs)) {
    const r = await hubspot<BatchResult>("POST", `/crm/v3/objects/${object}/batch/upsert`, { inputs: part });
    checkBatch(`${object} upsert`, r);
    for (const res of r.results) {
      const key = res.properties[part[0].idProperty];
      if (key) ids.set(key, { id: res.id, isNew: Boolean(res.new) });
    }
  }
  const missing = inputs.filter((i) => !ids.has(i.id));
  if (missing.length) fail(`${object} upsert: no HubSpot id came back for ${missing.length} record(s), e.g. ${missing[0].id}.`);
  return ids;
}

async function associate(from: string, to: string, pairs: { from: string; to: string }[]) {
  for (const part of chunks(pairs)) {
    const r = await hubspot<BatchResult>("POST", `/crm/v4/associations/${from}/${to}/batch/associate/default`, {
      inputs: part.map((p) => ({ from: { id: p.from }, to: { id: p.to } })),
    });
    checkBatch(`${from} → ${to} associations`, r);
  }
}

try {
  if (DRY_RUN) console.log("Dry run: reading only; nothing will be sent to HubSpot.\n");

  // 1. Our data (all numbers from metrics.ts)
  const all = await getCrmSyncData();
  let accounts: CrmAccountRow[] = all.accounts;
  let deals: CrmDealRow[] = all.deals;
  if (ONE) {
    const pick = pickTestAccount(all) ?? fail("No customer has an open deal plus margin and capacity figures.");
    accounts = [pick];
    deals = all.deals.filter((d) => d.accountId === pick.accountId);
    console.log(`--one: ${pick.name} (${pick.accountId}), ${deals.length} deal(s)\n`);
  }
  const prospects = ONE ? [] : accounts.filter((a) => a.status === "prospect");

  // 2. Read HubSpot's setup: pipelines, stages and dropdown options. Stop on anything missing.
  const pipeSpec = JSON.parse(readFileSync(new URL("../hubspot/pipelines.json", import.meta.url), "utf8")) as {
    pipelines: { label: string; dealTypes: string[] }[];
  };
  const hsPipelines = (await hubspot<{ results: HsPipeline[] }>("GET", "/crm/v3/pipelines/deals")).results;
  const pipelineFor = new Map<string, HsPipeline>();
  for (const p of pipeSpec.pipelines) {
    const found = hsPipelines.find((h) => h.label.trim().toLowerCase() === p.label.toLowerCase()) ?? fail(`Pipeline "${p.label}" not found. Run npm run hubspot:setup.`);
    for (const t of p.dealTypes) pipelineFor.set(t, found);
  }

  const [forecastOpts, dealTypeOpts, lifecycleOpts, segmentOpts, statusOpts, renewalRiskOpts, dealRiskOpts] = await Promise.all([
    optionsOf("deals", "hs_manual_forecast_category"),
    optionsOf("deals", "dealtype"),
    optionsOf("companies", "lifecyclestage"),
    optionsOf("companies", "lumen_segment"),
    optionsOf("companies", "lumen_account_status"),
    optionsOf("companies", "lumen_renewal_risk"),
    optionsOf("deals", "lumen_deal_risk"),
  ]);

  console.log("Forecast category mapping (ours → HubSpot label → HubSpot value):");
  for (const [ours, label] of Object.entries(FORECAST_TO_HUBSPOT_LABEL)) console.log(`  ${ours.padEnd(10)} → ${label.padEnd(15)} → ${valueFor(forecastOpts, label, "Forecast category")}`);
  console.log();

  // 3. Companies
  const segmentLabel: Record<string, string> = { enterprise: "Enterprise", "mid-market": "Mid-market", SMB: "SMB" };
  const companyInputs: Input[] = accounts.map((a) => ({
    idProperty: "lumen_account_id",
    id: a.accountId,
    properties: {
      name: a.name,
      lumen_account_id: a.accountId,
      lumen_account_status: ownOption(statusOpts, a.status === "customer" ? "Customer" : a.status === "prospect" ? "Prospect" : "Churned", "Account status"),
      lumen_segment: ownOption(segmentOpts, segmentLabel[a.segment] ?? fail(`Unknown segment "${a.segment}"`), "Segment"),
      lifecyclestage: valueFor(lifecycleOpts, lifecycleLabel(a), "Lifecycle stage"),
      lumen_arr: str(a.arr),
      lumen_renewal_date: str(a.renewalDate),
      lumen_gross_margin: decimal(a.grossMargin),
      lumen_capacity_used: decimal(a.capacityUsed),
      lumen_latest_nps: str(a.latestNps),
      lumen_nps_change: str(a.npsChange),
      lumen_renewal_risk: a.renewalRisk ? ownOption(renewalRiskOpts, a.renewalRisk, "Renewal risk") : "",
    },
  }));

  // 4. Deals
  const dealInputs: Input[] = deals.map((d) => {
    const pipeline = pipelineFor.get(d.type) ?? fail(`No pipeline for deal type "${d.type}"`);
    const stage = pipeline.stages.find((s) => s.label.trim().toLowerCase() === d.stage.toLowerCase()) ?? fail(`Pipeline "${pipeline.label}" has no "${d.stage}" stage.`);
    return {
      idProperty: "lumen_opportunity_id",
      id: d.opportunityId,
      properties: {
        dealname: dealName(d),
        lumen_opportunity_id: d.opportunityId,
        pipeline: pipeline.id,
        dealstage: stage.id,
        amount: String(d.amount),
        closedate: `${d.closeDate}T00:00:00.000Z`,
        hs_manual_forecast_category: valueFor(forecastOpts, FORECAST_TO_HUBSPOT_LABEL[d.forecastCategory] ?? fail(`No mapping for forecast category "${d.forecastCategory}"`), "Forecast category"),
        dealtype: valueFor(dealTypeOpts, DEAL_TYPE_TO_HUBSPOT_LABEL[d.type] ?? fail(`No mapping for deal type "${d.type}"`), "Deal type"),
        lumen_executive_sponsor: str(d.executiveSponsor),
        lumen_days_in_stage: str(d.daysInStage),
        lumen_deal_risk: d.dealRisk ? ownOption(dealRiskOpts, d.dealRisk, "Deal risk") : "",
      },
    };
  });

  // 5. Contacts: one made-up contact per prospect
  const contactFor = new Map(prospects.map((a) => [a.accountId, fictionalContact(a)]));
  const contactInputs: Input[] = prospects.map((a) => {
    const c = contactFor.get(a.accountId)!;
    return { idProperty: "email", id: c.email, properties: { email: c.email, firstname: c.firstname, lastname: c.lastname, jobtitle: c.jobtitle, company: a.name } };
  });

  console.log(`To sync: ${companyInputs.length} companies, ${dealInputs.length} deals, ${contactInputs.length} contacts.`);
  if (DRY_RUN) {
    console.log("\nSample company:", JSON.stringify(companyInputs[0]?.properties, null, 2));
    console.log("\nSample deal:", JSON.stringify(dealInputs[0]?.properties, null, 2));
    if (contactInputs[0]) console.log("\nSample contact:", JSON.stringify(contactInputs[0].properties, null, 2));
    const pipeCount = new Map<string, number>();
    for (const d of dealInputs) {
      const label = hsPipelines.find((p) => p.id === d.properties.pipeline)!.label;
      pipeCount.set(label, (pipeCount.get(label) ?? 0) + 1);
    }
    console.log(`\nDeals per pipeline: ${[...pipeCount].map(([k, v]) => `${k} ${v}`).join(", ")}`);
    console.log("\nDry run finished. Nothing was sent.");
    process.exit(0);
  }

  // 6. Lifecycle stages can't move backwards in HubSpot: clear those first.
  const existing = new Map<string, { id: string; lifecyclestage?: string }>();
  for (const part of chunks(companyInputs)) {
    const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/companies/batch/read", {
      idProperty: "lumen_account_id",
      properties: ["lifecyclestage", "lumen_account_id"],
      inputs: part.map((i) => ({ id: i.id })),
    });
    for (const res of r.results) existing.set(res.properties.lumen_account_id, { id: res.id, lifecyclestage: res.properties.lifecyclestage });
  }
  const toClear = companyInputs.filter((i) => isBackwardLifecycleMove(existing.get(i.id)?.lifecyclestage, i.properties.lifecyclestage));
  for (const part of chunks(toClear)) {
    const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/companies/batch/update", {
      inputs: part.map((i) => ({ id: existing.get(i.id)!.id, properties: { lifecyclestage: "" } })),
    });
    checkBatch("lifecycle clear", r);
  }
  if (toClear.length) console.log(`Cleared lifecycle stage on ${toClear.length} compan${toClear.length === 1 ? "y" : "ies"} moving backwards.`);

  // 7. Write: companies, deals, deal → company, contacts, contact → company
  const companyIds = await upsert("companies", companyInputs);
  const countNew = (m: Map<string, { isNew: boolean }>) => [...m.values()].filter((v) => v.isNew).length;
  console.log(`Companies: ${companyIds.size} synced (${countNew(companyIds)} new, ${companyIds.size - countNew(companyIds)} updated).`);

  const dealIds = await upsert("deals", dealInputs);
  console.log(`Deals: ${dealIds.size} synced (${countNew(dealIds)} new, ${dealIds.size - countNew(dealIds)} updated).`);
  await associate(
    "deals",
    "companies",
    deals.map((d) => ({ from: dealIds.get(d.opportunityId)!.id, to: companyIds.get(d.accountId)?.id ?? fail(`Company ${d.accountId} for deal ${d.opportunityId} was not synced.`) })),
  );
  console.log(`Deals attached to their companies: ${deals.length}.`);

  if (contactInputs.length) {
    const contactIds = await upsert("contacts", contactInputs);
    console.log(`Contacts: ${contactIds.size} synced (${countNew(contactIds)} new, ${contactIds.size - countNew(contactIds)} updated).`);
    await associate(
      "contacts",
      "companies",
      prospects.map((a) => ({ from: contactIds.get(contactFor.get(a.accountId)!.email)!.id, to: companyIds.get(a.accountId)!.id })),
    );
    console.log(`Contacts attached to their companies: ${prospects.length}.`);
  }

  if (ONE) {
    const a = accounts[0];
    console.log(`\nSynced ${a.name}. Open it in HubSpot (company id ${companyIds.get(a.accountId)!.id}) and check Gross margin shows ${Math.round((a.grossMargin ?? 0) * 100)}%.`);
  }
  console.log("\nSync finished.");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
