// Syncs Supabase -> HubSpot: companies, deals (with their company), one made-up contact per prospect, a
// contact for each enterprise / mid-market customer's executive sponsor (current or former), and a contact
// for each ADR lead (matched on email first, then lumen_lead_id; never duplicated). Qualifying deals go in the
// New business pipeline's Qualifying stage (0%, Not forecasted). Each deal that came from a lead is linked to
// that lead's contact.
// Shared by `npm run hubspot:sync` and the "Sync to HubSpot" button on the Integrations page. Server-side only.
// All numbers come from metrics.ts (getCrmSyncData); mapping rules live in hubspot-sync.ts.
// Records are matched on lumen_account_id / lumen_opportunity_id / email, so re-runs update instead of duplicating.
// Never deletes anything in HubSpot. Stops at the first HubSpot error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCrmSyncData, getLeadCrmRows, type CrmAccountRow, type CrmDealRow, type LeadCrmRow } from "./metrics.ts";
import { hubspot } from "./hubspot.ts";
import { LEAD_STAGE_LABELS, QUALIFYING } from "./format.ts";
import { recordSyncRun } from "./sync-runs.ts";
import {
  checkbox,
  DEAL_TYPE_TO_HUBSPOT_LABEL,
  dealName,
  hubspotStageLabel,
  decimal,
  fictionalContact,
  FORECAST_TO_HUBSPOT_LABEL,
  isBackwardLifecycleMove,
  lifecycleLabel,
  leadFlagProperties,
  leadSourceLabel,
  multiSelect,
  pickTestLead,
  planLeadContacts,
  type ExistingContact,
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
  /** With one / accountId: the lead to sync (default: the test Qualifying deal's lead, else pickTestLead). */
  leadId?: string;
  /** With one / accountId: a Qualifying deal to sync too (default: the largest Qualifying deal). */
  dealId?: string;
  /** Called with a short line at each step. */
  onProgress?: (line: string) => void;
  /** Where the run started, for the sync_runs record. Defaults to "cli". */
  source?: "button" | "cli";
};

export type SyncCount = { synced: number; created: number; updated: number };

export type SyncResult = {
  dryRun: boolean;
  /** "all" or the single account synced. */
  scope: { kind: "all" } | { kind: "one"; accountId: string; name: string; hubspotId: string | null };
  companies: SyncCount;
  deals: SyncCount;
  /** Prospect and sponsor contacts. */
  contacts: SyncCount;
  /** ADR leads, as contacts. */
  leads: SyncCount;
  lifecycleCleared: number;
  /** Qualifying deals left out (they aren't in HubSpot's pipelines). */
  dealsLeftOut: number;
  /** Dry runs only: the first record of each kind, as it would be sent. */
  samples?: { company?: Props; deal?: Props; contact?: Props; sponsorContact?: Props; leadContact?: Props; dealsPerPipeline: Record<string, number> };
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

/**
 * Runs the sync and records it in sync_runs (real runs only, success or failure). A failure to record
 * is reported as a progress line and never fails the sync.
 */
export async function runHubSpotSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const say = opts.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const scope = opts.accountId || opts.one ? "one" : "full";
  const base = { scope, account_id: opts.accountId ?? null, source: opts.source ?? "cli", started_at: startedAt } as const;
  try {
    const r = await syncOnce(opts);
    if (!r.dryRun) {
      const problem = await recordSyncRun({
        ...base,
        account_id: r.scope.kind === "one" ? r.scope.accountId : null,
        status: "success",
        finished_at: new Date().toISOString(),
        companies_synced: r.companies.synced,
        companies_created: r.companies.created,
        deals_synced: r.deals.synced,
        deals_created: r.deals.created,
        contacts_synced: r.contacts.synced + r.leads.synced,
        contacts_created: r.contacts.created + r.leads.created,
        deals_left_out: r.dealsLeftOut,
        error: null,
      });
      if (problem) say(problem);
    }
    return r;
  } catch (e) {
    if (!opts.dryRun) {
      const problem = await recordSyncRun({
        ...base,
        status: "failed",
        finished_at: new Date().toISOString(),
        companies_synced: 0, companies_created: 0, deals_synced: 0, deals_created: 0, contacts_synced: 0, contacts_created: 0, deals_left_out: 0,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      });
      if (problem) say(problem);
    }
    throw e;
  }
}

