// How Cockpit's values map onto HubSpot fields. Pure formatting rules, no network and no business math:
// every number comes from calcCrmSyncData in metrics.ts. Used by scripts/hubspot-sync.ts.
import type { CrmAccountRow, CrmDealRow, CrmSyncData, LeadCrmRow, LeadStage } from "./metrics.ts";
import { LEAD_STAGE_LABELS, QUALIFYING } from "./format.ts";

/** Our forecast category -> the LABEL of HubSpot's built-in Forecast category option (hs_manual_forecast_category).
 *  The sync reads HubSpot's real options and stops if any label is missing. */
export const FORECAST_TO_HUBSPOT_LABEL: Record<string, string> = {
  Pipeline: "Pipeline",
  "Best Case": "Best case",
  Commit: "Commit",
  Closed: "Closed won", // in our data only Closed Won deals are "Closed"
  Omitted: "Not forecasted", // in our data only Closed Lost deals are "Omitted"
};

/** Our deal type -> the LABEL of HubSpot's built-in Deal type option (dealtype). */
export const DEAL_TYPE_TO_HUBSPOT_LABEL: Record<string, string> = {
  new: "New Business",
  expansion: "Existing Business",
  renewal: "Existing Business",
};

/** Lifecycle stage LABEL in HubSpot: customer -> Customer; prospect with an open deal -> Opportunity, else Lead; churned -> Other. */
export function lifecycleLabel(a: Pick<CrmAccountRow, "status" | "hasOpenDeal">): string {
  if (a.status === "customer") return "Customer";
  if (a.status === "churned") return "Other";
  return a.hasOpenDeal ? "Opportunity" : "Lead";
}

/** The HubSpot deal stage label for one of our stages: Stage 0.1 is "Qualifying" (first stage of New business, 0%). */
export function hubspotStageLabel(stage: string): string {
  return stage === "Stage 0.1" ? QUALIFYING : stage;
}

/** HubSpot's lifecycle order (internal values). HubSpot won't move a stage backwards unless it is cleared first. */
export const LIFECYCLE_ORDER = ["subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer", "evangelist", "other"];

export function isBackwardLifecycleMove(current: string | null | undefined, next: string): boolean {
  if (!current) return false;
  const from = LIFECYCLE_ORDER.indexOf(current);
  const to = LIFECYCLE_ORDER.indexOf(next);
  return from !== -1 && to !== -1 && to < from;
}

const TYPE_NAME: Record<string, string> = { new: "New business", expansion: "Expansion", renewal: "Renewal" };

/** "Acme – Renewal" */
export function dealName(d: Pick<CrmDealRow, "accountName" | "type">): string {
  return `${d.accountName} – ${TYPE_NAME[d.type] ?? d.type}`;
}

/** Our own dropdowns (created by hubspot:setup) store each option's label in lower case as its value. */
export function optionValue(label: string): string {
  return label.toLowerCase();
}

/** A decimal sent as-is (0.42 shows as 42% in a HubSpot percentage field), rounded to 4 places. */
export function decimal(n: number | null): string {
  return n === null ? "" : String(Math.round(n * 10_000) / 10_000);
}

/** A HubSpot checkbox (booleancheckbox) stores "true" / "false"; blank when the value doesn't apply. */
export function checkbox(b: boolean | null): string {
  return b === null ? "" : String(b);
}

/** Renewal-risk reasons as one line of text, e.g. "Health below 50; Downsell risk". Blank when not a customer. */
export function reasonsText(reasons: readonly string[] | null): string {
  return reasons ? reasons.join("; ") : "";
}

/** Our sponsor status -> the label of the Executive sponsor status option. */
export const SPONSOR_STATUS_LABEL: Record<string, string> = { active: "Active", left: "Left", none: "None" };

/** A HubSpot multi-select (checkbox) stores the chosen option values joined by ";". */
export function multiSelect(labels: readonly string[] | null): string {
  return labels ? labels.map(optionValue).join(";") : "";
}

/** "Executive sponsor" for a current sponsor, "Former sponsor" for one who left (the Lumen role contact property). */
export function sponsorRoleLabel(status: "active" | "left"): string {
  return status === "active" ? "Executive sponsor" : "Former sponsor";
}

