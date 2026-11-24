import type { HealthBand, HealthCategory } from "@/lib/metrics";
import { healthBreakdown, pts } from "@/lib/health-format";

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
      {arrow} {flat ? "0" : `${change > 0 ? "+" : "-"}${Math.abs(Math.round(change))}`}
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

function ProgressBar({ earned, possible, category }: { earned: number; possible: number; category: HealthCategory }) {
  const width = possible > 0 ? Math.min(100, (earned / possible) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className={`h-full rounded-full ${CATEGORY_COLOR[category]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** Account page: one row per category (earned / possible as a bar). Hover or focus a row for the metric-by-metric reasons. */
export function HealthCategoryRows({ row }: { row: Parameters<typeof healthBreakdown>[0] }) {
  return (
    <ul className="space-y-1">
      {healthBreakdown(row).map((c) => (
        <li key={c.category} className="group relative">
          <div
            tabIndex={0}
            className="grid cursor-help grid-cols-[110px_1fr_64px] items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-zinc-50 focus:bg-zinc-50 dark:hover:bg-zinc-800/50 dark:focus:bg-zinc-800/50"
          >
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.label}</span>
            <ProgressBar earned={c.earned} possible={c.possible} category={c.category} />
            <span className="text-right text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{pts(c.earned)}</span> / {c.possible}
            </span>
          </div>
          <div
            role="tooltip"
            className="pointer-events-none absolute left-2 top-full z-20 mt-1 hidden w-[min(44rem,calc(100vw-3rem))] rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-lg group-focus-within:block group-hover:block dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="mb-2 font-semibold text-zinc-900 dark:text-zinc-100">
              {c.label}: {pts(c.earned)} / {c.possible}
            </div>
            <ul className="space-y-1.5">
              {c.items.map((it, k) => (
                <li key={k} className="flex justify-between gap-4 text-zinc-600 dark:text-zinc-400">
                  <span>{it.text}</span>
                  <span className="shrink-0 tabular-nums text-zinc-900 dark:text-zinc-100">
                    → {pts(it.earned)} / {pts(it.possible)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Compact five-category summary (used in the score-badge popup on /health). */
export function HealthCategorySummary({ row }: { row: Parameters<typeof healthBreakdown>[0] }) {
  return (
    <ul className="space-y-1.5">
      {healthBreakdown(row).map((c) => (
        <li key={c.category} className="grid grid-cols-[88px_96px_48px] items-center gap-2 text-xs">
          <span className="text-zinc-600 dark:text-zinc-400">{c.label}</span>
          <ProgressBar earned={c.earned} possible={c.possible} category={c.category} />
          <span className="text-right tabular-nums text-zinc-600 dark:text-zinc-400">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{pts(c.earned)}</span> / {c.possible}
          </span>
        </li>
      ))}
    </ul>
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
