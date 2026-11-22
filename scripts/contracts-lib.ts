/**
 * Builds the contract layer for Cockpit (built for Lumen AI) from data that
 * already exists: contract lines, daily active users and renewal-deal links.
 *
 * Used by `npm run contracts:backfill` (reads the live rows) and by
 * `npm run seed` (passes the rows it has just generated), so both always
 * produce the same result for the same data.
 *
 * Pure functions: no database, no real clock. Every random number comes from
 * a fixed seed per account, so the same input always gives the same output.
 * This file only shapes demo data; the app's business math stays in
 * src/lib/metrics.ts.
 */

// ---------------------------------------------------------------------------
// Products: each usage feature belongs to exactly one product
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { PRODUCTS, PRODUCT_OF_FEATURE, type Product } from "../src/lib/metrics.ts";

export { PRODUCTS, PRODUCT_OF_FEATURE, type Product };
export const BASE_PRODUCT: Product = "Core";

const PRODUCT_CODE: Record<Product, string> = { Core: "core", Extract: "extract", "Code Review": "code-review" };

// Rules (agreed with the owner, 21 Nov 2026)
const ADDON_SHARE = [0.1, 0.3] as const; // each add-on's share of ARR when Core is used
const UNUSED_CORE_SHARE = [0.1, 0.15] as const; // Core's share when the customer never uses Core features
const ROUND_TO_USD = 120; // add-on and small-Core amounts round to $120 a year ($10 a month)
const MID_CONTRACT_CHANCE = 1 / 3; // share of add-ons bought after the contract started
const AUTO_RENEW_CHANCE: Record<string, number> = { SMB: 0.85, "mid-market": 0.6, enterprise: 0.25 };
const USER_SHARE: Record<Product, readonly [number, number]> = {
  // share of seats using a feature on a normal weekday
  Core: [0.2, 0.45],
  Extract: [0.08, 0.25],
  "Code Review": [0.08, 0.25],
};
const USERS_PER_USAGE_EXPONENT = 0.8; // users move a little less than tokens do

// ---------------------------------------------------------------------------
// Input and output rows
// ---------------------------------------------------------------------------

export type ContractAccount = {
  id: string;
  status: "prospect" | "customer" | "churned";
  segment: string;
  seats: number | null;
  mrr_usd: number;
  included_tokens_monthly: number;
  start_date: string | null;
  renewal_date: string | null;
  churn_date: string | null;
};
export type ContractUsage = {
  account_id: string;
  date: string;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
};
export type ContractOpportunity = { id: string; account_id: string; type: string; stage: string; close_date: string };
export type ContractInvoice = { account_id: string; month: string; amount_usd: number };

export type ContractLineRow = {
  id: string;
  account_id: string;
  contract_id: string;
  product: Product;
  quantity: number;
  unit_price_usd: number;
  arr_usd: number;
  purchase_date: string;
  renewal_date: string;
  term_months: number;
  auto_renew: boolean;
  status: "active" | "expired" | "churned";
  included_tokens_monthly: number;
};

export type ContractLayer = {
  lines: ContractLineRow[];
  /** active_users for each usage row, keyed by usageKey(row). */
  activeUsers: Map<string, number>;
  /** contract_id for each renewal deal, keyed by opportunity id. */
  dealContract: Map<string, string>;
  /** Customers who own Core but never used its features (shelfware). */
  unusedCore: string[];
};

export const usageKey = (u: Pick<ContractUsage, "account_id" | "date" | "feature" | "model">) =>
  `${u.account_id}|${u.date}|${u.feature}|${u.model}`;

export const contractIdFor = (accountId: string) => accountId.replace(/^acc_/, "ctr_");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED = "lumen-ai-contracts-v1";

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
    float: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    chance: (p: number) => next() < p,
  };
}

const DAY_MS = 86_400_000;
const toDate = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(toDate(s).getTime() + n * DAY_MS));
function addMonths(s: string, months: number): string {
  const d = toDate(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay))));
}
const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS);
const roundTo = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);
const cents = (n: number) => Math.round(n * 100) / 100;

