// Display formatting only. No business math here: numbers come from metrics.ts.

const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

// House style (used everywhere):
//   KPI cards and chart axes: compact money, $1.2M / $387K / $950
//   Tables: full money, $13,500
//   Percentages: one decimal, 62.3%
//   Dates: 16 Dec 2026
//   Claude spend: $0.0276 under $1, $2.04 from $1 (aiUsd)
//   Signed changes: ASCII sign, -7 / +3 / -35.1%

/** $1.2M, $387K, $950 */
export function usdCompact(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 999_500) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${Math.round(a / 1_000)}K`;
  return `${sign}$${Math.round(a)}`;
}

/** Claude spend: $0.0276 under $1 (small calls stay readable), $2.04 from $1. */
export function aiUsd(n: number): string {
  return `$${n.toFixed(Math.abs(n) >= 1 ? 2 : 4)}`;
}

/** $13,500 */
export function usd(n: number): string {
  return wholeUsd.format(n);
}

/** 0.623 -> 62.3%; null -> n/a */
export function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

/** Change as a signed percentage: -0.352 -> -35.2%, 0.05 -> +5.0% */
export function pctChange(n: number | null): string {
  if (n === null) return "n/a";
  const v = (n * 100).toFixed(1);
  return n > 0 ? `+${v}%` : `${v}%`;
}

/** Signed whole number: -3, +2, 0 */
export function signedInt(n: number | null): string {
  if (n === null) return "n/a";
  return n > 0 ? `+${n}` : String(n);
}

/** 2026-09-01 -> Sep 2026 */
export function monthLabel(isoDate: string): string {
  return monthFmt.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

/** 2026-11-13 -> 13 Nov 2026 (three-letter months, so September is "Sep") */
const shortMonthFmt = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
export function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${shortMonthFmt.format(d)} ${d.getUTCFullYear()}`;
}

/** 22 -> "1 yr 10 mo"; 5 -> "5 mo" */
export function tenureLabel(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  return m === 0 ? `${y} yr` : `${y} yr ${m} mo`;
}

/** claude-opus-5-5 -> Opus 5.5 */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  if (!m) return model;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

const SEGMENT_LABELS: Record<string, string> = { SMB: "SMB", "mid-market": "Mid-market", enterprise: "Enterprise" };

export function segmentLabel(segment: string): string {
  return SEGMENT_LABELS[segment] ?? segment;
}

/** What users see for the first New business stage. The stored stage value stays "Stage 0.1". */
export const QUALIFYING = "Qualifying";
export const QUALIFYING_DESCRIPTION = "meeting held, not yet qualified as an opportunity";
const STAGE_LABELS: Record<string, string> = { "Stage 0.1": QUALIFYING };

/** A deal stage as users see it: "Stage 0.1" -> "Qualifying"; every other stage unchanged. */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** The lead lifecycle as users see it (stored in leads.lead_stage). */
export const LEAD_STAGE_LABELS: Record<string, string> = {
  new: "New",
  engaged: "Engaged",
  mql: "MQL",
  sales_accepted: "Sales accepted",
  sales_qualified: "Sales qualified",
  meeting_booked: "Meeting booked",
  converted: "Converted",
  disqualified: "Disqualified",
  nurture: "Nurture",
};
export const LEAD_STAGE_DESCRIPTIONS: Record<string, string> = {
  new: "downloaded or signed up for something",
  engaged: "responded to automated marketing emails",
  mql: "marketing qualified lead",
  sales_accepted: "an ADR took ownership and is working it",
  sales_qualified: "passed the ADR's qualifying call",
  meeting_booked: "meeting set with an AE; the Qualifying deal is created here",
  converted: "became an opportunity",
  disqualified: "ruled out, with a reason",
  nurture: "returned to marketing",
};
export function leadStageLabel(stage: string): string {
  return LEAD_STAGE_LABELS[stage] ?? stage;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * 2026-11-23T17:41:46Z -> "23 Nov 2026, 17:41" (UTC). Built by hand, not with Intl, so the server and
 * every browser print exactly the same text (Intl's date-and-time wording differs between browsers,
 * e.g. "23 Nov 2026 at 17:41", which breaks React hydration).
 */
export function dateTimeUtc(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
