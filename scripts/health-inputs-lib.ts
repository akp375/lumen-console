/**
 * Builds the health-score inputs for Cockpit (built for Lumen AI) from data
 * that already exists: the team, ownership (CSM on accounts; AE, ADR and CSM
 * on deals), CSM activities and CSAT on closed tickets.
 *
 * Used by `npm run health-inputs:backfill` (reads the live rows) and by
 * `npm run seed` (passes the rows it has just generated), so both always
 * produce the same result for the same data.
 *
 * Pure functions: no database, no real clock. Random numbers come from a
 * fixed seed per account or ticket, separate from every other seed stream,
 * so nothing that already exists can shift. This file only shapes demo data;
 * the app's business math stays in src/lib/metrics.ts.
 */
import { createHash } from "node:crypto";
import { RENEWAL_RISK_RULES, calcNpsTrend, calcUsageTrend, type AccountRow, type NpsResponseRow, type UsageRow } from "../src/lib/metrics.ts";

// ---------------------------------------------------------------------------
// Team (fictional people). The 6 AEs are the existing account owners.
// ---------------------------------------------------------------------------

export type TeamRole = "AE" | "CSM" | "ADR" | "CS manager" | "sales manager";
export type TeamSegment = "enterprise" | "mid-market" | "SMB" | "commercial" | "all"; // commercial = SMB + mid-market
export type TeamRow = { id: string; name: string; role: TeamRole; segment: TeamSegment };

export const TEAM: TeamRow[] = [
  { id: "tm_01", name: "Priya Shah", role: "AE", segment: "enterprise" },
  { id: "tm_02", name: "Marcus Lee", role: "AE", segment: "enterprise" },
  { id: "tm_03", name: "Elena Rossi", role: "AE", segment: "commercial" },
  { id: "tm_04", name: "Daniel Okafor", role: "AE", segment: "commercial" },
  { id: "tm_05", name: "Hannah Kim", role: "AE", segment: "commercial" },
  { id: "tm_06", name: "Tomas Rivera", role: "AE", segment: "commercial" },
  // CSM coverage (agreed with the owner, 22 Nov 2026): enterprise dedicated, mid-market named, SMB pooled.
  { id: "tm_07", name: "Aisha Bello", role: "CSM", segment: "enterprise" },
  { id: "tm_08", name: "Jonas Weber", role: "CSM", segment: "mid-market" },
  { id: "tm_09", name: "Maya Fernandes", role: "CSM", segment: "SMB" },
  { id: "tm_10", name: "Liam O'Connor", role: "CSM", segment: "SMB" },
  { id: "tm_11", name: "Sofia Marin", role: "ADR", segment: "enterprise" },
  { id: "tm_12", name: "Kenji Watanabe", role: "ADR", segment: "commercial" },
  { id: "tm_13", name: "Grace Mensah", role: "ADR", segment: "commercial" },
  { id: "tm_14", name: "Rachel Adler", role: "CS manager", segment: "all" },
  { id: "tm_15", name: "David Novak", role: "sales manager", segment: "all" },
];

// AEs and ADRs cover enterprise or commercial (SMB + mid-market); CSMs cover one account segment each.
const teamSegment = (accountSegment: string): "enterprise" | "commercial" => (accountSegment === "enterprise" ? "enterprise" : "commercial");
const membersFor = (role: TeamRole, segment: TeamSegment) => TEAM.filter((t) => t.role === role && t.segment === segment);

// ---------------------------------------------------------------------------
// Input and output rows
// ---------------------------------------------------------------------------

export type HealthAccount = AccountRow;
export type HealthOpportunity = { id: string; account_id: string; type: string; source: string };
export type HealthTicket = { id: string; account_id: string; opened_at: string; closed_at: string | null; severity: string; status: string };
export type HealthUsage = UsageRow;
export type HealthNps = NpsResponseRow;

export type ActivityType = "call" | "email" | "meeting" | "QBR" | "exec meeting";
export type AttendeeLevel = "executive" | "manager" | "user";
export type CsActivityRow = {
  id: string;
  account_id: string;
  csm_id: string;
  activity_date: string;
  type: ActivityType;
  attendee_level: AttendeeLevel;
};
export type DealOwners = { ae_id: string | null; adr_id: string | null; csm_id: string | null };

/** How an account is doing today, judged only from existing data. Seeding only: not an app metric. */
export type SeedTier = "healthy" | "middle" | "declining-quiet" | "declining-burst";