/** Splits a whole number across weights; the parts add up exactly. */
function splitWhole(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (sum > 0 ? (total * w) / sum : total / weights.length));
  const out = raw.map(Math.floor);
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ---------------------------------------------------------------------------
// Contract lines
// ---------------------------------------------------------------------------

/** ARR per product, in whole dollars, adding up exactly to `arr`. */
function splitArr(arr: number, products: Product[], coreUsed: boolean, tokenShare: Map<Product, number>, r: ReturnType<typeof makeRng>): Map<Product, number> {
  const out = new Map<Product, number>();
  const addOns = products.filter((p) => p !== BASE_PRODUCT);
  if (addOns.length === 0) {
    out.set(BASE_PRODUCT, arr);
    return out;
  }
  if (coreUsed) {
    // Add-ons get 10-30% each (rounded to $120); Core gets the exact remainder.
    let given = 0;
    for (const p of addOns) {
      const v = Math.min(roundTo(arr * r.float(...ADDON_SHARE), ROUND_TO_USD), arr - given - ROUND_TO_USD);
      out.set(p, v);
      given += v;
    }
    out.set(BASE_PRODUCT, arr - given);
  } else {
    // Shelfware Core is a small line (10-15%); the rest goes to the add-ons used, by their usage.
    const core = Math.min(roundTo(arr * r.float(...UNUSED_CORE_SHARE), ROUND_TO_USD), arr - ROUND_TO_USD * addOns.length);
    out.set(BASE_PRODUCT, core);
    let rest = arr - core;
    addOns.forEach((p, i) => {
      if (i === addOns.length - 1) {
        out.set(p, rest);
      } else {
        const share = (tokenShare.get(p) ?? 0) / addOns.reduce((s, q) => s + (tokenShare.get(q) ?? 0), 0);
        const v = Math.min(roundTo((arr - core) * share, ROUND_TO_USD), rest - ROUND_TO_USD);
        out.set(p, v);
        rest -= v;
      }
    });
  }
  return out;
}

function buildLines(
  a: ContractAccount,
  arr: number,
  renewalDate: string,
  status: ContractLineRow["status"],
  tokensByProduct: Map<Product, number>,
  expansionDates: string[],
  usageStart: string,
): { lines: ContractLineRow[]; coreUsed: boolean } {
  const r = makeRng(`lines:${a.id}`);
  const used = PRODUCTS.filter((p) => (tokensByProduct.get(p) ?? 0) > 0);
  const coreUsed = used.includes(BASE_PRODUCT);
  const products = PRODUCTS.filter((p) => p === BASE_PRODUCT || used.includes(p));
  const totalTokens = [...tokensByProduct.values()].reduce((s, x) => s + x, 0);
  const tokenShare = new Map(products.map((p) => [p, totalTokens > 0 ? (tokensByProduct.get(p) ?? 0) / totalTokens : 0]));

  const arrBy = splitArr(arr, products, coreUsed, tokenShare, r);

  // Included tokens: unused Core keeps a slice in line with its ARR; used lines split the rest by usage.
  const allowance = a.included_tokens_monthly;
  const tokensBy = new Map<Product, number>();
  const unusedCoreTokens = coreUsed ? 0 : Math.round(allowance * ((arrBy.get(BASE_PRODUCT) ?? 0) / arr));
  const usedProducts = products.filter((p) => p !== BASE_PRODUCT || coreUsed);
  splitWhole(allowance - unusedCoreTokens, usedProducts.map((p) => tokensByProduct.get(p) ?? 0)).forEach((v, i) => tokensBy.set(usedProducts[i], v));
  if (!coreUsed) tokensBy.set(BASE_PRODUCT, unusedCoreTokens);

  const contractId = contractIdFor(a.id);
  const contractStart = addMonths(renewalDate, -12);
  const autoRenew = r.chance(AUTO_RENEW_CHANCE[a.segment] ?? 0.5);
  // An add-on bought mid-contract must predate the usage window, so it has usage from day one.
  const latestMidPurchase = usageStart < renewalDate ? usageStart : addDays(renewalDate, -1);
  const canBuyMid = daysBetween(contractStart, latestMidPurchase) >= 30;
  const expansions = expansionDates.filter((d) => d > contractStart && d <= latestMidPurchase).sort();

  const lines = products.map((p): ContractLineRow => {
    let purchase = contractStart;
    if (p !== BASE_PRODUCT) {
      const mid = r.next(); // always drawn, so the random stream doesn't depend on branches
      const pickDay = r.next();
      if (expansions.length > 0) {
        purchase = expansions.shift()!;
      } else if (canBuyMid && mid < MID_CONTRACT_CHANCE) {
        purchase = addDays(contractStart, 30 + Math.floor(pickDay * (daysBetween(contractStart, latestMidPurchase) - 30 + 1)));
      }
    }
    const lineArr = arrBy.get(p)!;
    const quantity = p === BASE_PRODUCT ? Math.max(1, a.seats ?? 1) : 1;
    return {
      id: `${contractId}-${PRODUCT_CODE[p]}`,
      account_id: a.id,
      contract_id: contractId,
      product: p,
      quantity,
      unit_price_usd: cents(lineArr / quantity),
      arr_usd: lineArr,
      purchase_date: purchase,
      renewal_date: renewalDate,
      term_months: Math.max(1, Math.round(daysBetween(purchase, renewalDate) / 30.4375)),
      auto_renew: autoRenew,
      status,
      included_tokens_monthly: tokensBy.get(p) ?? 0,
    };
  });
  return { lines, coreUsed };
}

