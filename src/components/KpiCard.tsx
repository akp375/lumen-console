"use client";

import { useState } from "react";

export type KpiBackLine = { label: string; value: string };

type Props = {
  label: string;
  value: string;
  period: string; // e.g. "Today", "Last 30 days"
  detail?: string;
  tone?: "default" | "alert";
  backTitle: string;
  back: KpiBackLine[];
};

// A KPI card that flips to show more detail: on hover (mouse), on keyboard
// focus, or on tap (touch screens, tap again to flip back).
export function KpiCard({ label, value, period, detail, tone = "default", backTitle, back }: Props) {
  const [flipped, setFlipped] = useState(false);

  return (
    <button
      type="button"
      aria-label={`${label}: ${value}. ${backTitle}: ${back.map((l) => `${l.label} ${l.value}`).join(", ")}`}
      onPointerUp={(e) => {
        if (e.pointerType !== "mouse") setFlipped((f) => !f);
      }}
      className="group h-40 w-full cursor-default text-left perspective-[1000px] focus:outline-none"
    >
      <div
        className={`relative h-full w-full transition-transform duration-500 transform-3d motion-reduce:transition-none group-hover:rotate-y-180 group-focus-visible:rotate-y-180 ${
          flipped ? "rotate-y-180" : ""
        }`}
      >
        {/* Front */}
        <div className="absolute inset-0 flex flex-col rounded-lg border border-zinc-200 bg-white p-4 backface-hidden group-focus-visible:ring-2 group-focus-visible:ring-blue-500 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
            <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {period}
            </span>
          </div>
          <div
            className={`mt-2 text-2xl font-semibold tabular-nums ${
              tone === "alert" ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-50"
            }`}
          >
            {value}
          </div>
          {detail && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>}
          <div className="mt-auto text-[10px] text-zinc-400 dark:text-zinc-500" aria-hidden="true">
            Hover or tap for details ↻
          </div>
        </div>

        {/* Back */}
        <div className="absolute inset-0 flex flex-col rounded-lg border border-zinc-300 bg-zinc-50 p-4 rotate-y-180 backface-hidden dark:border-zinc-700 dark:bg-zinc-800">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{backTitle}</div>
          <dl className="mt-2 space-y-1 text-xs">
            {back.map((l) => (
              <div key={l.label} className="flex justify-between gap-3">
                <dt className="text-zinc-600 dark:text-zinc-300">{l.label}</dt>
                <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-50">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </button>
  );
}