/** The executive sponsor as a HubSpot contact. The email is made up, at <company>.example.com
 *  (reserved for examples, can't receive mail), and stays the same every run so the contact is matched on it. */
export function sponsorContact(a: Pick<CrmAccountRow, "name">, sponsor: { name: string; title: string | null }): {
  firstname: string;
  lastname: string;
  jobtitle: string;
  email: string;
} {
  const [firstname, ...rest] = sponsor.name.trim().split(/\s+/);
  const lastname = rest.join(" ");
  const local = [firstname, lastname].filter(Boolean).map(slug).join(".");
  return { firstname, lastname, jobtitle: sponsor.title ?? "", email: `${local}@${slug(a.name)}.example.com` };
}

/** The single account used by --one: the largest-ARR customer that has an open deal and both a margin and capacity figure. */
export function pickTestAccount(data: CrmSyncData): CrmAccountRow | undefined {
  return data.accounts
    .filter((a) => a.status === "customer" && a.hasOpenDeal && a.grossMargin !== null && a.capacityUsed !== null)
    .sort((x, y) => (y.arr ?? 0) - (x.arr ?? 0) || x.accountId.localeCompare(y.accountId))[0];
}

// Made-up contacts: one per prospect, the same every run. Emails are subdomains of example.com, which is
// reserved for examples and can't receive mail. (HubSpot rejects the bare .example top-level domain as invalid.)
const FIRST = ["Alex", "Bailey", "Casey", "Devon", "Emery", "Finley", "Harper", "Jordan", "Kai", "Logan", "Morgan", "Noor", "Parker", "Quinn", "Riley", "Sage", "Taylor", "Uma", "Vic", "Wren"];
const LAST = ["Abara", "Brandt", "Castillo", "Dunmore", "Ellery", "Fairweather", "Gallo", "Hartigan", "Ivers", "Jansen", "Kowal", "Lindqvist", "Mbeki", "Novak", "Okafor", "Pereira", "Quill", "Rasmussen", "Sato", "Thorne"];
const TITLES = ["Head of Operations", "VP Engineering", "Director of Data", "CTO", "Head of AI", "VP Product", "Chief Operating Officer", "Director of IT"];

/** FNV-1a with a final mix, so similar inputs give unrelated numbers. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function fictionalContact(a: Pick<CrmAccountRow, "accountId" | "name">): { firstname: string; lastname: string; jobtitle: string; email: string } {
  // Separate hashes per field, so first names, last names and titles vary independently.
  const firstname = FIRST[hash(`first:${a.accountId}`) % FIRST.length];
  const lastname = LAST[hash(`last:${a.accountId}`) % LAST.length];
  const jobtitle = TITLES[hash(`title:${a.accountId}`) % TITLES.length];
  return { firstname, lastname, jobtitle, email: `${firstname}.${lastname}@${slug(a.name)}.example.com`.toLowerCase() };
}

// --- ADR leads as HubSpot contacts --------------------------------------------------

/**
 * Lead stage -> HubSpot's built-in lifecycle stage (internal value). HubSpot has no "accepted" stage,
 * so Sales accepted stays MQL; Sales qualified (passed the ADR's qualifying call) is SQL.
 * Disqualified and Nurture keep the furthest stage the lead reached before it ended.
 */
export const LEAD_STAGE_TO_LIFECYCLE: Record<Exclude<LeadStage, "disqualified" | "nurture">, string> = {
  new: "lead",
  engaged: "lead",
  mql: "marketingqualifiedlead",
  sales_accepted: "marketingqualifiedlead",
  sales_qualified: "salesqualifiedlead",
  meeting_booked: "salesqualifiedlead",
  converted: "opportunity",
};

export function leadLifecycleStage(r: Pick<LeadCrmRow, "leadStage" | "furthestStage">): string {
  const stage = r.leadStage === "disqualified" || r.leadStage === "nurture" ? r.furthestStage : r.leadStage;
  return LEAD_STAGE_TO_LIFECYCLE[stage as keyof typeof LEAD_STAGE_TO_LIFECYCLE] ?? "lead";
}