// ---------------------------------------------------------------------------
// Daily active users
// ---------------------------------------------------------------------------

function buildActiveUsers(a: ContractAccount, rows: ContractUsage[], usageStart: string, out: Map<string, number>): void {
  const seats = Math.max(1, a.seats ?? 1);
  const r = makeRng(`users:${a.id}`);

  // Tokens per feature per day (summed over models)
  const byFeatureDay = new Map<string, Map<string, number>>();
  for (const u of rows) {
    const days = byFeatureDay.get(u.feature) ?? new Map<string, number>();
    days.set(u.date, (days.get(u.date) ?? 0) + u.input_tokens + u.output_tokens);
    byFeatureDay.set(u.feature, days);
  }
  const features = [...byFeatureDay.keys()].sort();

  // Each feature's normal level: median weekday tokens in the first 30 days of usage.
  const share = new Map<string, number>();
  const baseline = new Map<string, number>();
  for (const f of features) {
    share.set(f, r.float(...USER_SHARE[PRODUCT_OF_FEATURE[f] ?? "Core"]));
    const early = [...byFeatureDay.get(f)!.entries()]
      .filter(([d]) => daysBetween(usageStart, d) < 30 && ![0, 6].includes(toDate(d).getUTCDay()))
      .map(([, t]) => t);
    baseline.set(f, median(early.length ? early : [...byFeatureDay.get(f)!.values()]));
  }

  // Users per feature per day, capped so a day's total never exceeds seats.
  const dates = [...new Set(rows.map((u) => u.date))].sort();
  const featureUsers = new Map<string, number>(); // `${feature}|${date}`
  for (const d of dates) {
    const today = features.filter((f) => byFeatureDay.get(f)!.has(d));
    const raw = today.map((f) => {
      const ratio = byFeatureDay.get(f)!.get(d)! / Math.max(1, baseline.get(f)!);
      const users = seats * share.get(f)! * Math.pow(ratio, USERS_PER_USAGE_EXPONENT) * r.float(0.95, 1.05);
      return Math.min(seats, Math.max(1, Math.round(users)));
    });
    const total = raw.reduce((s, x) => s + x, 0);
    const scaled = total > seats ? raw.map((x) => Math.max(1, Math.floor((x * seats) / total))) : raw;
    today.forEach((f, i) => featureUsers.set(`${f}|${d}`, scaled[i]));
  }

  // Split each feature-day's users across its model rows by tokens.
  const groups = new Map<string, ContractUsage[]>();
  for (const u of rows) {
    const k = `${u.feature}|${u.date}`;
    const g = groups.get(k);
    if (g) g.push(u);
    else groups.set(k, [u]);
  }
  for (const [k, group] of groups) {
    const users = featureUsers.get(k)!;
    group.sort((x, y) => x.model.localeCompare(y.model));
    const tokens = group.map((u) => u.input_tokens + u.output_tokens);
    let parts: number[];
    if (users >= group.length) {
      // Everyone on a row with tokens gets at least one user.
      parts = splitWhole(users - group.length, tokens).map((x) => x + 1);
    } else {
      parts = group.map(() => 0);
      parts[tokens.indexOf(Math.max(...tokens))] = users;
    }
    group.forEach((u, i) => out.set(usageKey(u), parts[i]));
  }
}