async function syncOnce(opts: SyncOptions): Promise<SyncResult> {
  const say = opts.onProgress ?? (() => {});
  const dryRun = Boolean(opts.dryRun);
  if (dryRun) say("Dry run: reading only; nothing will be sent to HubSpot.");

  // 1. Our data (all numbers from metrics.ts)
  say("Reading Cockpit data…");
  const all = await getCrmSyncData();
  // Qualifying deals (Stage 0.1) are synced into the Qualifying stage (owner's decision, 24 Nov 2026). Sequences aren't synced.
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
    // Plus one Qualifying deal, to test the Qualifying stage and the deal -> lead contact link.
    const q = opts.dealId
      ? (all.deals.find((d) => d.opportunityId === opts.dealId) ?? fail(`No deal with ID "${opts.dealId}".`))
      : pickTestQualifyingDeal(all.deals);
    if (q && !deals.includes(q)) {
      deals.push(q);
      say(`One ${QUALIFYING} deal: ${dealName(q)} (${q.opportunityId}), $${q.amount.toLocaleString("en-US")}.`);
    }
  } else if (opts.dealId) fail("--deal only works with --one or --account.");
  const prospects = single ? [] : accounts.filter((a) => a.status === "prospect");

  // ADR leads: all of them, or (one-account runs) a single test lead.
  const allLeads = await getLeadCrmRows();
  let leads: LeadCrmRow[] = allLeads;
  if (single) {
    const dealLead = allLeads.find((l) => l.opportunityId !== null && deals.some((d) => d.opportunityId === l.opportunityId && d.stage === STAGE_01));
    const lead = opts.leadId
      ? (allLeads.find((l) => l.leadId === opts.leadId) ?? fail(`No lead with ID "${opts.leadId}".`))
      : (dealLead ?? pickTestLead(allLeads) ?? fail("No leads to test with."));
    leads = [lead];
    say(`One lead: ${lead.contactName} (${lead.leadId}) at ${lead.accountName}.`);
  } else if (opts.leadId) fail("--lead only works with --one or --account.");
  const noEmail = leads.find((l) => !l.email);
  if (noEmail) fail(`Lead ${noEmail.leadId} has no email. Stopping before anything is sent.`);

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
  // The Lead dropdowns must exist (npm run hubspot:setup creates them).
  const [leadStageOpts, leadSourceOpts] = leads.length
    ? await Promise.all([optionsOf("contacts", "lumen_lead_stage").catch(() => fail("HubSpot has no Lead stage property. Run npm run hubspot:setup.")), optionsOf("contacts", "lumen_lead_source").catch(() => fail("HubSpot has no Lead source property. Run npm run hubspot:setup."))])
    : [new Map<string, string>(), new Map<string, string>()];
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
    const stageLabel = hubspotStageLabel(d.stage);
    const stage =
      pipeline.stages.find((s) => s.label.trim().toLowerCase() === stageLabel.toLowerCase()) ??
      fail(`Pipeline "${pipeline.label}" has no "${stageLabel}" stage.${d.stage === STAGE_01 ? " Run npm run hubspot:setup." : ""}`);
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

  // 6. Leads: find each one's HubSpot contact (email first, then lumen_lead_id), so nothing is duplicated.
  for (const l of leads) {
    ownOption(leadStageOpts, LEAD_STAGE_LABELS[l.leadStage] ?? l.leadStage, "Lead stage");
    ownOption(leadSourceOpts, leadSourceLabel(l.leadSource), "Lead source");
  }
  say(leads.length ? `Looking up ${leads.length} lead(s) in HubSpot…` : "No leads to sync.");
  const byEmail = await readContacts("email", leads.map((l) => l.email.toLowerCase()));
  const byLeadId = await readContacts("lumen_lead_id", leads.map((l) => l.leadId));
  const leadPlans = planLeadContacts(leads, byEmail, byLeadId);
  // A lead whose email is also a prospect or sponsor contact in this run: one contact, with the Lead fields added.
  const contactByEmail = new Map(contactInputs.map((i) => [i.id.toLowerCase(), i]));
  const leadUpserts: Input[] = [];
  const leadUpdates: { leadId: string; id: string; properties: Props }[] = [];
  let merged = 0;
  for (const p of leadPlans) {
    if (p.kind === "update") leadUpdates.push({ leadId: p.leadId, id: p.hubspotId, properties: p.properties });
    else if (contactByEmail.has(p.email)) {
      const lead = leads.find((l) => l.leadId === p.leadId)!;
      Object.assign(contactByEmail.get(p.email)!.properties, planLeadContacts([lead], new Map([[p.email, { id: "", email: p.email, leadId: null, lifecyclestage: null }]]), new Map())[0].properties);
      merged++;
    } else leadUpserts.push({ idProperty: "email", id: p.email, properties: p.properties });
  }
  const leadMatched = leadPlans.filter((p) => p.existing).length;
  if (leads.length) say(`Leads: ${leadMatched} already in HubSpot, ${leads.length - leadMatched} to create${merged ? `, ${merged} merged with a prospect or sponsor contact` : ""}.`);

  say(
    `To sync: ${companyInputs.length} companies, ${dealInputs.length} deals, ${contactInputs.length} contacts ` +
      `(${prospects.length} prospect, ${sponsors.length} executive sponsor), ${leads.length} lead contact(s).`,
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
      leads: { ...NONE, synced: leads.length, created: leads.length - leadMatched, updated: leadMatched },
      lifecycleCleared: 0,
      dealsLeftOut: 0,
      samples: {
        company: companyInputs[0]?.properties,
        deal: dealInputs[0]?.properties,
        contact: contactInputs[0]?.properties,
        sponsorContact: contactList.find((c) => c.input.properties.lumen_role)?.input.properties,
        leadContact: leadUpserts[0]?.properties ?? leadUpdates[0]?.properties,
        dealsPerPipeline,
      },
    };
  }

  // 7. Lifecycle stages can't move backwards in HubSpot: clear those first (companies and lead contacts).
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
  const contactsToClear = leadPlans.filter((p) => p.existing && isBackwardLifecycleMove(p.existing.lifecyclestage, p.properties.lifecyclestage)).map((p) => p.existing!.id);
  for (const part of chunks(contactsToClear)) {
    const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/contacts/batch/update", { inputs: part.map((id) => ({ id, properties: { lifecyclestage: "" } })) });
    checkBatch("contact lifecycle clear", r);
  }
  if (contactsToClear.length) say(`Cleared lifecycle stage on ${contactsToClear.length} lead contact(s) moving backwards.`);

  // 8. Write: companies, deals, deal → company, contacts, contact → company, leads, lead → company
  say(`Sending ${companyInputs.length} companies…`);
  const companyIds = await upsert("companies", companyInputs);
  const companies = count(companyIds);
  say(`Companies: ${companies.synced} synced (${companies.created} new, ${companies.updated} updated).`);

  say(`Sending ${dealInputs.length} deals…`);
  const dealIds = await upsert("deals", dealInputs);
  const dealCount = count(dealIds);
  say(`Deals: ${dealCount.synced} synced (${dealCount.created} new, ${dealCount.updated} updated, ${deals.filter((d) => d.stage === STAGE_01).length} ${QUALIFYING}).`);
  // Companies this run didn't send (one-account runs) are looked up by their Lumen id.
  const companyIdOf = await companyLookup(companyIds, [...deals.map((d) => d.accountId), ...leads.map((l) => l.accountId)]);
  await associate(
    "deals",
    "companies",
    deals.map((d) => ({ from: dealIds.get(d.opportunityId)!.id, to: companyIdOf(d.accountId) })),
  );
  say(`Deals attached to their companies: ${deals.length}.`);

  let contacts = NONE;
  const contactIdsByEmail = new Map<string, string>();
  if (contactInputs.length) {
    say(`Sending ${contactInputs.length} contacts…`);
    const contactIds = await upsert("contacts", contactInputs);
    for (const [email, v] of contactIds) contactIdsByEmail.set(email.toLowerCase(), v.id);
    contacts = count(contactIds);
    say(`Contacts: ${contacts.synced} synced (${contacts.created} new, ${contacts.updated} updated).`);
    await associate(
      "contacts",
      "companies",
      contactList.map((c) => ({ from: contactIds.get(c.input.id)!.id, to: companyIds.get(c.accountId)!.id })),
    );
    say(`Contacts attached to their companies: ${contactList.length}.`);
  }

  let leadCount = NONE;
  if (leads.length) {
    say(`Sending ${leads.length} lead contact(s)…`);
    const upserted = leadUpserts.length ? await upsert("contacts", leadUpserts) : new Map<string, { id: string; isNew: boolean }>();
    for (const part of chunks(leadUpdates)) {
      const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/contacts/batch/update", { inputs: part.map((u) => ({ id: u.id, properties: u.properties })) });
      checkBatch("lead contacts update", r);
    }
    // Every lead's contact id: from this run's upserts, its update, or the prospect/sponsor contact it was merged into.
    const contactIdOf = (p: (typeof leadPlans)[number]) =>
      p.kind === "update" ? p.hubspotId : (upserted.get(p.email)?.id ?? contactIdsByEmail.get(p.email) ?? fail(`No HubSpot contact id for lead ${p.leadId}.`));
    const created = leadPlans.filter((p) => p.kind === "upsert" && upserted.get(p.email)?.isNew).length;
    leadCount = { synced: leads.length, created, updated: leads.length - created };
    say(`Lead contacts: ${leadCount.synced} synced (${leadCount.created} new, ${leadCount.updated} updated).`);
    await associate(
      "contacts",
      "companies",
      leadPlans.map((p) => ({ from: contactIdOf(p), to: companyIdOf(leads.find((l) => l.leadId === p.leadId)!.accountId) })),
    );
    say(`Lead contacts attached to their companies: ${leads.length}.`);
    // Each deal that came from a lead (its Qualifying deal, later the opportunity) is linked to the lead's contact.
    const dealContacts = leadPlans.flatMap((p) => {
      const opp = leads.find((l) => l.leadId === p.leadId)!.opportunityId;
      const deal = opp ? dealIds.get(opp) : undefined;
      return deal ? [{ from: deal.id, to: contactIdOf(p) }] : [];
    });
    await associate("deals", "contacts", dealContacts);
    if (dealContacts.length) say(`Deals linked to their lead's contact: ${dealContacts.length}.`);
  }

  if (scope.kind === "one") scope.hubspotId = companyIds.get(scope.accountId)?.id ?? null;
  say("Sync finished.");
  return { dryRun, scope, companies, deals: dealCount, contacts, leads: leadCount, lifecycleCleared: toClear.length + contactsToClear.length, dealsLeftOut: 0 };
}

