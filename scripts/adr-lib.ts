/**
 * Builds the ADR (account development) data for Cockpit (built for Lumen AI): territories and
 * ADR-AE pairings, account tags (ICP tier, target account, territory), about 600 leads over the
 * last 6 months, outreach sequences and enrollments, and new Stage 0.1 deals from leads that
 * booked a meeting.
 *
 * Used by `npm run adr:backfill` (live rows) and by `npm run seed` (the rows it has just generated),
 * so both always produce the same result for the same data.
 *
 * Pure functions: no database, no real clock. Random numbers come from a fixed seed per row,
 * separate from every other seed stream, so nothing that already exists can shift. Existing deals
 * are only read (to link the leads they came from); none of their values change.
 *
 * Problems built in on purpose (agreed with the owner, 23 Nov 2026), for the ADR hygiene and
 * insights pages: about 8% of leads unassigned; MQLs first touched well after the 24-hour SLA or
 * never; conversion that differs clearly by lead source; one sequence with a bad list (high
 * bounces); per-ADR differences; stale Stage 0.1 deals; wrong or missing account tags; and a few
 * Stage 0.1 deals whose ADR isn't paired with the deal's AE.
 *
 * This file only shapes demo data; the app's business math stays in src/lib/metrics.ts.
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export type AdrAccount = { id: string; name: string; status: "prospect" | "customer" | "churned"; segment: string; owner: string };
export type AdrDeal = { id: string; account_id: string; type: string; source: string; stage: string; created_date: string; adr_id: string | null };
export type AdrTeamMember = { id: string; name: string; role: string };

export type AccountTags = { icp_tier: number | null; target_account: boolean; territory: string | null };
export type PairingRow = { adr_id: string; ae_id: string; territory: string; effective_from: string };
export type LeadSource = "inbound demo request" | "content download" | "webinar" | "outbound" | "partner" | "event";
export type LifecycleStage = "lead" | "MQL" | "SQL" | "disqualified";
export type LeadRow = {
  id: string;
  account_id: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  lead_source: LeadSource;
  lifecycle_stage: LifecycleStage;
  created_at: string;
  mql_at: string | null;
  first_touch_at: string | null;
  sql_at: string | null;
  assigned_adr_id: string | null;
  disqualify_reason: string | null;
  opportunity_id: string | null;
};
export type SequenceRow = { id: string; name: string; audience: string; step_count: number; owner_id: string; created_at: string };
export type EnrollmentStatus = "active" | "finished" | "replied" | "bounced" | "unsubscribed";
export type EnrollmentRow = {
  id: string;
  sequence_id: string;
  lead_id: string;
  adr_id: string | null;
  enrolled_at: string;
  finished_at: string | null;
  status: EnrollmentStatus;
  emails_sent: number;
  opens: number;
  replies: number;
  bounces: number;
  meeting_booked: boolean;
  meeting_booked_at: string | null;
};
export type Stage01Deal = {
  id: string;
  account_id: string;
  type: "new";
  source: string;
  stage: "Stage 0.1";
  forecast_category: "Omitted";
  amount_usd: number;
  probability: number;
  created_date: string;
  close_date: string;
  executive_sponsor: null;
  stage_entered_date: string;
  last_activity_date: string;
  next_step: string;
  contract_id: null;
  ae_id: string;
  adr_id: string;
  csm_id: null;
};

export type AdrData = {
  teamTerritory: Map<string, string>;
  pairings: PairingRow[];
  accountTags: Map<string, AccountTags>;
  leads: LeadRow[];
  sequences: SequenceRow[];
  enrollments: EnrollmentRow[];
  stage01Deals: Stage01Deal[];
  /** What was planted on purpose, so the reconciliation can confirm it is there. Not stored. */
  planted: {
    tierThreeTargets: string[];
    missingTier: string[];
    missingTerritory: string[];
    wrongTerritory: string[];
    staleDeals: string[];
    mismatchedDeals: string[];
    linkedExistingDeals: string[];
  };
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SEED = "lumen-ai-adr-v1";
export const SLA_HOURS = 24;
export const PAIRING_EFFECTIVE_FROM = "2026-10-01";
export const STALE_DAYS = 14;
const LEAD_MONTHS_DAYS = 182; // about 6 months of leads
const TOTAL_LEADS = 600;
const UNASSIGNED_SHARE = 0.095; // of the generated leads; leads linked to existing deals are always assigned, so about 8% overall
const STAGE01_RECENT_DAYS = 75; // SQLs from the last 75 days become Stage 0.1 deals
const STALE_COUNT = 6;
const MISMATCH_COUNT = 4;
const STAGE01_PROBABILITY = 5; // percent, the same units as opportunities.probability