export type HealthInputs = {
  team: TeamRow[];
  /** csm_id per account id (customers and churned accounts; prospects have none). */
  accountCsm: Map<string, string | null>;
  /** ae_id, adr_id and csm_id per opportunity id. */
  dealOwners: Map<string, DealOwners>;
  activities: CsActivityRow[];
  /** csat_score per closed ticket id; unrated tickets are left out. */
  csat: Map<string, number>;
  tiers: Map<string, SeedTier>;
  /** Account owners that are not an AE on the team (should be none). */
  unknownOwners: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED = "lumen-ai-health-inputs-v1";

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

const DAY_MS = 86_400_000;
const toDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(toDate(s).getTime() + n * DAY_MS));
const maxDate = (a: string, b: string) => (a > b ? a : b);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const HISTORY_DAYS = 400; // activity history covers about the last 13 months (one full contract term plus a little)
const QUIET_FROM_DAYS: readonly [number, number] = [60, 120]; // quiet accounts: last real touch 60-120 days ago
const BURST_CALLS: readonly [number, number] = [4, 8]; // burst accounts: 4-8 calls in the last 3 weeks
const BURST_WINDOW_DAYS = 21;
const CSAT_RATED_SHARE = 0.7; // about 70% of closed tickets get a CSAT answer
const CSAT_RECENT_DAYS = 120; // declining accounts' lower CSAT applies to tickets closed in the last 120 days

// Days between real touches (calls and meetings), by tier and segment.
const TOUCH_GAP: Record<"healthy" | "middle" | "declining", Record<"enterprise" | "commercial", readonly [number, number]>> = {
  healthy: { enterprise: [10, 20], commercial: [18, 32] },
  middle: { enterprise: [20, 40], commercial: [28, 55] },
  declining: { enterprise: [35, 60], commercial: [40, 70] },
};
const EMAIL_GAP: readonly [number, number] = [25, 50];

const CSAT_SCORES: Record<"healthy" | "middle" | "declining", readonly (readonly [number, number])[]> = {
  healthy: [[5, 0.55], [4, 0.3], [3, 0.1], [2, 0.04], [1, 0.01]],
  middle: [[5, 0.35], [4, 0.35], [3, 0.18], [2, 0.08], [1, 0.04]],
  declining: [[5, 0.1], [4, 0.25], [3, 0.3], [2, 0.2], [1, 0.15]],
};

// ---------------------------------------------------------------------------
// Tiers: from today's usage trend, NPS and open severe tickets (existing data)
// ---------------------------------------------------------------------------

function buildTiers(accounts: HealthAccount[], usage: HealthUsage[], nps: HealthNps[], tickets: HealthTicket[], asOf: string): Map<string, SeedTier> {
  const usageTrend = new Map(calcUsageTrend(accounts, usage, asOf).map((u) => [u.accountId, u.usageChange]));
  const npsTrend = new Map(calcNpsTrend(accounts, nps, asOf).map((n) => [n.accountId, n]));
  const severeOpen = new Set(tickets.filter((t) => t.status !== "closed" && (t.severity === "high" || t.severity === "urgent")).map((t) => t.account_id));
  const tiers = new Map<string, SeedTier>();
  for (const a of accounts) {
    if (a.status === "prospect") continue;
    const declineStyle: SeedTier = makeRng(`style:${a.id}`).chance(0.5) ? "declining-quiet" : "declining-burst";
    if (a.status === "churned") {
      tiers.set(a.id, "declining-quiet"); // they went quiet before leaving
      continue;
    }
    const u = usageTrend.get(a.id);
    const n = npsTrend.get(a.id);
    let trouble = 0;
    if (u != null && u < RENEWAL_RISK_RULES.usageDropBelow) trouble++;
    if (n?.latestNps != null && n.latestNps < RENEWAL_RISK_RULES.npsBelow) trouble++;
    if (n?.npsChange != null && n.npsChange <= RENEWAL_RISK_RULES.npsDropOf) trouble++;
    if (severeOpen.has(a.id)) trouble++;
    tiers.set(a.id, trouble === 0 ? "healthy" : trouble === 1 ? "middle" : declineStyle);
  }
  return tiers;
}

// ---------------------------------------------------------------------------
// CSM activities for one account
// ---------------------------------------------------------------------------

function touchLevel(r: Rng): AttendeeLevel {
  return r.weighted([["manager", 0.55], ["user", 0.45]] as const);
}

