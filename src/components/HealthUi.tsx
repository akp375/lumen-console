import { HEALTH_CATEGORIES, HEALTH_CATEGORY_LABELS, HEALTH_WEIGHTS, type HealthBand, type HealthCategory } from "@/lib/metrics";

// Health score building blocks. Display only: every number comes from metrics.ts.

const BAND_BADGE: Record<HealthBand, string> = {
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};
export const BAND_TEXT: Record<HealthBand, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};
export const BAND_LABEL: Record<HealthBand, string> = { green: "Healthy", amber: "Watch", red: "At risk" };

export function HealthBadge({ score, band }: { score: number; band: HealthBand }) {
  return (
    <span className={`inline-flex min-w-10 justify-center rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums ${BAND_BADGE[band]}`} title={BAND_LABEL[band]}>
      {Math.round(score)}
    </span>
  );
}

/** Week-over-week change: ▲ up, ▼ down, ▬ flat (under 1 point). Red when down 10+. */
export function TrendArrow({ change, declining }: { change: number | null; declining: boolean }) {
  if (change === null) return <span className="text-xs text-zinc-400">New</span>;
  const flat = Math.abs(change) < 1;
  const arrow = flat ? "▬" : change > 0 ? "▲" : "▼";
  const tone = declining ? "text-red-600 dark:text-red-400 font-semibold" : flat ? "text-zinc-400" : change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400";
  return (
    <span className={`whitespace-nowrap tabular-nums ${tone}`} title="Points vs last week's snapshot">
      {arrow} {flat ? "0" : `${change > 0 ? "+" : "−"}${Math.abs(Math.round(change))}`}
    </span>
  );
}

const CATEGORY_COLOR: Record<HealthCategory, string> = {
  behavioral: "bg-blue-600",
  relationship: "bg-violet-500",
  feedback: "bg-teal-500",
  support: "bg-orange-500",
  financial: "bg-zinc-500",
};

export const categoryMax = (c: HealthCategory) => Object.values(HEALTH_WEIGHTS[c]).reduce((s: number, w) => s + w, 0);

/** One bar of 100 points: each category's contribution, then the points missed. */
export function ContributionBar({ points }: { points: Record<HealthCategory, number> }) {
  const total = HEALTH_CATEGORIES.reduce((s, c) => s + points[c], 0);
  return (
    <div>
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="img" aria-label="Points each category contributed">
        {HEALTH_CATEGORIES.map((c) => (
          <div key={c} className={CATEGORY_COLOR[c]} style={{ width: `${points[c]}%` }} title={`${HEALTH_CATEGORY_LABELS[c]}: ${points[c].toFixed(1)} of ${categoryMax(c)}`} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
        {HEALTH_CATEGORIES.map((c) => (
          <div key={c} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${CATEGORY_COLOR[c]}`} />
            <span className="text-zinc-600 dark:text-zinc-400">
              {HEALTH_CATEGORY_LABELS[c]}{" "}
              <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                {points[c].toFixed(1)}
              </span>
              <span className="tabular-nums"> / {categoryMax(c)}</span>
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-zinc-200 dark:bg-zinc-700" />
          <span className="text-zinc-600 dark:text-zinc-400">
            Missed <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{(100 - total).toFixed(1)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function AdoptionDropChips({ products }: { products: string[] }) {
  if (products.length === 0) return <span className="text-xs text-zinc-400">None</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {products.map((p) => (
        <span key={p} className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
          {p}
        </span>
      ))}
    </div>
  );
}
