// Display formatting only. No business math here: numbers come from metrics.ts.

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const longDateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** $3.07M, $401K, $96.5K */
export function usdCompact(n: number): string {
  return compactUsd.format(n);
}

/** $13,500 */
export function usd(n: number): string {
  return wholeUsd.format(n);
}

/** 0.623 -> 62.3%; null -> n/a */
export function pct(n: number | null, digits = 1): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(digits)}%`;
}

/** 2026-11-13 -> 13 November 2026 */
export function longDate(isoDate: string): string {
  return longDateFmt.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
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