/** AE territories (the account owner's territory is the account's territory). */
const AE_TERRITORY: Record<string, string> = {
  "Priya Shah": "Enterprise North America",
  "Marcus Lee": "Enterprise EMEA",
  "Daniel Okafor": "Commercial East",
  "Hannah Kim": "Commercial Central",
  "Tomas Rivera": "Commercial West",
  "Elena Rossi": "Commercial EMEA",
};
/** Which ADR covers which territories (and so which AEs). */
const ADR_TERRITORIES: Record<string, string[]> = {
  "Sofia Marin": ["Enterprise North America", "Enterprise EMEA"],
  "Kenji Watanabe": ["Commercial East", "Commercial Central"],
  "Grace Mensah": ["Commercial West", "Commercial EMEA"],
};
const ADR_TEAM_TERRITORY: Record<string, string> = {
  "Sofia Marin": "Enterprise",
  "Kenji Watanabe": "Commercial East and Central",
  "Grace Mensah": "Commercial West and EMEA",
};

const SOURCES: readonly (readonly [LeadSource, number])[] = [
  ["inbound demo request", 18],
  ["content download", 26],
  ["webinar", 16],
  ["outbound", 40],
  ["partner", 8],
  ["event", 10],
];
/** Share of leads that become MQLs, and of MQLs that become SQLs (meeting booked), by source. */
const FUNNEL: Record<LeadSource, { mql: number; sql: number }> = {
  "inbound demo request": { mql: 1.0, sql: 0.55 },
  partner: { mql: 0.9, sql: 0.45 },
  event: { mql: 0.6, sql: 0.3 },
  webinar: { mql: 0.55, sql: 0.22 },
  outbound: { mql: 0.4, sql: 0.1 },
  "content download": { mql: 0.45, sql: 0.06 },
};
/** Per ADR: share of MQLs touched within the SLA, and how their replies and meetings compare. */
const ADR_STYLE: Record<string, { onTime: number; never: number; reply: number; meeting: number }> = {
  "Sofia Marin": { onTime: 0.8, never: 0.04, reply: 1.0, meeting: 1.0 },
  "Kenji Watanabe": { onTime: 0.55, never: 0.12, reply: 0.85, meeting: 0.9 },
  "Grace Mensah": { onTime: 0.78, never: 0.05, reply: 1.35, meeting: 1.15 },
};

/** The purchased contact list (the high-bounce sequence) has been used for new commercial outbound leads since this day. */
const BOUGHT_LIST_FROM = "2026-09-01";