/** "Mary Ann O'Neil" -> { firstname: "Mary Ann", lastname: "O'Neil" }; one word -> first name only. */
export function splitName(full: string): { firstname: string; lastname: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstname: parts[0], lastname: "" };
  return { firstname: parts.slice(0, -1).join(" "), lastname: parts[parts.length - 1] };
}

/** "inbound demo request" -> "Inbound demo request" (the Lead source dropdown's label). */
export function leadSourceLabel(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/** A timestamp as HubSpot's date-and-time fields take it ("2026-11-10T00:00:00.000Z"); blank when missing. */
export function isoTime(ts: string | null): string {
  return ts ? new Date(ts).toISOString() : "";
}

/** The Lead fields only (lumen_*), as the dropdowns created by hubspot:setup store them. */
export function leadProperties(r: LeadCrmRow): Record<string, string> {
  return {
    lumen_lead_id: r.leadId,
    lumen_lead_stage: optionValue(LEAD_STAGE_LABELS[r.leadStage] ?? r.leadStage),
    lumen_lead_source: optionValue(leadSourceLabel(r.leadSource)),
    lumen_adr_owner: r.adrName ?? "",
    lumen_mql_date: isoTime(r.mqlAt),
    lumen_first_touch_date: isoTime(r.firstTouchAt),
    lumen_disqualify_reason: r.disqualifyReason ?? "",
    ...leadFlagProperties(r),
  };
}

/** The fields a reassignment changes: ADR owner and the two hygiene flags. */
export function leadFlagProperties(r: Pick<LeadCrmRow, "adrName" | "mqlPastSla" | "unassigned">): Record<string, string> {
  return { lumen_adr_owner: r.adrName ?? "", lumen_mql_past_sla: checkbox(r.mqlPastSla), lumen_unassigned: checkbox(r.unassigned) };
}

/** Everything a lead's contact gets: name, title, company and lifecycle stage, plus the Lead fields. */
export function leadContactProperties(r: LeadCrmRow): Record<string, string> {
  const { firstname, lastname } = splitName(r.contactName);
  return { email: r.email, firstname, lastname, jobtitle: r.contactTitle ?? "", company: r.accountName, lifecyclestage: leadLifecycleStage(r), ...leadProperties(r) };
}

/** A contact already in HubSpot, as the sync reads it. */
export type ExistingContact = { id: string; email: string; leadId: string | null; lifecyclestage: string | null };

export type LeadContactPlan =
  /** Upsert on email: creates the contact, or updates the one with this email. */
  | { kind: "upsert"; leadId: string; email: string; properties: Record<string, string>; existing: ExistingContact | null }
  /** The contact with this lumen_lead_id has another email: update it by its HubSpot id. */
  | { kind: "update"; leadId: string; hubspotId: string; properties: Record<string, string>; existing: ExistingContact };

/**
 * How each lead reaches HubSpot without duplicates: match on email first, then on lumen_lead_id,
 * else create. A contact matched by email that isn't a lead contact (a prospect or sponsor contact)
 * only gets the Lead fields: its name, title and role are kept.
 */
export function planLeadContacts(rows: LeadCrmRow[], byEmail: Map<string, ExistingContact>, byLeadId: Map<string, ExistingContact>): LeadContactPlan[] {
  return rows.map((r) => {
    const email = r.email.toLowerCase();
    const sameEmail = byEmail.get(email) ?? null;
    if (sameEmail) {
      const isOtherContact = sameEmail.leadId !== r.leadId;
      const properties = isOtherContact ? { ...leadProperties(r), lifecyclestage: leadLifecycleStage(r) } : leadContactProperties(r);
      return { kind: "upsert", leadId: r.leadId, email, properties, existing: sameEmail };
    }
    const sameLead = byLeadId.get(r.leadId);
    if (sameLead) return { kind: "update", leadId: r.leadId, hubspotId: sameLead.id, properties: leadContactProperties(r), existing: sameLead };
    return { kind: "upsert", leadId: r.leadId, email, properties: leadContactProperties(r), existing: null };
  });
}

/** The default test lead for --one: the first MQL past the SLA that an ADR owns (fills the most fields). */
export function pickTestLead(rows: LeadCrmRow[]): LeadCrmRow | undefined {
  return rows.find((r) => r.mqlPastSla && r.adrName !== null) ?? rows[0];
}
