// Syncs Supabase -> HubSpot: companies, deals (with their company), one made-up contact per prospect, and a
// contact for each enterprise / mid-market customer's executive sponsor (current or former).
// Shared by `npm run hubspot:sync` and the "Sync to HubSpot" button on the Integrations page. Server-side only.
// All numbers come from metrics.ts (getCrmSyncData); mapping rules live in hubspot-sync.ts.
// Records are matched on lumen_account_id / lumen_opportunity_id / email, so re-runs update instead of duplicating.
// Never deletes anything in HubSpot. Stops at the first HubSpot error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCrmSyncData, type CrmAccountRow, type CrmDealRow } from "./metrics.ts";
import { hubspot } from "./hubspot.ts";
import {
  checkbox,
  DEAL_TYPE_TO_HUBSPOT_LABEL,
  dealName,
  decimal,
  fictionalContact,
  FORECAST_TO_HUBSPOT_LABEL,
  isBackwardLifecycleMove,
  lifecycleLabel,
  multiSelect,
  optionValue,
  pickTestAccount,
  reasonsText,
  sponsorContact,
  sponsorRoleLabel,
  SPONSOR_STATUS_LABEL,
} from "./hubspot-sync.ts";

export type SyncOptions = {
  /** Build everything and send nothing. */
  dryRun?: boolean;
  /** Sync one customer and its deals: this account ID, or (with one: true) the default test account. */
  accountId?: string;
  one?: boolean;
  /** Called with a short line at each step. */
  onProgress?: (line: string) => void;
};

export type SyncCount = { synced: number; created: number; updated: number };

export type SyncResult = {
  dryRun: boolean;
  /** "all" or the single account synced. */
  scope: { kind: "all" } | { kind: "one"; accountId: string; name: string; hubspotId: string | null };
  companies: SyncCount;
  deals: SyncCount;
  contacts: SyncCount;
  lifecycleCleared: number;
  /** Dry runs only: the first record of each kind, as it would be sent. */
  samples?: { company?: Props; deal?: Props; contact?: Props; sponsorContact?: Props; dealsPerPipeline: Record<string, number> };
};

const BATCH = 100; // HubSpot batch endpoints take up to 100 records per call
const STAGE_01 = "Stage 0.1";

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

const count = (m: Map<string, { isNew: boolean }>): SyncCount => {
  const created = [...m.values()].filter((v) => v.isNew).length;
  return { synced: m.size, created, updated: m.size - created };
};
const NONE: SyncCount = { synced: 0, created: 0, updated: 0 };