/** The largest Qualifying deal: the default test deal for --one. */
export function pickTestQualifyingDeal(deals: CrmDealRow[]): CrmDealRow | undefined {
  return deals.filter((d) => d.stage === STAGE_01).sort((a, b) => b.amount - a.amount || a.opportunityId.localeCompare(b.opportunityId))[0];
}

/** HubSpot company id by Lumen account id: from this run's upserts, else read from HubSpot. Stops if one is missing. */
async function companyLookup(sent: Map<string, { id: string }>, accountIds: string[]): Promise<(accountId: string) => string> {
  const other = await readIds("companies", "lumen_account_id", [...new Set(accountIds.filter((id) => !sent.has(id)))]);
  return (id) => sent.get(id)?.id ?? other.get(id) ?? fail(`Company ${id} isn't in HubSpot. Run the full sync.`);
}

/** Reads contacts by email or lumen_lead_id. Returns the ones that exist, keyed by that value (emails lower-cased). */
async function readContacts(idProperty: "email" | "lumen_lead_id", values: string[]): Promise<Map<string, ExistingContact>> {
  const out = new Map<string, ExistingContact>();
  for (const part of chunks(values)) {
    // Missing records come back as errors in the response; that's expected here.
    const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/contacts/batch/read", {
      idProperty,
      properties: ["email", "lumen_lead_id", "lifecyclestage"],
      inputs: part.map((id) => ({ id })),
    });
    for (const res of r.results) {
      const c: ExistingContact = { id: res.id, email: (res.properties.email ?? "").toLowerCase(), leadId: res.properties.lumen_lead_id || null, lifecyclestage: res.properties.lifecyclestage || null };
      const key = idProperty === "email" ? c.email : c.leadId;
      if (key) out.set(key, c);
    }
  }
  return out;
}