type SeqSpec = { id: string; name: string; audience: string; steps: number; owner: string; open: number; reply: number; bounce: number; created: string };
const SEQUENCES: SeqSpec[] = [
  { id: "seq_01", name: "Inbound demo follow-up", audience: "Inbound demo requests and partner referrals", steps: 4, owner: "Kenji Watanabe", open: 0.65, reply: 0.4, bounce: 0.01, created: "2026-01-12" },
  { id: "seq_02", name: "Content nurture", audience: "Content downloads", steps: 6, owner: "Kenji Watanabe", open: 0.35, reply: 0.05, bounce: 0.02, created: "2026-01-12" },
  { id: "seq_03", name: "Webinar follow-up", audience: "Webinar attendees", steps: 4, owner: "Grace Mensah", open: 0.5, reply: 0.14, bounce: 0.02, created: "2026-02-03" },
  { id: "seq_04", name: "Event follow-up", audience: "Event booth scans and meetings", steps: 3, owner: "Grace Mensah", open: 0.55, reply: 0.18, bounce: 0.015, created: "2026-03-09" },
  { id: "seq_05", name: "Outbound cold: enterprise", audience: "Enterprise target accounts", steps: 7, owner: "Sofia Marin", open: 0.45, reply: 0.1, bounce: 0.03, created: "2026-01-20" },
  { id: "seq_06", name: "Outbound cold: commercial (bought list)", audience: "Purchased SMB and mid-market contact list", steps: 6, owner: "Kenji Watanabe", open: 0.22, reply: 0.03, bounce: 0.3, created: BOUGHT_LIST_FROM },
  { id: "seq_07", name: "Re-engagement", audience: "Leads that went quiet for 60+ days", steps: 3, owner: "Grace Mensah", open: 0.3, reply: 0.07, bounce: 0.04, created: "2026-04-14" },
  { id: "seq_08", name: "Outbound cold: commercial", audience: "SMB and mid-market target accounts (researched contacts)", steps: 5, owner: "Grace Mensah", open: 0.42, reply: 0.09, bounce: 0.03, created: "2026-01-20" },
];
const seq = (id: string) => SEQUENCES.find((s) => s.id === id)!;

