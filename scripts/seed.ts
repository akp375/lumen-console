/**
 * Seed script: fills Supabase with synthetic demo data for Lumen AI, a fictional
 * 40-person AI startup (about $3M ARR, 150 active customers).
 *
 *   npm run seed                 generate the data and write it to Supabase
 *   npm run seed -- --dry-run    generate the data and print the check only (no database)
 *
 * Every run with the same AS_OF_DATE produces identical data and identical IDs:
 * all randomness comes from a fixed seed, and every date is an offset from
 * AS_OF_DATE (src/lib/as-of-date.ts). Change that date and re-run to move all
 * the data forward.
 *
 * Accounts:
 *   acc_0001-acc_0150  customers (active)
 *   acc_0151-acc_0180  prospects (no MRR, usage or invoices)
 *   acc_0181-acc_0190  churned in the last 6 months
 *
 * What a run does to the database:
 *   - accounts:     updated in place by id (never deleted), so rows in
 *                   health_scores and expansion_plays stay linked to them.
 *   - model_prices, opportunities, invoices, usage_daily, support_tickets,
 *     nps_responses: cleared, then refilled.
 *   - health_scores, expansion_plays, briefings, llm_calls: never touched.
 *
 * The cost and revenue arithmetic below exists only to shape realistic data and
 * to print a self-check. The app's official business math lives in
 * src/lib/metrics.ts.
 *
 * Needs in .env.local:
 *   SUPABASE_URL                the project URL
 *   SUPABASE_SERVICE_ROLE_KEY   the service role / secret key (server-side only)
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";

// ---------------------------------------------------------------------------
// Fixed-seed random numbers
// ---------------------------------------------------------------------------

const SEED = "lumen-ai-demo-v1";

// FNV-1a hash: turns a text label into a 32-bit number.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: a small, well-known seeded random number generator.
// Each label gets its own stream, so adding data in one place never shifts the
// random numbers used somewhere else.
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
    float: (min: number, max: number): number => min + (max - min) * next(),
    int: (min: number, max: number): number => Math.floor(min + (max - min + 1) * next()),
    chance: (p: number): boolean => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((sum, [, w]) => sum + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r < 0) return item;
      }
      return items[items.length - 1][0];
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

// ---------------------------------------------------------------------------
// Dates (all in UTC, all relative to AS_OF_DATE)
// ---------------------------------------------------------------------------

if (!/^\d{4}-\d{2}-\d{2}$/.test(AS_OF_DATE) || Number.isNaN(Date.parse(`${AS_OF_DATE}T00:00:00Z`))) {
  throw new Error(`AS_OF_DATE must look like YYYY-MM-DD, got "${AS_OF_DATE}"`);
}

const DAY_MS = 86_400_000;
const AS_OF = new Date(`${AS_OF_DATE}T00:00:00Z`);

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}
function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`);
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Usage covers the 90 full days before the as-of date.
const USAGE_DAYS = 90;
const USAGE_START = addDays(AS_OF, -USAGE_DAYS);

// Invoices cover 13 months (this month and the 12 before), so 12-month NRR works.
const CURRENT_MONTH = monthStart(AS_OF);
const FIRST_INVOICE_MONTH = addMonths(CURRENT_MONTH, -12);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// Anthropic list prices per million tokens, checked 2026-11-13.
const MODEL_PRICES = [
  { model: "claude-opus-5-5", provider: "Anthropic", input: 4.0, output: 20.0 },
  { model: "claude-sonnet-5-5", provider: "Anthropic", input: 2.0, output: 10.0 },
  { model: "claude-haiku-5-5", provider: "Anthropic", input: 0.1, output: 0.5 },
] as const;
type ModelName = (typeof MODEL_PRICES)[number]["model"];
const PRICE_BY_MODEL = new Map(MODEL_PRICES.map((p) => [p.model as string, p]));

// Lumen AI's product features. outputShare = share of tokens that are output.
const FEATURES = [
  { feature: "chat_assistant", tokensPerRequest: 3_000, outputShare: 0.25 },
  { feature: "document_summary", tokensPerRequest: 12_000, outputShare: 0.08 },
  { feature: "data_extraction", tokensPerRequest: 5_000, outputShare: 0.12 },
  { feature: "code_review", tokensPerRequest: 9_000, outputShare: 0.15 },
] as const;
type Feature = (typeof FEATURES)[number];

const OWNERS_ENTERPRISE = ["Priya Shah", "Marcus Lee"];
const OWNERS_OTHER = ["Elena Rossi", "Daniel Okafor", "Hannah Kim", "Tomas Rivera"];

const NAME_PREFIXES = [
  "Aster", "Bluefin", "Cedarline", "Driftwood", "Emberly", "Fjordway", "Granitebay", "Harborview",
  "Ionic", "Juniper", "Kestrel", "Larkspur", "Meridian", "Nimbus", "Orchardly", "Pinecrest",
  "Quillon", "Redwoodly", "Saltmarsh", "Tidewater", "Umbra", "Vantagely", "Willowmere", "Xylo",
  "Yarrow", "Zephyrine", "Alderbrook", "Beaconfield", "Copperleaf", "Deltaform",
];
const NAME_SUFFIXES = [
  "Labs", "Health", "Logistics", "Analytics", "Legal", "Robotics",
  "Finance", "Bio", "Systems", "Media", "Retail", "Energy",
];

type Segment = "SMB" | "mid-market" | "enterprise";
type Status = "prospect" | "customer" | "churned";
// Planted behaviour groups apply to customers only.
type Group = "normal" | "underwater" | "declining" | "over_capacity" | "prospect" | "churned";

const STAGE_PROBABILITY = {
  Discovery: 10,
  Demo: 25,
  Proposal: 50,
  Negotiation: 70,
  "Closed Won": 100,
  "Closed Lost": 0,
} as const;
type Stage = keyof typeof STAGE_PROBABILITY;

function forecastCategory(stage: Stage): string {
  if (stage === "Discovery" || stage === "Demo") return "Pipeline";
  if (stage === "Proposal") return "Best Case";
  if (stage === "Negotiation") return "Commit";
  if (stage === "Closed Won") return "Closed";
  return "Omitted"; // Closed Lost
}

// ---------------------------------------------------------------------------
// Row types (match the database columns exactly)
// ---------------------------------------------------------------------------

type AccountRow = {
  id: string;
  name: string;
  status: Status;
  segment: Segment;
  plan: string | null;
  seats: number | null;
  mrr_usd: number;
  included_tokens_monthly: number;
  start_date: string | null;
  renewal_date: string | null;
  churn_date: string | null;
  owner: string;
};
type OpportunityRow = {
  id: string;
  account_id: string;
  type: "new" | "expansion" | "renewal";
  source: "inbound" | "outbound" | "partner" | "existing customer";
  stage: Stage;
  forecast_category: string;
  amount_usd: number;
  created_date: string;
  close_date: string;
  probability: number;
};
type InvoiceRow = { account_id: string; month: string; amount_usd: number; status: "paid" | "open" | "overdue" };
type UsageRow = {
  account_id: string;
  date: string;
  feature: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
};
type ModelPriceRow = {
  model: string;
  provider: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
  as_of: string;
};
type TicketRow = {
  id: string;
  account_id: string;
  opened_at: string;
  closed_at: string | null;
  severity: "low" | "medium" | "high" | "urgent";
  status: "open" | "pending" | "closed";
};
type NpsRow = { id: string; account_id: string; responded_at: string; score: number; comment: string | null };

// A change in an account's MRR: from `fromMonth` onward, MRR is `delta` higher
// than before (negative for a downgrade). Used to build invoice history.
type MrrChange = { fromMonth: Date; delta: number; kind: string };

// Extra facts the generator keeps about each account (not written to the database).
type AccountPlan = {
  row: AccountRow;
  index: number;
  group: Group;
  recentLand: boolean; // became a customer in the last 6 months
  billedMrr: number; // current MRR for customers; MRR before churn for churned accounts
  mrrChange: MrrChange | null; // at most one MRR change per account
  churnDate: Date | null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const roundTo = (n: number, step: number): number => Math.round(n / step) * step;
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

// Round to 2 significant figures, up or down (used for included token amounts).
function round2sig(n: number, direction: "up" | "down"): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return (direction === "up" ? Math.ceil(n / magnitude) : Math.floor(n / magnitude)) * magnitude;
}

function smbPlan(mrr: number): string {
  return mrr < 400 ? "Starter" : "Team";
}

// ---------------------------------------------------------------------------
// 1. Accounts
// ---------------------------------------------------------------------------

const CUSTOMER_COUNT = 150;
const PROSPECT_COUNT = 30;
const CHURNED_COUNT = 10;
const SEGMENT_COUNTS: Record<Segment, number> = { enterprise: 15, "mid-market": 45, SMB: 90 };
const GROUP_COUNTS = { underwater: 12, declining: 15, over_capacity: 15 };
const RECENT_LANDS = 8;

// Enterprise MRR before a small jitter. The largest ten make up roughly a third of ARR.
const ENTERPRISE_MRR = [14000, 12000, 10500, 9500, 8500, 8000, 7500, 7000, 6500, 6000, 5500, 5000, 4500, 4200, 4000];

function nextRenewal(start: Date): Date {
  let renewal = start;
  let years = 0;
  while (renewal.getTime() <= AS_OF.getTime()) renewal = addMonths(start, 12 * ++years);
  return renewal;
}

function buildAccounts(): AccountPlan[] {
  const rng = makeRng("accounts");

  // Which segment each customer id gets.
  const segments: Segment[] = rng.shuffle([
    ...Array<Segment>(SEGMENT_COUNTS.enterprise).fill("enterprise"),
    ...Array<Segment>(SEGMENT_COUNTS["mid-market"]).fill("mid-market"),
    ...Array<Segment>(SEGMENT_COUNTS.SMB).fill("SMB"),
  ]);

  // Unique company names for everyone (customers, then prospects, then churned).
  const allNames: string[] = [];
  for (const p of NAME_PREFIXES) for (const s of NAME_SUFFIXES) allNames.push(`${p} ${s}`);
  const names = makeRng("names").shuffle(allNames);

  // Customer groups (each customer is in at most one planted group).
  const groupRng = makeRng("groups");
  const order = groupRng.shuffle(Array.from({ length: CUSTOMER_COUNT }, (_, i) => i));
  const groups: Group[] = Array<Group>(CUSTOMER_COUNT).fill("normal");
  let cursor = 0;
  for (const [group, count] of Object.entries(GROUP_COUNTS) as [Group, number][]) {
    for (let k = 0; k < count; k++) groups[order[cursor++]] = group;
  }

  // The newest customers come from normal SMB and mid-market accounts.
  const landCandidates = makeRng("recent-lands").shuffle(
    Array.from({ length: CUSTOMER_COUNT }, (_, i) => i).filter((i) => groups[i] === "normal" && segments[i] !== "enterprise"),
  );
  const recentLandSet = new Set(landCandidates.slice(0, RECENT_LANDS));

  let enterpriseCursor = 0;
  const enterpriseMrr = makeRng("enterprise-mrr").shuffle(ENTERPRISE_MRR);

  const plans: AccountPlan[] = [];

  // --- Customers ---
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const segment = segments[i];
    const r = makeRng(`account:${i}`);

    let mrr: number;
    let plan: string;
    let pricePerSeat: number;
    if (segment === "enterprise") {
      mrr = roundTo(enterpriseMrr[enterpriseCursor++] * r.float(0.95, 1.05), 50);
      plan = "Enterprise";
      pricePerSeat = r.float(28, 40);
    } else if (segment === "mid-market") {
      mrr = roundTo(1500 + 2000 * Math.pow(r.next(), 1.3), 50);
      plan = "Growth";
      pricePerSeat = r.float(26, 36);
    } else {
      mrr = roundTo(150 + 650 * Math.pow(r.next(), 1.6), 10);
      plan = smbPlan(mrr);
      pricePerSeat = r.float(22, 32);
    }

    const recentLand = recentLandSet.has(i);
    // The newest customers started 95-170 days ago (so they still have 90 days
    // of usage); everyone else started between 6 months and about 3.5 years ago.
    const startOffsetDays = recentLand ? r.int(95, 170) : r.int(185, 1280);
    const start = addDays(AS_OF, -startOffsetDays);
    const owner = segment === "enterprise" ? r.pick(OWNERS_ENTERPRISE) : r.pick(OWNERS_OTHER);

    plans.push({
      index: i,
      group: groups[i],
      recentLand,
      billedMrr: mrr,
      mrrChange: null,
      churnDate: null,
      row: {
        id: `acc_${pad(i + 1, 4)}`,
        name: names[i],
        status: "customer",
        segment,
        plan,
        seats: Math.max(3, Math.round(mrr / pricePerSeat)),
        mrr_usd: mrr,
        included_tokens_monthly: 0, // set once usage is generated
        start_date: isoDate(start),
        renewal_date: isoDate(nextRenewal(start)), // annual contracts
        churn_date: null,
        owner,
      },
    });
  }

  // --- Prospects: no plan, MRR, usage or invoices ---
  for (let k = 0; k < PROSPECT_COUNT; k++) {
    const i = CUSTOMER_COUNT + k;
    const r = makeRng(`prospect:${k}`);
    const segment = r.weighted([["SMB", 0.5], ["mid-market", 0.35], ["enterprise", 0.15]] as const);
    plans.push({
      index: i,
      group: "prospect",
      recentLand: false,
      billedMrr: 0,
      mrrChange: null,
      churnDate: null,
      row: {
        id: `acc_${pad(i + 1, 4)}`,
        name: names[i],
        status: "prospect",
        segment,
        plan: null,
        seats: null,
        mrr_usd: 0,
        included_tokens_monthly: 0,
        start_date: null,
        renewal_date: null,
        churn_date: null,
        owner: segment === "enterprise" ? r.pick(OWNERS_ENTERPRISE) : r.pick(OWNERS_OTHER),
      },
    });
  }

  // --- Churned in the last 6 months: 6 SMB, 4 mid-market. Each one did not
  // renew, so it churned on a contract anniversary. MRR is now 0; the MRR it
  // used to pay lives in its invoices. ---
  for (let k = 0; k < CHURNED_COUNT; k++) {
    const i = CUSTOMER_COUNT + PROSPECT_COUNT + k;
    const r = makeRng(`churned:${k}`);
    const segment: Segment = k < 6 ? "SMB" : "mid-market";
    const formerMrr =
      segment === "SMB" ? roundTo(150 + 450 * Math.pow(r.next(), 1.6), 10) : roundTo(1500 + 1200 * r.next(), 50);
    const churnDate = addDays(AS_OF, -r.int(15, 175));
    const start = addMonths(churnDate, -12 * r.int(1, 3));
    plans.push({
      index: i,
      group: "churned",
      recentLand: false,
      billedMrr: formerMrr,
      mrrChange: null,
      churnDate,
      row: {
        id: `acc_${pad(i + 1, 4)}`,
        name: names[i],
        status: "churned",
        segment,
        plan: segment === "SMB" ? smbPlan(formerMrr) : "Growth",
        seats: Math.max(3, Math.round(formerMrr / r.float(24, 34))),
        mrr_usd: 0,
        included_tokens_monthly: 0, // set once usage is generated
        start_date: isoDate(start),
        renewal_date: null,
        churn_date: isoDate(churnDate),
        owner: r.pick(OWNERS_OTHER),
      },
    });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// 2. Daily usage (and each account's included tokens)
// ---------------------------------------------------------------------------

type Combo = { feature: Feature; model: ModelName; share: number; perToken: number };

function usageLevel(group: Group, growth: number, t: number, churnT: number): number {
  if (group === "declining") {
    // Flat for 30 days, then a slide: the last 30 days end up roughly 35% below
    // the 30 days before them, and about 40% below the first 30.
    if (t < 30) return 1;
    if (t < 60) return 1 - 0.2 * ((t - 30) / 29);
    return 0.72 - 0.27 * ((t - 60) / 29);
  }
  if (group === "churned") return 1 - 0.6 * (t / Math.max(churnT, 1)); // fading out before churn
  return 1 + growth * (t / (USAGE_DAYS - 1));
}

function buildUsage(accounts: AccountPlan[]): UsageRow[] {
  const rows: UsageRow[] = [];
  const churnedPlans: AccountPlan[] = [];

  for (const acc of accounts) {
    if (acc.group === "prospect") continue;
    const r = makeRng(`usage:${acc.index}`);
    const { group, row } = acc;

    // Which features and models this account uses.
    const featureCount =
      row.segment === "enterprise" ? r.int(3, 4) : row.segment === "mid-market" ? r.int(2, 3) : r.int(1, 2);
    const features = r.shuffle(FEATURES).slice(0, featureCount);
    const modelWeights: (readonly [ModelName, number])[] =
      group === "underwater"
        ? [["claude-opus-5-5", 0.6], ["claude-sonnet-5-5", 0.35], ["claude-haiku-5-5", 0.05]]
        : [["claude-opus-5-5", 0.12], ["claude-sonnet-5-5", 0.55], ["claude-haiku-5-5", 0.33]];

    const combos: Combo[] = [];
    for (const feature of features) {
      const modelCount = r.chance(0.4) ? 2 : 1;
      const chosen = new Set<ModelName>();
      while (chosen.size < modelCount) chosen.add(r.weighted(modelWeights));
      for (const model of chosen) {
        const price = PRICE_BY_MODEL.get(model)!;
        const perToken = ((1 - feature.outputShare) * price.input + feature.outputShare * price.output) / 1e6;
        combos.push({ feature, model, share: r.float(0.5, 1.5), perToken });
      }
    }
    const shareTotal = combos.reduce((s, c) => s + c.share, 0);
    for (const c of combos) c.share /= shareTotal;

    // Churned accounts only have usage up to their churn date.
    const churnT = acc.churnDate ? daysBetween(USAGE_START, acc.churnDate) : USAGE_DAYS;
    const activeDays = Math.max(0, Math.min(USAGE_DAYS, churnT));

    // Shape of usage over the window (before scaling to real volumes).
    const growth = group === "normal" ? r.float(-0.08, 0.25) : r.float(0, 0.12);
    const raw: number[][] = combos.map(() => []);
    for (let t = 0; t < USAGE_DAYS; t++) {
      const weekday = addDays(USAGE_START, t).getUTCDay();
      const weekFactor = weekday === 0 || weekday === 6 ? 0.45 : 1;
      const level = usageLevel(group, growth, t, churnT);
      combos.forEach((c, ci) => {
        raw[ci][t] = c.share * level * weekFactor * r.float(0.85, 1.15);
      });
    }

    // Scale so token cost is a target share of MRR. Customers: measured over the
    // last 30 days. Churned: per full-usage day, against the MRR they used to pay.
    const costRatio =
      group === "underwater"
        ? r.float(0.78, 1.15)
        : group === "over_capacity"
          ? r.float(0.3, 0.55)
          : group === "declining"
            ? r.float(0.1, 0.4)
            : group === "churned"
              ? r.float(0.15, 0.35)
              : r.float(0.12, 0.45);
    let scale: number;
    if (group === "churned") {
      const costPerUnit = combos.reduce((s, c) => s + c.share * c.perToken, 0);
      scale = (costRatio * acc.billedMrr) / 30 / costPerUnit;
    } else {
      let rawCostLast30 = 0;
      combos.forEach((c, ci) => {
        for (let t = USAGE_DAYS - 30; t < USAGE_DAYS; t++) rawCostLast30 += raw[ci][t] * c.perToken;
      });
      scale = (costRatio * acc.billedMrr) / rawCostLast30;
    }

    // Write the rows and total tokens per 30-day window.
    const windowTokens = [0, 0, 0];
    combos.forEach((c, ci) => {
      for (let t = 0; t < activeDays; t++) {
        const tokens = Math.max(1, Math.round(raw[ci][t] * scale));
        const outputTokens = Math.round(tokens * c.feature.outputShare);
        const requests = Math.max(1, Math.round((tokens / c.feature.tokensPerRequest) * r.float(0.9, 1.1)));
        windowTokens[Math.floor(t / 30)] += tokens;
        rows.push({
          account_id: row.id,
          date: isoDate(addDays(USAGE_START, t)),
          feature: c.feature.feature,
          model: c.model,
          requests,
          input_tokens: tokens - outputTokens,
          output_tokens: outputTokens,
        });
      }
    });

    // Included tokens. Over-capacity customers sit above it in every 30-day
    // window; every other customer stays below it in every window.
    if (group === "churned") {
      churnedPlans.push(acc);
    } else if (group === "over_capacity") {
      const utilisation = r.float(1.15, 1.4);
      row.included_tokens_monthly = round2sig(Math.min(...windowTokens) / utilisation, "down");
    } else {
      const utilisation = group === "underwater" ? r.float(0.8, 0.95) : r.float(0.55, 0.9);
      row.included_tokens_monthly = round2sig(Math.max(...windowTokens) / utilisation, "up");
    }
  }

  // Churned accounts kept the allowance of their old plan: the typical
  // tokens-per-dollar of normal customers, applied to the MRR they paid.
  const ratios = accounts
    .filter((a) => a.group === "normal")
    .map((a) => a.row.included_tokens_monthly / a.billedMrr)
    .sort((x, y) => x - y);
  const medianRatio = ratios[Math.floor(ratios.length / 2)];
  for (const acc of churnedPlans) {
    acc.row.included_tokens_monthly = round2sig(acc.billedMrr * medianRatio, "up");
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Opportunities (60 open, 80 closed in the last 6 months)
//    and the MRR changes that won deals and plan changes cause
// ---------------------------------------------------------------------------

function sourceFor(r: Rng, type: OpportunityRow["type"]): OpportunityRow["source"] {
  if (type === "renewal") return "existing customer";
  if (type === "expansion") {
    return r.weighted([["existing customer", 0.8], ["partner", 0.1], ["inbound", 0.1]] as const);
  }
  return r.weighted([["inbound", 0.45], ["outbound", 0.35], ["partner", 0.2]] as const);
}

// Typical first-year contract value for a prospect, by segment.
function prospectDealSize(r: Rng, segment: Segment): number {
  const monthly =
    segment === "enterprise" ? r.float(4000, 12000) : segment === "mid-market" ? r.float(1500, 3500) : r.float(150, 800);
  return roundTo(monthly * 12, 500);
}

// A plan change takes effect on the next month's invoice.
function effectiveMonth(changeDate: Date): Date {
  return monthStart(addMonths(changeDate, 1));
}

function buildOpportunitiesAndChanges(accounts: AccountPlan[]): OpportunityRow[] {
  const r = makeRng("opportunities");
  const opps: Omit<OpportunityRow, "id">[] = [];
  const make = (
    acc: AccountPlan,
    type: OpportunityRow["type"],
    stage: Stage,
    amount: number,
    created: Date,
    close: Date,
  ): void => {
    opps.push({
      account_id: acc.row.id,
      type,
      source: sourceFor(r, type),
      stage,
      forecast_category: forecastCategory(stage),
      amount_usd: round2(amount),
      created_date: isoDate(created),
      close_date: isoDate(close),
      probability: STAGE_PROBABILITY[stage],
    });
  };
  const setChange = (acc: AccountPlan, fromMonth: Date, delta: number, kind: string): void => {
    acc.mrrChange = { fromMonth, delta, kind };
  };

  const customers = accounts.filter((a) => a.row.status === "customer");
  const established = customers.filter((a) => !a.recentLand);
  const normalEstablished = established.filter((a) => a.group === "normal");
  const prospects = accounts.filter((a) => a.group === "prospect");
  const churned = accounts.filter((a) => a.group === "churned");
  const unchanged = (a: AccountPlan): boolean => a.mrrChange === null;

  // ================= Open (60): 22 renewal, 20 expansion, 18 new =================
  const renewingSoon = established.filter((a) => daysBetween(AS_OF, parseDate(a.row.renewal_date!)) <= 120);
  for (const acc of r.shuffle(renewingSoon).slice(0, 22)) {
    const renewal = parseDate(acc.row.renewal_date!);
    const daysOut = daysBetween(AS_OF, renewal);
    const stage: Stage = daysOut <= 30 ? "Negotiation" : daysOut <= 75 ? "Proposal" : "Discovery";
    make(acc, "renewal", stage, acc.row.mrr_usd * 12, addDays(AS_OF, -r.int(5, 40)), addDays(renewal, -r.int(0, 7)));
  }

  const expansionTargets = [
    ...customers.filter((a) => a.group === "over_capacity"),
    ...r.shuffle(normalEstablished).slice(0, 5),
  ];
  for (const acc of expansionTargets) {
    const stage = r.weighted([["Discovery", 0.3], ["Demo", 0.25], ["Proposal", 0.25], ["Negotiation", 0.2]] as const);
    const amount = roundTo(acc.row.mrr_usd * 12 * r.float(0.15, 0.5), 100);
    make(acc, "expansion", stage, amount, addDays(AS_OF, -r.int(5, 75)), addDays(AS_OF, r.int(10, 120)));
  }

  // Open new deals belong to prospects (18 different prospects).
  const prospectOrder = r.shuffle(prospects);
  for (const acc of prospectOrder.slice(0, 18)) {
    const stage = r.weighted([["Discovery", 0.4], ["Demo", 0.3], ["Proposal", 0.2], ["Negotiation", 0.1]] as const);
    make(acc, "new", stage, prospectDealSize(r, acc.row.segment), addDays(AS_OF, -r.int(5, 90)), addDays(AS_OF, r.int(20, 150)));
  }

  // ============ Closed in the last 6 months (80): 22 won, 58 lost ============
  // New, won (8): the deals that signed the newest customers.
  for (const acc of customers.filter((a) => a.recentLand)) {
    const close = addDays(parseDate(acc.row.start_date!), -r.int(3, 10));
    make(acc, "new", "Closed Won", acc.row.mrr_usd * 12, addDays(close, -r.int(30, 100)), close);
  }

  // New, lost (36): all prospects. The 12 prospects without an open deal get
  // one each, so every prospect has at least one deal; the rest are spread out.
  const lostNewOwners = [...prospectOrder.slice(18), ...Array.from({ length: 24 }, () => r.pick(prospects))];
  for (const acc of lostNewOwners) {
    const close = addDays(AS_OF, -r.int(5, 175));
    make(acc, "new", "Closed Lost", prospectDealSize(r, acc.row.segment), addDays(close, -r.int(30, 120)), close);
  }

  // Renewal, won (6): customers whose last anniversary fell in the last 6
  // months. Each renewed with a small price uplift.
  const recentlyRenewed = r
    .shuffle(
      established.filter((a) => {
        const ago = daysBetween(addMonths(parseDate(a.row.renewal_date!), -12), AS_OF);
        return ago >= 40 && ago <= 170;
      }),
    )
    .slice(0, 6);
  for (const acc of recentlyRenewed) {
    const lastAnniversary = addMonths(parseDate(acc.row.renewal_date!), -12);
    const close = addDays(lastAnniversary, -r.int(3, 10));
    make(acc, "renewal", "Closed Won", acc.row.mrr_usd * 12, addDays(close, -r.int(30, 60)), close);
    const before = round2(acc.row.mrr_usd / r.float(1.03, 1.08));
    setChange(acc, monthStart(lastAnniversary), round2(acc.row.mrr_usd - before), "renewal uplift");
  }

  // Renewal, lost (10): the churned accounts, closed at their churn date.
  for (const acc of churned) {
    const close = addDays(acc.churnDate!, -r.int(0, 10));
    make(acc, "renewal", "Closed Lost", acc.billedMrr * 12, addDays(close, -r.int(30, 60)), close);
  }

  // Expansion, won (8): normal customers that grew. Five closed in the last
  // 90 days (all already on an invoice), three earlier.
  const expanded = r
    .shuffle(normalEstablished.filter((a) => unchanged(a) && !expansionTargets.includes(a)))
    .slice(0, 8);
  expanded.forEach((acc, k) => {
    const close = addDays(AS_OF, k < 5 ? -r.int(35, 85) : -r.int(95, 170));
    const delta = roundTo(acc.row.mrr_usd * r.float(0.15, 0.3), 10);
    make(acc, "expansion", "Closed Won", delta * 12, addDays(close, -r.int(20, 75)), close);
    setChange(acc, effectiveMonth(close), delta, "expansion deal");
  });

  // Expansion, lost (12).
  for (let k = 0; k < 12; k++) {
    const acc = r.pick(established);
    const close = addDays(AS_OF, -r.int(5, 175));
    const amount = roundTo(acc.row.mrr_usd * 12 * r.float(0.1, 0.4), 100);
    make(acc, "expansion", "Closed Lost", amount, addDays(close, -r.int(20, 75)), close);
  }

  // ===== Plan changes without a deal (self-serve), all reflected in invoices =====
  const m = makeRng("plan-changes");

  // Upgrades in the last 90 days (4): SMB customers moving from Starter up to Team.
  const upgraded = m
    .shuffle(normalEstablished.filter((a) => unchanged(a) && a.row.segment === "SMB" && a.row.plan === "Team"))
    .slice(0, 4);
  for (const acc of upgraded) {
    const before = roundTo(Math.min(390, acc.row.mrr_usd * m.float(0.55, 0.75)), 10);
    setChange(acc, effectiveMonth(addDays(AS_OF, -m.int(35, 85))), acc.row.mrr_usd - before, "self-serve upgrade");
  }

  // Downgrades in the last 90 days (5): 3 declining customers and 2 normal ones
  // cut seats. Their current MRR is lower than before.
  const downgraded = [
    ...m.shuffle(established.filter((a) => unchanged(a) && a.group === "declining")).slice(0, 3),
    ...m.shuffle(normalEstablished.filter((a) => unchanged(a) && !upgraded.includes(a))).slice(0, 2),
  ];
  for (const acc of downgraded) {
    const before = roundTo(acc.row.mrr_usd / m.float(0.7, 0.85), 10);
    setChange(acc, effectiveMonth(addDays(AS_OF, -m.int(35, 85))), acc.row.mrr_usd - before, "downgrade");
  }

  // Seat growth earlier in the year (no deal): many customers added seats as
  // they rolled out wider. These changes land 4-12 months ago.
  const growers = m
    .shuffle(established.filter((a) => unchanged(a) && a.group !== "declining"))
    .slice(0, SEAT_GROWTH_ACCOUNTS);
  for (const acc of growers) {
    const before = roundTo(acc.row.mrr_usd * m.float(0.6, 0.85), 10);
    setChange(acc, addMonths(CURRENT_MONTH, -m.int(4, 11)), acc.row.mrr_usd - before, "seat growth");
  }

  return opps.map((o, i) => ({ id: `opp_${pad(i + 1, 4)}`, ...o }));
}

// Tuned so 12-month NRR lands around 105-115%, typical for a growing AI startup.
const SEAT_GROWTH_ACCOUNTS = 70;

// ---------------------------------------------------------------------------
// 4. Invoices (13 months, one per account per month while it was a customer)
// ---------------------------------------------------------------------------

function buildInvoices(accounts: AccountPlan[]): InvoiceRow[] {
  const rows: InvoiceRow[] = [];
  for (const acc of accounts) {
    if (acc.group === "prospect") continue;
    const r = makeRng(`invoices:${acc.index}`);
    const startMonth = monthStart(parseDate(acc.row.start_date!));
    // Churned accounts are billed up to the month before they churned.
    const lastMonth = acc.churnDate ? addMonths(monthStart(acc.churnDate), -1) : CURRENT_MONTH;
    let month = startMonth.getTime() > FIRST_INVOICE_MONTH.getTime() ? startMonth : FIRST_INVOICE_MONTH;
    while (month.getTime() <= lastMonth.getTime()) {
      const change = acc.mrrChange;
      const mrr = change && month.getTime() < change.fromMonth.getTime() ? acc.billedMrr - change.delta : acc.billedMrr;

      const isCurrent = month.getTime() === CURRENT_MONTH.getTime();
      const isPrevious = month.getTime() === addMonths(CURRENT_MONTH, -1).getTime();
      const overdueChance = acc.group === "declining" ? 0.3 : 0.05;
      // Draw both numbers every month so the random stream never depends on which branch ran.
      const a = r.next();
      const b = r.next();
      const status: InvoiceRow["status"] = isCurrent
        ? a < 0.55
          ? "paid"
          : "open"
        : isPrevious && b < overdueChance
          ? "overdue"
          : "paid";

      rows.push({ account_id: acc.row.id, month: isoDate(month), amount_usd: round2(mrr), status });
      month = addMonths(month, 1);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 5. Support tickets and NPS (declining and churned accounts skew negative)
// ---------------------------------------------------------------------------

const SEVERITY_NORMAL = [["low", 0.45], ["medium", 0.35], ["high", 0.15], ["urgent", 0.05]] as const;
const SEVERITY_UNHAPPY = [["low", 0.2], ["medium", 0.35], ["high", 0.3], ["urgent", 0.15]] as const;
const RESOLUTION_HOURS: Record<TicketRow["severity"], [number, number]> = {
  low: [4, 96],
  medium: [8, 120],
  high: [2, 48],
  urgent: [1, 12],
};

const isUnhappy = (acc: AccountPlan): boolean => acc.group === "declining" || acc.group === "churned";

function buildTickets(accounts: AccountPlan[]): TicketRow[] {
  const rows: Omit<TicketRow, "id">[] = [];
  for (const acc of accounts) {
    if (acc.group === "prospect") continue;
    const r = makeRng(`tickets:${acc.index}`);
    // Tickets cover the 6 months up to today, or up to the churn date.
    const end = acc.churnDate ?? AS_OF;
    const perMonth = acc.row.segment === "enterprise" ? 2.5 : acc.row.segment === "mid-market" ? 1.0 : 0.4;
    const multiplier = isUnhappy(acc) ? 2.5 : acc.group === "over_capacity" ? 1.3 : 1;
    const count = Math.round(perMonth * 6 * multiplier * r.float(0.6, 1.4));
    const tickets: Omit<TicketRow, "id">[] = [];
    for (let k = 0; k < count; k++) {
      // Unhappy accounts' tickets bunch up in recent weeks (or the weeks before churn).
      const recency = isUnhappy(acc) ? Math.pow(r.next(), 1.8) : r.next();
      const daysAgo = 1 + Math.floor(recency * 179);
      const opened = new Date(addDays(end, -daysAgo).getTime() + r.int(8, 20) * 3_600_000 + r.int(0, 59) * 60_000);
      const severity = r.weighted(isUnhappy(acc) ? SEVERITY_UNHAPPY : SEVERITY_NORMAL);
      const [minH, maxH] = RESOLUTION_HOURS[severity];
      const closed = new Date(opened.getTime() + r.float(minH, maxH) * 3_600_000);
      const pendingRoll = r.next();
      // Churned accounts' tickets were all closed when they left.
      const stillOpen = !acc.churnDate && closed.getTime() > AS_OF.getTime();
      tickets.push({
        account_id: acc.row.id,
        opened_at: opened.toISOString(),
        closed_at: stillOpen ? null : closed.toISOString(),
        severity,
        status: stillOpen ? (pendingRoll < 0.4 ? "pending" : "open") : "closed",
      });
    }
    tickets.sort((x, y) => x.opened_at.localeCompare(y.opened_at));
    rows.push(...tickets);
  }
  return rows.map((t, i) => ({ id: `tkt_${pad(i + 1, 5)}`, ...t }));
}

const NPS_NORMAL = [[10, 0.24], [9, 0.25], [8, 0.2], [7, 0.15], [6, 0.07], [5, 0.04], [4, 0.02], [3, 0.03]] as const;
const NPS_UNHAPPY = [[9, 0.03], [8, 0.07], [7, 0.1], [6, 0.15], [5, 0.18], [4, 0.17], [3, 0.15], [2, 0.1], [1, 0.05]] as const;

const COMMENTS_PROMOTER = [
  "Document summaries save our team hours every week.",
  "Setup was quick and support has been responsive.",
  "Extraction accuracy is excellent on our contracts.",
  "Our engineers rely on code review every day now.",
  "Great product, and the roadmap looks strong.",
  "Easy to roll out across teams.",
];
const COMMENTS_PASSIVE = [
  "Works well, but we keep hitting our token limit.",
  "Good overall. Reporting could be better.",
  "Solid, though pricing is hard to predict month to month.",
  "Useful, but responses can be slow at peak times.",
  "Does the job. Would like more admin controls.",
];
const COMMENTS_DETRACTOR = [
  "Usage dropped after our champion left. Hard to justify the cost.",
  "Too many errors on long documents lately.",
  "We are evaluating building this in-house.",
  "Support tickets take too long to resolve.",
  "Price went up but the value has not.",
  "Our team stopped using it after the last release.",
];

function buildNps(accounts: AccountPlan[]): NpsRow[] {
  const rows: Omit<NpsRow, "id">[] = [];
  for (const acc of accounts) {
    if (acc.group === "prospect") continue;
    const r = makeRng(`nps:${acc.index}`);
    const unhappy = isUnhappy(acc);
    const end = acc.churnDate ?? AS_OF;
    let count =
      acc.row.segment === "enterprise" ? r.int(2, 4) : acc.row.segment === "mid-market" ? r.int(1, 2) : r.chance(0.6) ? 1 : 0;
    if (unhappy) count = Math.max(count, 1);
    const responses: Omit<NpsRow, "id">[] = [];
    for (let k = 0; k < count; k++) {
      // Unhappy accounts always have a response in the 60 days before today (or churn).
      const daysAgo = unhappy && k === 0 ? r.int(1, 60) : r.int(1, 180);
      const at = new Date(addDays(end, -daysAgo).getTime() + r.int(9, 18) * 3_600_000 + r.int(0, 59) * 60_000);
      const score = r.weighted(unhappy ? NPS_UNHAPPY : NPS_NORMAL);
      const pool = score >= 9 ? COMMENTS_PROMOTER : score >= 7 ? COMMENTS_PASSIVE : COMMENTS_DETRACTOR;
      const comment = r.pick(pool);
      const hasComment = r.chance(0.7);
      responses.push({ account_id: acc.row.id, responded_at: at.toISOString(), score, comment: hasComment ? comment : null });
    }
    responses.sort((x, y) => x.responded_at.localeCompare(y.responded_at));
    rows.push(...responses);
  }
  return rows.map((n, i) => ({ id: `nps_${pad(i + 1, 5)}`, ...n }));
}

// ---------------------------------------------------------------------------
// Self-check: prints the numbers so the owner can confirm the data is right
// ---------------------------------------------------------------------------

type Dataset = {
  accounts: AccountPlan[];
  modelPrices: ModelPriceRow[];
  opportunities: OpportunityRow[];
  invoices: InvoiceRow[];
  usage: UsageRow[];
  tickets: TicketRow[];
  nps: NpsRow[];
};

function printCheck(d: Dataset): void {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
  const yesNo = (ok: boolean): string => (ok ? "yes" : "NO");
  const allRows = d.accounts.map((a) => a.row);
  const customers = allRows.filter((a) => a.status === "customer");
  const statusOf = new Map(allRows.map((a) => [a.id, a.status]));
  const countBy = <T>(items: T[], key: (x: T) => string): string => {
    const m = new Map<string, number>();
    for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
    return [...m.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
  };

  // Tokens and cost per customer per 30-day window (window 2 = last 30 days).
  const windows = new Map<string, { tokens: number[]; costLast30: number }>();
  for (const a of customers) windows.set(a.id, { tokens: [0, 0, 0], costLast30: 0 });
  for (const u of d.usage) {
    const w = windows.get(u.account_id);
    if (!w) continue;
    const win = Math.floor(daysBetween(USAGE_START, parseDate(u.date)) / 30);
    w.tokens[win] += u.input_tokens + u.output_tokens;
    if (win === 2) {
      const p = PRICE_BY_MODEL.get(u.model)!;
      w.costLast30 += (u.input_tokens * p.input + u.output_tokens * p.output) / 1e6;
    }
  }
  const underwater = customers.filter((a) => windows.get(a.id)!.costLast30 > 0.7 * a.mrr_usd);
  const declining = customers.filter((a) => {
    const w = windows.get(a.id)!.tokens;
    return w[2] < 0.8 * w[1];
  });
  const decliningVsFirst = customers.filter((a) => {
    const w = windows.get(a.id)!.tokens;
    return w[2] < 0.8 * w[0];
  });
  const overCapacity = customers.filter((a) => windows.get(a.id)!.tokens.every((t) => t > a.included_tokens_monthly));
  const ids = (xs: AccountRow[]): Set<string> => new Set(xs.map((a) => a.id));
  const uw = ids(underwater), dc = ids(declining), oc = ids(overCapacity);
  const overlap = [...uw].filter((x) => dc.has(x) || oc.has(x)).length + [...dc].filter((x) => oc.has(x)).length;

  const mrrSorted = customers.map((a) => a.mrr_usd).sort((x, y) => y - x);
  const totalMrr = mrrSorted.reduce((s, x) => s + x, 0);
  const top10 = mrrSorted.slice(0, 10).reduce((s, x) => s + x, 0);
  const horizon = addMonths(AS_OF, 12).getTime();
  const renewalsOk = customers.every((a) => {
    const t = parseDate(a.renewal_date!).getTime();
    return t > AS_OF.getTime() && t <= horizon;
  });

  // Prospects and churned accounts.
  const prospectIds = new Set(allRows.filter((a) => a.status === "prospect").map((a) => a.id));
  const churnedRows = allRows.filter((a) => a.status === "churned");
  const prospectRowsElsewhere =
    d.usage.filter((u) => prospectIds.has(u.account_id)).length +
    d.invoices.filter((i) => prospectIds.has(i.account_id)).length +
    d.tickets.filter((t) => prospectIds.has(t.account_id)).length +
    d.nps.filter((n) => prospectIds.has(n.account_id)).length;
  const churnDateOf = new Map(churnedRows.map((a) => [a.id, a.churn_date!]));
  const invoicesAfterChurn = d.invoices.filter((i) => {
    const c = churnDateOf.get(i.account_id);
    return c !== undefined && i.month >= isoDate(monthStart(parseDate(c)));
  }).length;
  const usageAfterChurn = d.usage.filter((u) => {
    const c = churnDateOf.get(u.account_id);
    return c !== undefined && u.date >= c;
  }).length;
  const churnWithin6Months = churnedRows.every((a) => daysBetween(parseDate(a.churn_date!), AS_OF) <= 183);
  const churnedArr = d.accounts.filter((a) => a.group === "churned").reduce((s, a) => s + a.billedMrr * 12, 0);

  // Revenue movement from invoices.
  const invoiceAmount = new Map<string, number>();
  for (const i of d.invoices) invoiceAmount.set(`${i.account_id}|${i.month}`, i.amount_usd);
  const m0 = isoDate(FIRST_INVOICE_MONTH);
  const m1 = isoDate(CURRENT_MONTH);
  let base = 0, kept = 0, keptCapped = 0;
  for (const a of allRows) {
    const start = invoiceAmount.get(`${a.id}|${m0}`);
    if (start === undefined) continue;
    const now = invoiceAmount.get(`${a.id}|${m1}`) ?? 0;
    base += start;
    kept += now;
    keptCapped += Math.min(now, start);
  }
  const recentMonths = [0, 1, 2].map((k) => isoDate(addMonths(CURRENT_MONTH, -k)));
  let ups = 0, downs = 0;
  for (const a of customers) {
    let up = false, down = false;
    for (const month of recentMonths) {
      const now = invoiceAmount.get(`${a.id}|${month}`);
      const before = invoiceAmount.get(`${a.id}|${isoDate(addMonths(parseDate(month), -1))}`);
      if (now === undefined || before === undefined) continue;
      if (now > before) up = true;
      if (now < before) down = true;
    }
    if (up) ups++;
    if (down) downs++;
  }
  const changeKinds = countBy(
    d.accounts.filter((a) => a.mrrChange),
    (a) => a.mrrChange!.kind,
  );

  // Opportunities.
  const isOpen = (o: OpportunityRow): boolean => o.stage !== "Closed Won" && o.stage !== "Closed Lost";
  const open = d.opportunities.filter(isOpen);
  const closed = d.opportunities.filter((o) => !isOpen(o));
  const won = closed.filter((o) => o.stage === "Closed Won");
  const newOpen = open.filter((o) => o.type === "new");
  const newLost = closed.filter((o) => o.type === "new" && o.stage === "Closed Lost");
  const newWon = closed.filter((o) => o.type === "new" && o.stage === "Closed Won");
  const allProspect = (os: OpportunityRow[]): boolean => os.every((o) => statusOf.get(o.account_id) === "prospect");
  const prospectsWithDeal = new Set(d.opportunities.filter((o) => prospectIds.has(o.account_id)).map((o) => o.account_id));
  const lostForecastOk = closed
    .filter((o) => o.stage === "Closed Lost")
    .every((o) => o.forecast_category === "Omitted");

  // Customer signals.
  const unhappyIds = new Set(d.accounts.filter(isUnhappy).map((a) => a.row.id));
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const npsUnhappy = avg(d.nps.filter((n) => unhappyIds.has(n.account_id)).map((n) => n.score));
  const npsOther = avg(d.nps.filter((n) => !unhappyIds.has(n.account_id)).map((n) => n.score));
  const ticketsUnhappy = d.tickets.filter((t) => unhappyIds.has(t.account_id)).length / unhappyIds.size;
  const otherCount = allRows.length - prospectIds.size - unhappyIds.size;
  const ticketsOther = d.tickets.filter((t) => !unhappyIds.has(t.account_id)).length / otherCount;

  const usageDates = new Set(d.usage.map((u) => u.date));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([allRows, d.modelPrices, d.opportunities, d.invoices, d.usage, d.tickets, d.nps]))
    .digest("hex")
    .slice(0, 12);

  console.log(`\nLumen AI seed check (as-of date ${AS_OF_DATE})`);
  console.log("(Seed self-check only. The app's official metrics come from src/lib/metrics.ts.)\n");
  console.log("Rows");
  console.log(`  accounts         ${allRows.length}`);
  console.log(`  model_prices     ${d.modelPrices.length}`);
  console.log(`  opportunities    ${d.opportunities.length}`);
  console.log(`  invoices         ${d.invoices.length}`);
  console.log(`  usage_daily      ${d.usage.length}`);
  console.log(`  support_tickets  ${d.tickets.length}`);
  console.log(`  nps_responses    ${d.nps.length}`);
  console.log("\nAccounts");
  console.log(`  by status: ${countBy(allRows, (a) => a.status)}`);
  console.log(`  customers by segment: ${countBy(customers, (a) => a.segment)}`);
  console.log(`  customer ARR ${usd(totalMrr * 12)}; top 10 customers = ${pct(top10 / totalMrr)} of ARR`);
  console.log(`  every customer renewal date within the next 12 months: ${yesNo(renewalsOk)}`);
  console.log(`  prospects: rows in usage/invoices/tickets/NPS = ${prospectRowsElsewhere}; prospects with a deal = ${prospectsWithDeal.size}`);
  console.log(`  churned: all within the last 6 months ${yesNo(churnWithin6Months)}; ` +
    `invoices on/after churn month ${invoicesAfterChurn}; usage on/after churn date ${usageAfterChurn}; ARR lost ${usd(churnedArr)}`);
  console.log("\nUsage (customers)");
  console.log(`  days of usage: ${usageDates.size} (${isoDate(USAGE_START)} to ${isoDate(addDays(AS_OF, -1))})`);
  console.log(`  underwater (last-30-day token cost > 70% of MRR): ${underwater.length}`);
  console.log(`  declining (last 30 days > 20% below the 30 before): ${declining.length}` +
    ` (vs first 30 days: ${decliningVsFirst.length})`);
  console.log(`  over capacity (above included tokens in all three 30-day windows): ${overCapacity.length}`);
  console.log(`  customers in more than one of those groups: ${overlap}`);
  console.log("\nRevenue movement (from invoices)");
  console.log(`  12-month NRR (${m0} -> ${m1}): ${pct(kept / base)}; GRR: ${pct(keptCapped / base)}`);
  console.log(`  customers whose invoice went up / down in the last 3 months: ${ups} up, ${downs} down`);
  console.log(`  MRR changes by kind: ${changeKinds}`);
  console.log("\nOpportunities");
  console.log(`  open: ${open.length} (${countBy(open, (o) => o.type)})`);
  console.log(`  open by source: ${countBy(open, (o) => o.source)}`);
  console.log(`  open pipeline: ${usd(open.reduce((s, o) => s + o.amount_usd, 0))}`);
  console.log(`  closed in last 6 months: ${closed.length}; won ${won.length}; win rate ${pct(won.length / closed.length)}`);
  console.log(`  closed by type: ${countBy(closed, (o) => `${o.type} ${o.stage === "Closed Won" ? "won" : "lost"}`)}`);
  console.log(`  open and lost new deals all on prospects: ${yesNo(allProspect(newOpen) && allProspect(newLost))}; ` +
    `won new deals all on customers: ${yesNo(newWon.every((o) => statusOf.get(o.account_id) === "customer"))}`);
  console.log(`  every Closed Lost deal has forecast category Omitted: ${yesNo(lostForecastOk)}`);
  console.log("\nCustomer signals");
  console.log(`  average NPS score: declining and churned accounts ${npsUnhappy.toFixed(1)}, others ${npsOther.toFixed(1)}`);
  console.log(`  tickets per account (6 months): declining and churned ${ticketsUnhappy.toFixed(1)}, others ${ticketsOther.toFixed(1)}`);
  console.log(`\nData fingerprint: ${fingerprint} (same value on every run = identical data)\n`);
}

// ---------------------------------------------------------------------------
// Writing to Supabase
// ---------------------------------------------------------------------------

const BATCH = 1000;

async function insertAll(db: SupabaseClient, table: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db.from(table).insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`Inserting into ${table} failed: ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

async function clear(db: SupabaseClient, table: string, column: string): Promise<void> {
  // Supabase requires a filter on deletes; "column is not null" matches every row.
  const { error } = await db.from(table).delete().not(column, "is", null);
  if (error) throw new Error(`Clearing ${table} failed: ${error.message}`);
}

async function writeToSupabase(d: Dataset): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing from .env.local: ${missing.join(", ")}. Nothing was written.`);
  }
  const db = createClient(url!, key!, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log("Clearing seeded tables (accounts are updated in place, not deleted)...");
  for (const [table, column] of [
    ["usage_daily", "account_id"],
    ["invoices", "account_id"],
    ["opportunities", "id"],
    ["support_tickets", "id"],
    ["nps_responses", "id"],
    ["model_prices", "model"],
  ] as const) {
    await clear(db, table, column);
  }

  console.log("Writing...");
  const accountRows = d.accounts.map((a) => a.row);
  for (let i = 0; i < accountRows.length; i += BATCH) {
    const { error } = await db.from("accounts").upsert(accountRows.slice(i, i + BATCH), { onConflict: "id" });
    if (error) throw new Error(`Writing accounts failed: ${error.message}`);
  }
  console.log(`  accounts: ${accountRows.length} rows`);
  await insertAll(db, "model_prices", d.modelPrices);
  await insertAll(db, "opportunities", d.opportunities);
  await insertAll(db, "invoices", d.invoices);
  await insertAll(db, "usage_daily", d.usage);
  await insertAll(db, "support_tickets", d.tickets);
  await insertAll(db, "nps_responses", d.nps);
  console.log("Done.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const accounts = buildAccounts();
  const usage = buildUsage(accounts);
  const opportunities = buildOpportunitiesAndChanges(accounts); // also records MRR changes used by invoices
  const invoices = buildInvoices(accounts);
  const tickets = buildTickets(accounts);
  const nps = buildNps(accounts);
  const modelPrices: ModelPriceRow[] = MODEL_PRICES.map((p) => ({
    model: p.model,
    provider: p.provider,
    input_usd_per_million: p.input,
    output_usd_per_million: p.output,
    as_of: AS_OF_DATE,
  }));

  const data: Dataset = { accounts, modelPrices, opportunities, invoices, usage, tickets, nps };
  printCheck(data);

  if (dryRun) {
    console.log("Dry run: nothing was written to the database.");
    return;
  }
  await writeToSupabase(data);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
