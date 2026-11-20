// How Cockpit's values map onto HubSpot fields. Pure formatting rules, no network and no business math:
// every number comes from calcCrmSyncData in metrics.ts. Used by scripts/hubspot-sync.ts.
import type { CrmAccountRow, CrmDealRow, CrmSyncData } from "./metrics.ts";

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