function buildAccountActivities(a: HealthAccount, csmId: string, tier: SeedTier, asOf: string): Omit<CsActivityRow, "id">[] {
  const r = makeRng(`activities:${a.id}`);
  const end = a.status === "churned" && a.churn_date ? addDays(a.churn_date, -1) : asOf;
  const start = maxDate(a.start_date ?? end, addDays(asOf, -HISTORY_DAYS));
  if (start > end) return [];
  const seg = teamSegment(a.segment);
  const base = tier === "healthy" ? "healthy" : tier === "middle" ? "middle" : "declining";
  const out: Omit<CsActivityRow, "id">[] = [];
  const add = (date: string, type: ActivityType, level: AttendeeLevel) => {
    if (date >= start && date <= end) out.push({ account_id: a.id, csm_id: csmId, activity_date: date, type, attendee_level: level });
  };

  // When regular touches stop. Quiet accounts stop 60-120 days before the end; burst accounts go
  // thin about 3 months before the end, then get a burst of calls in the last 3 weeks.
  const quietFrom = tier === "declining-quiet" ? addDays(end, -r.int(QUIET_FROM_DAYS[0], QUIET_FROM_DAYS[1])) : end;
  const execStop = tier === "declining-quiet" || tier === "declining-burst" ? addDays(end, -r.int(120, 200)) : end;

  // Onboarding kickoff with an executive, when the account started inside the window.
  if (a.start_date && a.start_date >= start) add(addDays(a.start_date, r.int(1, 7)), "meeting", "executive");

  // Regular touches: calls and meetings.
  const [gMin, gMax] = TOUCH_GAP[base][seg];
  for (let d = addDays(start, r.int(0, gMax)); d <= end && d < quietFrom; d = addDays(d, r.int(gMin, gMax))) {
    add(d, r.chance(0.6) ? "call" : "meeting", touchLevel(r));
  }

  // Emails (one-way, so they never count as a touch in the score). Quiet accounts keep getting them.
  for (let d = addDays(start, r.int(0, EMAIL_GAP[1])); d <= end; d = addDays(d, r.int(EMAIL_GAP[0], EMAIL_GAP[1]))) {
    add(d, "email", r.chance(0.7) ? "user" : "manager");
  }

  // Exec meetings. Healthy: every 2-3 months, the last within 90 days. Middle: every 3-6 months.
  // Declining: none since 120-200 days before the end.
  const execGap: readonly [number, number] = base === "healthy" ? [55, 85] : [90, 180];
  const firstExec = base === "healthy" ? r.int(10, 55) : r.int(10, 170); // middle: about half had one in the last 90 days
  for (let d = addDays(end, -firstExec); d >= start; d = addDays(d, -r.int(execGap[0], execGap[1]))) {
    if (d <= execStop) add(d, "exec meeting", "executive");
  }

  // QBRs: about every quarter for healthy, about twice a year for the others (and some are skipped). Healthy QBRs
  // often have an executive in the room; declining accounts' only see managers.
  const qbrGap: readonly [number, number] = base === "healthy" ? [80, 100] : [150, 220];
  for (let d = addDays(end, -r.int(15, qbrGap[0])); d >= start; d = addDays(d, -r.int(qbrGap[0], qbrGap[1]))) {
    if (base === "declining" && d > quietFrom) continue;
    if (base !== "healthy" && !r.chance(base === "middle" ? 0.7 : 0.3)) continue; // some QBRs never happen
    const level: AttendeeLevel = base === "healthy" && r.chance(0.5) ? "executive" : "manager";
    add(d, "QBR", level);
  }

  // Burst: 4-8 calls in the last 3 weeks, with managers and users, no executives.
  if (tier === "declining-burst" && a.status === "customer") {
    const n = r.int(BURST_CALLS[0], BURST_CALLS[1]);
    for (let k = 0; k < n; k++) add(addDays(end, -r.int(0, BURST_WINDOW_DAYS - 1)), "call", touchLevel(r));
  }

  // Declining-burst accounts are thin before the burst: drop most touches in the 3 months before it.
  const filtered =
    tier === "declining-burst"
      ? out.filter((x) => {
          const inThin = x.activity_date > addDays(end, -110) && x.activity_date < addDays(end, -(BURST_WINDOW_DAYS - 1));
          return !(inThin && (x.type === "call" || x.type === "meeting"));
        })
      : out;

  return filtered.sort((x, y) => x.activity_date.localeCompare(y.activity_date) || x.type.localeCompare(y.type));
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildHealthInputs(input: {
  accounts: HealthAccount[];
  opportunities: HealthOpportunity[];
  tickets: HealthTicket[];
  usage: HealthUsage[];
  nps: HealthNps[];
  asOf: string;
}): HealthInputs {
  const { asOf } = input;
  const accounts = [...input.accounts].sort((x, y) => x.id.localeCompare(y.id));
  const tiers = buildTiers(accounts, input.usage, input.nps, input.tickets, asOf);

  // CSMs by account segment: enterprise and mid-market each have one CSM; SMB is a pool, split evenly
  // (round-robin by account id, customers and churned accounts counted separately so customers split evenly).
  const accountCsm = new Map<string, string | null>();
  const rrCsm: Record<string, number> = {};
  for (const a of accounts) {
    if (a.status === "prospect") {
      accountCsm.set(a.id, null);
      continue;
    }
    const pool = membersFor("CSM", a.segment as TeamSegment);
    if (pool.length === 0) throw new Error(`No CSM covers segment ${a.segment}`);
    const rrKey = `${a.segment}:${a.status}`;
    const i = rrCsm[rrKey] ?? 0;
    rrCsm[rrKey] = i + 1;
    accountCsm.set(a.id, pool[i % pool.length].id);
  }

  // Deals: AE = the account owner; ADR on new inbound/outbound deals; CSM on renewal and expansion deals.
  const aeByName = new Map(TEAM.filter((t) => t.role === "AE").map((t) => [t.name, t.id]));
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const unknownOwners = [...new Set(accounts.map((a) => a.owner).filter((o) => !aeByName.has(o)))];
  const dealOwners = new Map<string, DealOwners>();
  const rrAdr: Record<string, number> = {};
  for (const o of [...input.opportunities].sort((x, y) => x.id.localeCompare(y.id))) {
    const acc = accById.get(o.account_id);
    let adr: string | null = null;
    if (o.type === "new" && (o.source === "inbound" || o.source === "outbound")) {
      const seg = teamSegment(acc?.segment ?? "SMB");
      const pool = membersFor("ADR", seg);
      const i = rrAdr[seg] ?? 0;
      rrAdr[seg] = i + 1;
      adr = pool[i % pool.length].id;
    }
    dealOwners.set(o.id, {
      ae_id: acc ? (aeByName.get(acc.owner) ?? null) : null,
      adr_id: adr,
      csm_id: o.type === "renewal" || o.type === "expansion" ? (accountCsm.get(o.account_id) ?? null) : null,
    });
  }

  // Activities, with stable ids per account: csa_0054_001 ...
  const activities: CsActivityRow[] = [];
  for (const a of accounts) {
    const csm = accountCsm.get(a.id);
    const tier = tiers.get(a.id);
    if (!csm || !tier) continue;
    const num = a.id.replace(/^acc_/, "");
    buildAccountActivities(a, csm, tier, asOf).forEach((x, k) => activities.push({ id: `csa_${num}_${String(k + 1).padStart(3, "0")}`, ...x }));
  }

  // CSAT on closed tickets: about 70% answer; declining accounts score lower on recent tickets.
  const csat = new Map<string, number>();
  for (const t of input.tickets) {
    if (t.status !== "closed" || !t.closed_at) continue;
    const r = makeRng(`csat:${t.id}`);
    if (!r.chance(CSAT_RATED_SHARE)) continue;
    const tier = tiers.get(t.account_id) ?? "middle";
    const recent = t.closed_at.slice(0, 10) >= addDays(asOf, -CSAT_RECENT_DAYS);
    const base = tier === "healthy" ? "healthy" : tier === "middle" ? "middle" : recent ? "declining" : "middle";
    csat.set(t.id, r.weighted(CSAT_SCORES[base]));
  }

  return { team: TEAM, accountCsm, dealOwners, activities, csat, tiers, unknownOwners };
}

/** Short code that changes whenever any built row changes. */
export function healthInputsFingerprint(h: HealthInputs): string {
  const lines = [
    ...h.team.map((t) => `team|${t.id}|${t.name}|${t.role}|${t.segment}`),
    ...[...h.accountCsm].sort().map(([k, v]) => `acc|${k}|${v}`),
    ...[...h.dealOwners].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `opp|${k}|${v.ae_id}|${v.adr_id}|${v.csm_id}`),
    ...h.activities.map((x) => `act|${x.id}|${x.account_id}|${x.csm_id}|${x.activity_date}|${x.type}|${x.attendee_level}`),
    ...[...h.csat].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `csat|${k}|${v}`),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}