// ---------------------------------------------------------------------------
// The whole layer
// ---------------------------------------------------------------------------

export function buildContractLayer(input: {
  accounts: ContractAccount[];
  usage: ContractUsage[];
  opportunities: ContractOpportunity[];
  invoices: ContractInvoice[];
  usageStart: string; // first day of the usage history (AS_OF_DATE - 90 days)
}): ContractLayer {
  const usageBy = new Map<string, ContractUsage[]>();
  for (const u of input.usage) {
    const list = usageBy.get(u.account_id);
    if (list) list.push(u);
    else usageBy.set(u.account_id, [u]);
  }
  const lastInvoice = new Map<string, ContractInvoice>();
  for (const i of input.invoices) {
    const prev = lastInvoice.get(i.account_id);
    if (!prev || i.month > prev.month) lastInvoice.set(i.account_id, i);
  }
  const expansionsBy = new Map<string, string[]>();
  for (const o of input.opportunities) {
    if (o.type === "expansion" && o.stage === "Closed Won") {
      expansionsBy.set(o.account_id, [...(expansionsBy.get(o.account_id) ?? []), o.close_date]);
    }
  }

  const lines: ContractLineRow[] = [];
  const activeUsers = new Map<string, number>();
  const unusedCore: string[] = [];
  const contractOf = new Map<string, string>();

  for (const a of [...input.accounts].sort((x, y) => x.id.localeCompare(y.id))) {
    if (a.status === "prospect") continue;
    const rows = usageBy.get(a.id) ?? [];
    const tokensByProduct = new Map<Product, number>();
    for (const u of rows) {
      const p = PRODUCT_OF_FEATURE[u.feature];
      if (!p) throw new Error(`Usage feature "${u.feature}" has no product. Add it to PRODUCT_OF_FEATURE.`);
      tokensByProduct.set(p, (tokensByProduct.get(p) ?? 0) + u.input_tokens + u.output_tokens);
    }

    let arr: number;
    let renewal: string;
    let status: ContractLineRow["status"];
    if (a.status === "customer") {
      if (!a.renewal_date) throw new Error(`Customer ${a.id} has no renewal date.`);
      arr = Math.round(a.mrr_usd * 12);
      renewal = a.renewal_date.slice(0, 10);
      status = "active";
    } else {
      // Churned: the contract they had, ending on the churn date, at their last billed MRR.
      const inv = lastInvoice.get(a.id);
      if (!inv || !a.churn_date) throw new Error(`Churned account ${a.id} has no invoice or churn date.`);
      arr = Math.round(inv.amount_usd * 12);
      renewal = a.churn_date.slice(0, 10);
      status = "churned";
    }

    const built = buildLines(a, arr, renewal, status, tokensByProduct, expansionsBy.get(a.id) ?? [], input.usageStart);
    lines.push(...built.lines);
    if (a.status === "customer" && !built.coreUsed) unusedCore.push(a.id);
    contractOf.set(a.id, contractIdFor(a.id));
    buildActiveUsers(a, rows, input.usageStart, activeUsers);
  }

  const dealContract = new Map<string, string>();
  for (const o of input.opportunities) {
    if (o.type !== "renewal") continue;
    const c = contractOf.get(o.account_id);
    if (!c) throw new Error(`Renewal deal ${o.id} belongs to ${o.account_id}, which has no contract.`);
    dealContract.set(o.id, c);
  }
  return { lines, activeUsers, dealContract, unusedCore };
}

/** Short code for the whole contract layer: the same code means identical lines, users and deal links. */
export function contractLayerFingerprint(layer: ContractLayer): string {
  const users = [...layer.activeUsers].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const deals = [...layer.dealContract].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const lines = [...layer.lines].sort((a, b) => (a.id < b.id ? -1 : 1));
  return createHash("sha256").update(JSON.stringify([lines, users, deals])).digest("hex").slice(0, 12);
}
