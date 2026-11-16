"use client";

import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LifecycleMixRow, ModelCostRow, PipelineBucket, SegmentEconomicsRow } from "@/lib/metrics";
import { modelLabel, pct, segmentLabel, usd, usdCompact } from "@/lib/format";
import { LIFECYCLE_COLORS, MEASURE_COLORS, MODEL_COLORS, OTHER_COLOR } from "./chart-colors";

const AXIS_TICK = { fontSize: 12, fill: "#71717a" };
const TOOLTIP_STYLE = { fontSize: 12, borderRadius: 6 };
const usdTooltip = (v: unknown) => usd(Number(v));

// ---------------------------------------------------------------------------
// Bar charts (one $ axis each, two measures side by side)
// ---------------------------------------------------------------------------

export function PipelineByStageChart({ rows }: { rows: PipelineBucket[] }) {
  const data = rows.map((r) => ({ stage: r.key, value: r.value, weighted: r.weightedValue, count: r.count }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 256 }}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="#a1a1aa" strokeOpacity={0.3} vertical={false} />
          <XAxis dataKey="stage" tick={AXIS_TICK} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(v: number) => usdCompact(v)} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} />
          <Tooltip formatter={usdTooltip} contentStyle={TOOLTIP_STYLE} cursor={{ fill: "#a1a1aa", fillOpacity: 0.12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} />
          <Bar dataKey="value" name="Value" fill={MEASURE_COLORS.pipelineValue} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          <Bar dataKey="weighted" name="Weighted value" fill={MEASURE_COLORS.pipelineWeighted} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SegmentEconomicsChart({ rows }: { rows: SegmentEconomicsRow[] }) {
  const data = rows.map((r) => ({ segment: segmentLabel(r.segment), mrr: r.mrr, tokenCost: r.tokenCost30d }));
  return (
    <div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 480, height: 224 }}>
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="#a1a1aa" strokeOpacity={0.3} vertical={false} />
            <XAxis dataKey="segment" tick={AXIS_TICK} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={(v: number) => usdCompact(v)} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} />
            <Tooltip formatter={usdTooltip} contentStyle={TOOLTIP_STYLE} cursor={{ fill: "#a1a1aa", fillOpacity: 0.12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} />
            <Bar dataKey="mrr" name="MRR" fill={MEASURE_COLORS.revenue} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            <Bar dataKey="tokenCost" name="30-day token cost" fill={MEASURE_COLORS.tokenCost} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {rows.map((r) => (
          <span key={r.segment}>
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{segmentLabel(r.segment)}</span>: margin {pct(r.grossMargin)} ·{" "}
            {r.customers} customers · {r.underwaterCount} underwater
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut charts (parts of a whole) with a legend that lists every slice
// ---------------------------------------------------------------------------

type Slice = { key: string; label: string; value: number; color: string; detail: string };

function Donut({ slices, centerValue, centerLabel, format }: { slices: Slice[]; centerValue: string; centerLabel: string; format: (v: number) => string }) {
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      {/* text colour = card surface, used for the 2px gap between slices */}
      <div className="relative h-44 w-44 shrink-0 text-white dark:text-zinc-900">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 176, height: 176 }}>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="100%" startAngle={90} endAngle={-270} isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.key} fill={s.color} stroke="currentColor" strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => format(Number(v))} contentStyle={TOOLTIP_STYLE} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{centerValue}</span>
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{centerLabel}</span>
        </div>
      </div>
      <ul className="w-full space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} aria-hidden="true" />
              {s.label}
            </span>
            <span className="tabular-nums text-zinc-900 dark:text-zinc-100">{s.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TokenCostByModelChart({ rows, total }: { rows: ModelCostRow[]; total: number }) {
  const slices = rows.map((r) => ({
    key: r.model,
    label: modelLabel(r.model),
    value: r.cost,
    color: MODEL_COLORS[r.model] ?? OTHER_COLOR,
    detail: `${usd(r.cost)} · ${pct(r.share)}`,
  }));
  return <Donut slices={slices} centerValue={usdCompact(total)} centerLabel="30-day cost" format={usd} />;
}

export function LifecycleMixChart({ rows, total }: { rows: LifecycleMixRow[]; total: number }) {
  const slices = rows.map((r) => ({
    key: r.stage,
    label: r.stage,
    value: r.customers,
    color: LIFECYCLE_COLORS[r.stage] ?? OTHER_COLOR,
    detail: `${r.customers} · ${usdCompact(r.mrr)} MRR`,
  }));
  return <Donut slices={slices} centerValue={String(total)} centerLabel="customers" format={(v) => `${v} customers`} />;
}
