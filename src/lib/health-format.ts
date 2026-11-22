// Health score explanations for display. Formatting only: every value and point
// comes from metrics.ts (HealthScoreRow). Safe to use in server and client components.
import type { HealthCategory, HealthMetric, HealthScoreRow } from "./metrics";
import { pct, pctChange, usd } from "./format";

export const CATEGORY_ORDER: HealthCategory[] = ["behavioral", "relationship", "feedback", "support", "financial"];
export const CATEGORY_LABEL: Record<HealthCategory, string> = {
  behavioral: "Behavioral",
  relationship: "Relationship",
  feedback: "Feedback",
  support: "Support",
  financial: "Financial",
};

export const ADOPTION_WINDOW = "last 30 days vs prior 30";

/** 7 -> "7", 7.25 -> "7.3" */
export const pts = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

export type BreakdownItem = { text: string; earned: number; possible: number };
export type CategoryBreakdown = { category: HealthCategory; label: string; earned: number; possible: number; items: BreakdownItem[] };

type Row = Pick<HealthScoreRow, "points" | "possible" | "metricPoints" | "lines" | "inputs">;

const change = (n: number | null, none: string) => (n === null ? none : pctChange(n));

function behavioralItems(r: Row): BreakdownItem[] {
  if (r.lines.length === 0) return [{ text: "No active contract lines (neutral score)", earned: r.points.behavioral, possible: r.possible.behavioral }];
  return r.lines.map((l) => ({
    text: l.notAdopted
      ? `${l.product} (${usd(l.arr)} ARR): not adopted, no usage in the last 60 days`
      : `${l.product} (${usd(l.arr)} ARR): usage ${change(l.usageChange, "n/a, no prior usage")}, active users ${change(l.usersChange, "n/a")} (${ADOPTION_WINDOW}); ${
          l.capacityUsed === null ? "no allowance" : `${pct(l.capacityUsed)} of monthly allowance used (last 30 days)`
        }`,
    earned: l.earned,
    possible: l.possible,
  }));
}

function metricText(k: HealthMetric, i: HealthScoreRow["inputs"]): string {
  switch (k) {
    case "lastTouch":
      return `Last CSM touch (call, meeting, QBR or exec meeting): ${i.lastTouchDays === null ? "none" : `${i.lastTouchDays} days ago`}`;
    case "execMeeting":
      return `Exec meeting in the last 90 days: ${i.execMeetingIn90d ? "yes" : "none"}`;
    case "qbrThisTerm":
      return `QBR this contract term: ${i.qbrThisTerm ? "yes" : "none"}`;
    case "latestNps":
      return `Latest NPS: ${i.latestNps === null ? "no response" : i.latestNps}`;
    case "npsChange":
      return `NPS change vs previous response: ${i.npsChange === null ? "only one response" : i.npsChange > 0 ? `+${i.npsChange}` : i.npsChange}`;
    case "csat":
      return `CSAT, tickets closed in the last 90 days: ${i.csatAvg === null ? "no ratings" : `${i.csatAvg.toFixed(1)} average`}`;
    case "openTickets":
      return `Open tickets today: ${i.openLowOrMedium} low or medium, ${i.openHighOrUrgent} high or urgent`;
    case "resolutionTime":
      return `Average resolution, last 90 days: ${i.avgResolutionDays === null ? "no tickets closed" : `${i.avgResolutionDays.toFixed(1)} days`}`;
    case "overdueInvoices":
      return `Overdue invoices, last 6 months: ${i.overdueInvoices}`;
    case "netExpansion":
      return `Invoice change, last 12 months: ${
        i.invoiceChange12m === null ? "no history" : i.invoiceChange12m === 0 ? "flat" : `${i.invoiceChange12m > 0 ? "+" : "−"}${usd(Math.abs(i.invoiceChange12m))} a month`
      }`;
  }
}

const METRICS_OF: Record<Exclude<HealthCategory, "behavioral">, HealthMetric[]> = {
  relationship: ["lastTouch", "execMeeting", "qbrThisTerm"],
  feedback: ["latestNps", "npsChange", "csat"],
  support: ["openTickets", "resolutionTime"],
  financial: ["overdueInvoices", "netExpansion"],
};

/** One entry per category, each listing its metrics with actual values and points. */
export function healthBreakdown(r: Row): CategoryBreakdown[] {
  return CATEGORY_ORDER.map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    earned: r.points[c],
    possible: r.possible[c],
    items:
      c === "behavioral"
        ? behavioralItems(r)
        : METRICS_OF[c].map((k) => ({ text: metricText(k, r.inputs), earned: r.metricPoints[k].earned, possible: r.metricPoints[k].possible })),
  }));
}