const FIRST = ["Ava", "Ben", "Chloe", "Diego", "Elif", "Felix", "Gemma", "Hugo", "Isla", "Jamal", "Keira", "Luca", "Mila", "Nikhil", "Olivia", "Pablo", "Rosa", "Samir", "Tara", "Uri", "Vera", "Wes", "Yara", "Zane", "Anya", "Bram", "Carmen", "Dev", "Esme", "Finn"];
const LAST = ["Achebe", "Bergstrom", "Coelho", "Dumont", "Eriksen", "Farouk", "Gallagher", "Hoffmann", "Ishikawa", "Jovanovic", "Kowalczyk", "Larsen", "Mendes", "Nwosu", "Oyelaran", "Pellegrini", "Rahman", "Silva", "Takahashi", "Uchenna", "Vasquez", "Weiss", "Yilmaz", "Zielinski"];
const TITLES: Record<string, readonly string[]> = {
  enterprise: ["VP Operations", "Director of Data", "Head of Legal Operations", "Chief Data Officer", "Senior Manager, Automation", "VP Engineering"],
  "mid-market": ["Operations Manager", "Head of Data", "Engineering Manager", "Director of Operations", "IT Manager", "CTO"],
  SMB: ["Founder", "Operations Lead", "Office Manager", "Head of Engineering", "COO", "Data Analyst"],
};
const DISQUALIFY_REASONS = ["Not ICP", "No budget this year", "Student or personal email", "Competitor research", "Duplicate", "No response after sequence"] as const;
const AMOUNT: Record<string, readonly [number, number]> = { enterprise: [60_000, 150_000], "mid-market": [18_000, 45_000], SMB: [4_000, 12_000] };
const NEXT_STEPS = ["Qualify budget and timeline", "Confirm the use case with the champion", "Book discovery with the AE", "Send the security questionnaire", "Get the economic buyer on a call"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(label: string) {
  let state = hashString(`${SEED}:${label}`);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r < 0) return item;
      }
      return items[items.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ts = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** A working-hours time on the given day (09:00-17:59 UTC). */
const workTime = (r: Rng, dayMs: number) => dayMs + (9 + r.int(0, 8)) * HOUR_MS + r.int(0, 59) * 60_000;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildAdrData(input: { accounts: AdrAccount[]; deals: AdrDeal[]; team: AdrTeamMember[]; asOf: string }): AdrData {
  const { asOf } = input;
  const asOfEnd = dayStart(asOf) + DAY_MS - 1;
  const windowStart = dayStart(asOf) - LEAD_MONTHS_DAYS * DAY_MS;
  const idOf = new Map(input.team.map((t) => [t.name, t.id]));
  const nameOf = new Map(input.team.map((t) => [t.id, t.name]));
  const need = (name: string) => idOf.get(name) ?? (() => { throw new Error(`${name} is not on the team`); })();

  // 1. Territories and pairings
  const teamTerritory = new Map<string, string>();
  for (const [ae, territory] of Object.entries(AE_TERRITORY)) teamTerritory.set(need(ae), territory);
  for (const [adr, territory] of Object.entries(ADR_TEAM_TERRITORY)) teamTerritory.set(need(adr), territory);
  const pairings: PairingRow[] = [];
  const adrForTerritory = new Map<string, string>();
  for (const [adr, territories] of Object.entries(ADR_TERRITORIES)) {
    for (const territory of territories) {
      const ae = Object.entries(AE_TERRITORY).find(([, t]) => t === territory)![0];
      pairings.push({ adr_id: need(adr), ae_id: need(ae), territory, effective_from: PAIRING_EFFECTIVE_FROM });
      adrForTerritory.set(territory, need(adr));
    }
  }
  const pairedAdrOfAe = new Map(pairings.map((p) => [p.ae_id, p.adr_id]));
  const adrIds = Object.keys(ADR_TERRITORIES).map(need);

  // 2. Account tags (territory follows the account owner), then planted errors
  const accounts = [...input.accounts].sort((x, y) => x.id.localeCompare(y.id));
  const accountTags = new Map<string, AccountTags>();
  for (const a of accounts) {
    const r = makeRng(`tags:${a.id}`);
    const tierWeights: readonly (readonly [number, number])[] =
      a.segment === "enterprise" ? [[1, 80], [2, 20]] : a.segment === "mid-market" ? [[1, 35], [2, 50], [3, 15]] : [[1, 5], [2, 45], [3, 50]];
    const tier = r.weighted(tierWeights);
    const target = tier === 1 ? (a.status === "prospect" ? true : r.chance(0.6)) : tier === 2 ? r.chance(a.status === "prospect" ? 0.5 : 0.15) : false;
    accountTags.set(a.id, { icp_tier: tier, target_account: target, territory: AE_TERRITORY[a.owner] ?? null });
  }
  const shuffled = (label: string, xs: AdrAccount[]) => [...xs].sort((x, y) => hashString(`${SEED}:${label}:${x.id}`) - hashString(`${SEED}:${label}:${y.id}`));
  const used = new Set<string>();
  const take = (label: string, n: number, ok: (a: AdrAccount) => boolean) => {
    const out = shuffled(label, accounts).filter((a) => !used.has(a.id) && ok(a)).slice(0, n);
    out.forEach((a) => used.add(a.id));
    return out.map((a) => a.id);
  };
  const tierThreeTargets = take("tier3target", 4, (a) => accountTags.get(a.id)!.icp_tier === 3 && a.status !== "churned");
  for (const id of tierThreeTargets) accountTags.get(id)!.target_account = true;
  const missingTier = take("missingTier", 5, (a) => a.status !== "churned");
  for (const id of missingTier) accountTags.get(id)!.icp_tier = null;
  const missingTerritory = take("missingTerritory", 3, (a) => a.status !== "churned");
  for (const id of missingTerritory) accountTags.get(id)!.territory = null;
  const wrongTerritory = take("wrongTerritory", 3, (a) => a.status !== "churned");
  const territories = Object.values(AE_TERRITORY);
  for (const id of wrongTerritory) {
    const t = accountTags.get(id)!;
    t.territory = territories.find((x) => x !== t.territory && x.split(" ")[0] === (t.territory ?? "").split(" ")[0]) ?? territories[0];
  }

  // 3. Leads
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const territoryAdr = (a: AdrAccount) => adrForTerritory.get(AE_TERRITORY[a.owner]) ?? adrIds[0];
  const usedEmails = new Set<string>();
  const contact = (r: Rng, a: AdrAccount) => {
    const first = r.pick(FIRST);
    const last = r.pick(LAST);
    let email = `${slug(first)}.${slug(last)}@${slug(a.name)}.example.com`;
    for (let n = 2; usedEmails.has(email); n++) email = `${slug(first)}.${slug(last)}${n}@${slug(a.name)}.example.com`;
    usedEmails.add(email);
    return { contact_name: `${first} ${last}`, contact_title: r.pick(TITLES[a.segment] ?? TITLES.SMB), contact_email: email };
  };
  const sourceFromDeal = (s: string): LeadSource => (s === "outbound" ? "outbound" : s === "partner" ? "partner" : "inbound demo request");

  type Draft = LeadRow & { segment: string; touched: "on time" | "late" | "never" | null };
  const leads: Draft[] = [];

  // 3a. One lead per existing new-business deal created in the window (the lead it came from). The deal doesn't change.
  const linkedDeals = input.deals
    .filter((d) => d.type === "new" && dayStart(d.created_date) >= windowStart && dayStart(d.created_date) <= dayStart(asOf))
    .sort((x, y) => x.id.localeCompare(y.id));
  for (const d of linkedDeals) {
    const a = accById.get(d.account_id);
    if (!a) continue;
    const r = makeRng(`linked:${d.id}`);
    const sqlMs = workTime(r, dayStart(d.created_date));
    const mqlMs = Math.max(windowStart, sqlMs - r.int(2, 12) * DAY_MS);
    const createdMs = Math.max(windowStart, mqlMs - r.int(0, 20) * DAY_MS);
    leads.push({
      id: "",
      account_id: a.id,
      ...contact(r, a),
      lead_source: sourceFromDeal(d.source),
      lifecycle_stage: "SQL",
      created_at: ts(createdMs),
      mql_at: ts(mqlMs),
      first_touch_at: ts(Math.min(sqlMs, mqlMs + r.int(1, 20) * HOUR_MS)),
      sql_at: ts(sqlMs),
      assigned_adr_id: d.adr_id ?? territoryAdr(a),
      disqualify_reason: null,
      opportunity_id: d.id,
      segment: a.segment,
      touched: "on time",
    });
  }

  // 3b. Generated leads. Prospects get most of them; customers get some (other departments).
  const candidates = accounts.filter((a) => a.status !== "churned");
  const accountWeights = candidates.map((a) => [a, a.status === "prospect" ? (a.segment === "enterprise" ? 40 : a.segment === "mid-market" ? 25 : 14) : a.segment === "enterprise" ? 3 : a.segment === "mid-market" ? 2 : 1] as const);
  const generated = TOTAL_LEADS - leads.length;
  for (let i = 0; i < generated; i++) {
    const r = makeRng(`lead:${i}`);
    const a = r.weighted(accountWeights);
    let source = r.weighted(SOURCES);
    if (a.status === "customer" && source === "outbound" && r.chance(0.6)) source = "content download"; // little cold outreach to customers
    // Lead volume grows over the period (marketing ramping up): more of them are recent.
    const createdMs = workTime(r, windowStart + Math.floor(LEAD_MONTHS_DAYS * Math.pow(r.next(), 0.7)) * DAY_MS);
    const unassigned = r.chance(UNASSIGNED_SHARE);
    let adr: string | null = unassigned ? null : r.chance(0.05) ? r.pick(adrIds) : territoryAdr(a);
    const style = adr ? ADR_STYLE[nameOf.get(adr)!] : null;
    const f = FUNNEL[source];
    const lead: Draft = {
      id: "",
      account_id: a.id,
      ...contact(r, a),
      lead_source: source,
      lifecycle_stage: "lead",
      created_at: ts(createdMs),
      mql_at: null,
      first_touch_at: source === "outbound" && adr ? ts(createdMs + r.int(5, 50) * 60_000) : null, // the first outbound email
      sql_at: null,
      assigned_adr_id: adr,
      disqualify_reason: null,
      opportunity_id: null,
      segment: a.segment,
      touched: null,
    };
    if (r.chance(f.mql)) {
      const mqlMs = source === "inbound demo request" ? createdMs : createdMs + r.int(0, 21) * DAY_MS + r.int(0, 8) * HOUR_MS;
      if (mqlMs <= asOfEnd) {
        lead.lifecycle_stage = "MQL";
        lead.mql_at = ts(mqlMs);
        // First touch against the 24-hour SLA
        const never = adr ? style!.never : 0.85;
        const onTime = adr ? style!.onTime : 0;
        const roll = r.next();
        let touchMs: number | null;
        if (roll < never) {
          touchMs = null;
          lead.touched = "never";
        } else if (roll < never + onTime * (1 - never)) {
          touchMs = mqlMs + r.int(10, 60 * (SLA_HOURS - 2)) * 60_000;
          lead.touched = "on time";
        } else {
          touchMs = mqlMs + r.int(SLA_HOURS + 6, 24 * (adr ? 5 : 9)) * HOUR_MS;
          lead.touched = "late";
        }
        if (touchMs !== null && touchMs > asOfEnd) {
          touchMs = null;
          lead.touched = null; // not due yet
        }
        if (lead.first_touch_at === null || (touchMs !== null && touchMs < Date.parse(lead.first_touch_at))) lead.first_touch_at = touchMs === null ? lead.first_touch_at : ts(touchMs);

        // SQL = a meeting was booked. Prospects only: customer leads go to the account team.
        const touched = lead.first_touch_at !== null;
        const sqlChance = f.sql * (style?.meeting ?? 0) * (lead.touched === "late" ? 0.75 : 1);
        if (a.status === "customer" && r.chance(0.5)) {
          lead.lifecycle_stage = "disqualified";
          lead.disqualify_reason = "Existing customer, passed to the account team";
        } else if (a.status === "prospect" && touched && r.chance(sqlChance)) {
          const sqlMs = Math.max(Date.parse(lead.first_touch_at!), mqlMs) + r.int(1, 12) * DAY_MS;
          if (sqlMs <= asOfEnd) {
            lead.lifecycle_stage = "SQL";
            lead.sql_at = ts(workTime(r, dayStart(day(sqlMs))));
          }
        } else if (r.chance(0.4) && mqlMs + 14 * DAY_MS <= asOfEnd) {
          lead.lifecycle_stage = "disqualified";
          lead.disqualify_reason = r.pick(DISQUALIFY_REASONS);
        }
      }
    } else if (r.chance(0.15)) {
      lead.lifecycle_stage = "disqualified";
      lead.disqualify_reason = r.pick(["Not ICP", "Student or personal email", "Duplicate", "Competitor research"] as const);
    }
    leads.push(lead);
  }

  // Stable ids by creation time
  leads.sort((x, y) => x.created_at.localeCompare(y.created_at) || x.contact_email.localeCompare(y.contact_email));
  leads.forEach((l, i) => (l.id = `lead_${String(i + 1).padStart(4, "0")}`));

  // 4. Stage 0.1 deals from recent SQLs that aren't linked to a deal yet; older ones were disqualified after the meeting
  const stage01Deals: Stage01Deal[] = [];
  const recentFrom = dayStart(asOf) - STAGE01_RECENT_DAYS * DAY_MS;
  const sqls = leads.filter((l) => l.lifecycle_stage === "SQL" && !l.opportunity_id);
  let n = 0;
  for (const l of sqls) {
    const r = makeRng(`stage01:${l.id}`);
    if (Date.parse(l.sql_at!) < recentFrom) {
      if (r.chance(0.85)) {
        l.lifecycle_stage = "disqualified";
        l.disqualify_reason = "Not a fit after the first meeting";
      } // else stays an SQL with no deal (a hygiene finding)
      continue;
    }
    const a = accById.get(l.account_id)!;
    const created = l.sql_at!.slice(0, 10);
    const [lo, hi] = AMOUNT[a.segment] ?? AMOUNT.SMB;
    const ae = need(a.owner);
    const id = `opp_s01_${String(++n).padStart(3, "0")}`;
    stage01Deals.push({
      id,
      account_id: a.id,
      type: "new",
      source: l.lead_source === "outbound" ? "outbound" : l.lead_source === "partner" ? "partner" : "inbound",
      stage: "Stage 0.1",
      forecast_category: "Omitted",
      amount_usd: Math.round(r.int(lo, hi) / 600) * 600,
      probability: STAGE01_PROBABILITY,
      created_date: created,
      close_date: day(dayStart(created) + r.int(60, 120) * DAY_MS),
      executive_sponsor: null,
      stage_entered_date: created,
      last_activity_date: day(Math.min(dayStart(asOf), dayStart(created) + r.int(0, 6) * DAY_MS)),
      next_step: r.pick(NEXT_STEPS),
      contract_id: null,
      ae_id: ae,
      adr_id: l.assigned_adr_id ?? pairedAdrOfAe.get(ae) ?? adrIds[0],
      csm_id: null,
    });
    l.opportunity_id = id;
  }
  // Stale: no update in STALE_DAYS+ days (only deals old enough to be stale)
  const byHash = (label: string) => (x: Stage01Deal, y: Stage01Deal) => hashString(`${SEED}:${label}:${x.id}`) - hashString(`${SEED}:${label}:${y.id}`);
  const staleDeals = stage01Deals
    .filter((d) => dayStart(d.created_date) <= dayStart(asOf) - (STALE_DAYS + 2) * DAY_MS)
    .sort(byHash("stale"))
    .slice(0, STALE_COUNT);
  for (const d of staleDeals) {
    const r = makeRng(`stale:${d.id}`);
    const daysSince = Math.min(r.int(STALE_DAYS + 1, 30), Math.round((dayStart(asOf) - dayStart(d.created_date)) / DAY_MS));
    d.last_activity_date = day(dayStart(asOf) - daysSince * DAY_MS);
  }
  for (const d of stage01Deals.filter((x) => !staleDeals.includes(x))) {
    // Active deals: touched in the last week
    const r = makeRng(`active:${d.id}`);
    d.last_activity_date = day(Math.max(dayStart(d.created_date), dayStart(asOf) - r.int(0, 6) * DAY_MS));
  }
  // ADR not paired with the deal's AE (deals created after the pairing took effect)
  const mismatchedDeals = stage01Deals
    .filter((d) => d.created_date >= PAIRING_EFFECTIVE_FROM)
    .sort(byHash("mismatch"))
    .slice(0, MISMATCH_COUNT);
  for (const d of mismatchedDeals) {
    const other = adrIds.find((x) => x !== pairedAdrOfAe.get(d.ae_id))!;
    d.adr_id = other;
    const lead = leads.find((l) => l.opportunity_id === d.id)!;
    lead.assigned_adr_id = other;
  }

  // 5. Sequences and enrollments
  const sequences: SequenceRow[] = SEQUENCES.map((s) => ({ id: s.id, name: s.name, audience: s.audience, step_count: s.steps, owner_id: need(s.owner), created_at: s.created }));
  const seqFor = (l: Draft): SeqSpec => {
    if (l.lead_source === "inbound demo request" || l.lead_source === "partner") return seq("seq_01");
    if (l.lead_source === "content download") return seq("seq_02");
    if (l.lead_source === "webinar") return seq("seq_03");
    if (l.lead_source === "event") return seq("seq_04");
    if (l.segment === "enterprise") return seq("seq_05");
    // Commercial outbound: the bought list only for new leads since it was bought; earlier leads and the leads behind existing deals used researched contacts.
    return !l.opportunity_id && l.created_at.slice(0, 10) >= BOUGHT_LIST_FROM ? seq("seq_06") : seq("seq_08");
  };
  const enrollments: EnrollmentRow[] = [];
  const enroll = (l: Draft, s: SeqSpec, startMs: number, label: string) => {
    const r = makeRng(`enroll:${label}:${l.id}`);
    const adrName = l.assigned_adr_id ? nameOf.get(l.assigned_adr_id)! : null;
    const replyRate = Math.min(0.95, s.reply * (adrName ? ADR_STYLE[adrName].reply : 0.7));
    const booked = l.sql_at !== null && label === "main";
    let sent = 0, opens = 0, replies = 0, bounces = 0;
    let status: EnrollmentStatus = "finished";
    let endMs = startMs;
    for (let step = 1; step <= s.steps; step++) {
      const stepMs = startMs + (step - 1) * 3 * DAY_MS;
      if (stepMs > asOfEnd) {
        status = "active";
        break;
      }
      sent++;
      endMs = stepMs;
      if (!booked && step === 1 && r.chance(s.bounce)) {
        bounces = 1;
        status = "bounced";
        break;
      }
      if (r.chance(s.open)) opens++;
      if (booked ? step >= Math.min(2, s.steps) : r.chance(replyRate / s.steps)) {
        replies = 1;
        status = "replied";
        break;
      }
      if (!booked && step >= 2 && r.chance(0.015)) {
        status = "unsubscribed";
        break;
      }
    }
    if (booked && status !== "replied") {
      replies = 1;
      status = "replied";
    }
    opens = Math.max(opens, replies); // a reply means the email was opened
    enrollments.push({
      id: "",
      sequence_id: s.id,
      lead_id: l.id,
      adr_id: l.assigned_adr_id,
      enrolled_at: ts(startMs),
      finished_at: status === "active" ? null : ts(booked ? Math.max(endMs, Date.parse(l.sql_at!) - DAY_MS) : endMs),
      status,
      emails_sent: sent,
      opens,
      replies,
      bounces,
      meeting_booked: booked,
      meeting_booked_at: booked ? l.sql_at : null,
    });
    return status;
  };
  for (const l of leads) {
    const s = seqFor(l);
    const startMs = l.mql_at ? Date.parse(l.mql_at) + HOUR_MS : Date.parse(l.created_at) + 2 * HOUR_MS;
    if (startMs > asOfEnd) continue;
    const status = enroll(l, s, startMs, "main");
    // Re-engagement for some leads that went quiet 60+ days ago
    const quietFrom = startMs + (s.steps * 3 + 60) * DAY_MS;
    if (l.lifecycle_stage !== "SQL" && status !== "bounced" && status !== "unsubscribed" && quietFrom <= asOfEnd && makeRng(`reengage:${l.id}`).chance(0.25)) {
      enroll(l, seq("seq_07"), quietFrom, "reengage");
    }
  }
  enrollments.sort((x, y) => x.enrolled_at.localeCompare(y.enrolled_at) || x.lead_id.localeCompare(y.lead_id));
  enrollments.forEach((e, i) => (e.id = `enr_${String(i + 1).padStart(4, "0")}`));

  const cleanLeads: LeadRow[] = leads.map(({ segment: _s, touched: _t, ...row }) => row);
  return {
    teamTerritory,
    pairings,
    accountTags,
    leads: cleanLeads,
    sequences,
    enrollments,
    stage01Deals,
    planted: {
      tierThreeTargets,
      missingTier,
      missingTerritory,
      wrongTerritory,
      staleDeals: staleDeals.map((d) => d.id),
      mismatchedDeals: mismatchedDeals.map((d) => d.id),
      linkedExistingDeals: linkedDeals.map((d) => d.id),
    },
  };
}

/** Short code that changes whenever any built row changes. */
export function adrFingerprint(d: AdrData): string {
  const lines = [
    ...[...d.teamTerritory].sort().map(([k, v]) => `team|${k}|${v}`),
    ...d.pairings.map((p) => `pair|${p.adr_id}|${p.ae_id}|${p.territory}|${p.effective_from}`),
    ...[...d.accountTags].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `tag|${k}|${v.icp_tier}|${v.target_account}|${v.territory}`),
    ...d.leads.map((l) => `lead|${JSON.stringify(l)}`),
    ...d.sequences.map((s) => `seq|${JSON.stringify(s)}`),
    ...d.enrollments.map((e) => `enr|${JSON.stringify(e)}`),
    ...d.stage01Deals.map((o) => `opp|${JSON.stringify(o)}`),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}