export async function runHubSpotSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const say = opts.onProgress ?? (() => {});
  const dryRun = Boolean(opts.dryRun);
  if (dryRun) say("Dry run: reading only; nothing will be sent to HubSpot.");

  // 1. Our data (all numbers from metrics.ts)
  say("Reading Cockpit data…");
  const all = await getCrmSyncData();
  // Stage 0.1 deals ("meeting booked, qualifying") aren't in HubSpot's pipelines yet, so they stay out of the sync
  // (owner's decision, 23 Nov 2026). Leads and sequences aren't synced either.
  const skipped = all.deals.filter((d) => d.stage === STAGE_01).length;
  all.deals = all.deals.filter((d) => d.stage !== STAGE_01);
  let accounts: CrmAccountRow[] = all.accounts;
  let deals: CrmDealRow[] = all.deals;
  const single = opts.accountId
    ? (all.accounts.find((a) => a.accountId === opts.accountId) ?? fail(`No account with ID "${opts.accountId}".`))
    : opts.one
      ? (pickTestAccount(all) ?? fail("No customer has an open deal plus margin and capacity figures."))
      : null;
  if (single) {
    accounts = [single];
    deals = all.deals.filter((d) => d.accountId === single.accountId);
    say(`One account: ${single.name} (${single.accountId}), ${deals.length} deal(s).`);
  }
  const prospects = single ? [] : accounts.filter((a) => a.status === "prospect");

  // 2. Read HubSpot's setup: pipelines, stages and dropdown options. Stop on anything missing.
  say("Checking HubSpot pipelines and dropdown options…");
  const pipeSpec = JSON.parse(readFileSync(join(process.cwd(), "hubspot", "pipelines.json"), "utf8")) as {
    pipelines: { label: string; dealTypes: string[] }[];
  };
  const hsPipelines = (await hubspot<{ results: HsPipeline[] }>("GET", "/crm/v3/pipelines/deals")).results;
  const pipelineFor = new Map<string, HsPipeline>();
  for (const p of pipeSpec.pipelines) {
    const found = hsPipelines.find((h) => h.label.trim().toLowerCase() === p.label.toLowerCase()) ?? fail(`Pipeline "${p.label}" not found. Run npm run hubspot:setup.`);
    for (const t of p.dealTypes) pipelineFor.set(t, found);
  }

  const [forecastOpts, dealTypeOpts, lifecycleOpts, segmentOpts, statusOpts, renewalRiskOpts, dealRiskOpts, sponsorOpts, productOpts, roleOpts] = await Promise.all([
    optionsOf("deals", "hs_manual_forecast_category"),
    optionsOf("deals", "dealtype"),
    optionsOf("companies", "lifecyclestage"),
    optionsOf("companies", "lumen_segment"),
    optionsOf("companies", "lumen_account_status"),
    optionsOf("companies", "lumen_renewal_risk"),
    optionsOf("deals", "lumen_deal_risk"),
    optionsOf("companies", "lumen_executive_sponsor_status"),
    optionsOf("companies", "lumen_products_owned"),
    optionsOf("contacts", "lumen_role"),
  ]);
  for (const label of Object.values(FORECAST_TO_HUBSPOT_LABEL)) valueFor(forecastOpts, label, "Forecast category");

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
      lumen_renewal_risk_reasons: reasonsText(a.renewalRiskReasons),
      lumen_health_score: str(a.healthScore),
      lumen_health_declining: checkbox(a.healthDeclining),
      lumen_arr_at_downsell_risk: str(a.downsellArr),
      lumen_missing_renewal_deal: checkbox(a.missingRenewalDeal),
      lumen_executive_sponsor_status: a.sponsorStatus
        ? ownOption(sponsorOpts, SPONSOR_STATUS_LABEL[a.sponsorStatus] ?? fail(`Unknown sponsor status "${a.sponsorStatus}"`), "Executive sponsor status")
        : "",
      lumen_ae_name: str(a.ae),
      lumen_csm_name: str(a.csm),
      lumen_products_owned: a.productsOwned ? multiSelect(a.productsOwned.filter((p) => ownOption(productOpts, p, "Products owned"))) : "", // ownOption stops on a missing option
      // Blank (not $0) for a product the customer doesn't own; sending "" also clears an old $0 in HubSpot.
      lumen_core_arr: str(a.productArr?.Core),
      lumen_extract_arr: str(a.productArr?.Extract),
      lumen_code_review_arr: str(a.productArr?.["Code Review"]),
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
        lumen_adr_name: str(d.adr),
        lumen_csm_name: str(d.csm),
      },
    };
  });

  // 5. Contacts: one made-up contact per prospect, and each tracked customer's executive sponsor (current or former).
  //    Each is matched on its email and attached to its company.
  const contactList: { accountId: string; input: Input }[] = [];
  for (const a of prospects) {
    const c = fictionalContact(a);
    contactList.push({ accountId: a.accountId, input: { idProperty: "email", id: c.email, properties: { email: c.email, firstname: c.firstname, lastname: c.lastname, jobtitle: c.jobtitle, company: a.name } } });
  }
  const sponsors = accounts.filter((a) => a.sponsor);
  for (const a of sponsors) {
    const c = sponsorContact(a, a.sponsor!);
    const role = ownOption(roleOpts, sponsorRoleLabel(a.sponsor!.status), "Lumen role");
    contactList.push({
      accountId: a.accountId,
      input: { idProperty: "email", id: c.email, properties: { email: c.email, firstname: c.firstname, lastname: c.lastname, jobtitle: c.jobtitle, company: a.name, lumen_role: role } },
    });
  }
  const emails = contactList.map((c) => c.input.id);
  const dupe = emails.find((e, i) => emails.indexOf(e) !== i);
  if (dupe) fail(`Two contacts would share the email ${dupe}. Stopping before anything is sent.`);
  const contactInputs = contactList.map((c) => c.input);

  if (skipped) say(`Left out: ${skipped} Qualifying deal(s), which aren't in HubSpot's pipelines.`);
  say(
    `To sync: ${companyInputs.length} companies, ${dealInputs.length} deals, ${contactInputs.length} contacts ` +
      `(${prospects.length} prospect, ${sponsors.length} executive sponsor).`,
  );
  const scope: SyncResult["scope"] = single ? { kind: "one", accountId: single.accountId, name: single.name, hubspotId: null } : { kind: "all" };

  if (dryRun) {
    const dealsPerPipeline: Record<string, number> = {};
    for (const d of dealInputs) {
      const label = hsPipelines.find((p) => p.id === d.properties.pipeline)!.label;
      dealsPerPipeline[label] = (dealsPerPipeline[label] ?? 0) + 1;
    }
    say("Dry run finished. Nothing was sent.");
    return {
      dryRun,
      scope,
      companies: { ...NONE, synced: companyInputs.length },
      deals: { ...NONE, synced: dealInputs.length },
      contacts: { ...NONE, synced: contactInputs.length },
      lifecycleCleared: 0,
      samples: { company: companyInputs[0]?.properties, deal: dealInputs[0]?.properties, contact: contactInputs[0]?.properties, sponsorContact: contactList.find((c) => c.input.properties.lumen_role)?.input.properties, dealsPerPipeline },
    };
  }

  // 6. Lifecycle stages can't move backwards in HubSpot: clear those first.
  say("Checking lifecycle stages…");
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
  if (toClear.length) say(`Cleared lifecycle stage on ${toClear.length} compan${toClear.length === 1 ? "y" : "ies"} moving backwards.`);

  // 7. Write: companies, deals, deal → company, contacts, contact → company
  say(`Sending ${companyInputs.length} companies…`);
  const companyIds = await upsert("companies", companyInputs);
  const companies = count(companyIds);
  say(`Companies: ${companies.synced} synced (${companies.created} new, ${companies.updated} updated).`);

  say(`Sending ${dealInputs.length} deals…`);
  const dealIds = await upsert("deals", dealInputs);
  const dealCount = count(dealIds);
  say(`Deals: ${dealCount.synced} synced (${dealCount.created} new, ${dealCount.updated} updated).`);
  await associate(
    "deals",
    "companies",
    deals.map((d) => ({ from: dealIds.get(d.opportunityId)!.id, to: companyIds.get(d.accountId)?.id ?? fail(`Company ${d.accountId} for deal ${d.opportunityId} was not synced.`) })),
  );
  say(`Deals attached to their companies: ${deals.length}.`);

  let contacts = NONE;
  if (contactInputs.length) {
    say(`Sending ${contactInputs.length} contacts…`);
    const contactIds = await upsert("contacts", contactInputs);
    contacts = count(contactIds);
    say(`Contacts: ${contacts.synced} synced (${contacts.created} new, ${contacts.updated} updated).`);
    await associate(
      "contacts",
      "companies",
      contactList.map((c) => ({ from: contactIds.get(c.input.id)!.id, to: companyIds.get(c.accountId)!.id })),
    );
    say(`Contacts attached to their companies: ${contactList.length}.`);
  }

  if (scope.kind === "one") scope.hubspotId = companyIds.get(scope.accountId)?.id ?? null;
  say("Sync finished.");
  return { dryRun, scope, companies, deals: dealCount, contacts, lifecycleCleared: toClear.length };
}