/** HubSpot ids of records, by one of our unique properties. Missing ones are left out. */
async function readIds(object: string, idProperty: string, values: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(values)) {
    const r = await hubspot<BatchResult>("POST", `/crm/v3/objects/${object}/batch/read`, { idProperty, properties: [idProperty], inputs: part.map((id) => ({ id })) });
    for (const res of r.results) if (res.properties[idProperty]) out.set(res.properties[idProperty], res.id);
  }
  return out;
}

/**
 * Updates ADR owner, MQL past SLA and Unassigned on these leads' HubSpot contacts (matched on lumen_lead_id),
 * from lib/metrics.ts. Used when a Pipeline agent reassignment is approved or reverted. Never creates contacts.
 */
export async function updateLeadOwnership(leadIds: string[]): Promise<{ updated: number; notInHubSpot: string[] }> {
  if (leadIds.length === 0) return { updated: 0, notInHubSpot: [] };
  const rows = await getLeadCrmRows(leadIds);
  const found = await readIds("contacts", "lumen_lead_id", rows.map((r) => r.leadId));
  const notInHubSpot = rows.filter((r) => !found.has(r.leadId)).map((r) => r.leadId);
  const present = rows.filter((r) => found.has(r.leadId));
  for (const part of chunks(present)) {
    const r = await hubspot<BatchResult>("POST", "/crm/v3/objects/contacts/batch/update", { inputs: part.map((row) => ({ id: found.get(row.leadId)!, properties: leadFlagProperties(row) })) });
    checkBatch("lead ownership update", r);
  }
  return { updated: present.length, notInHubSpot };
}
