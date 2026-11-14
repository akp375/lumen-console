"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MonthlyRevenueCostRow } from "@/lib/metrics";
import { monthLabel, pct, usd, usdCompact } from "@/lib/format";

const REVENUE_COLOR = "#2563eb"; // blue
const COST_COLOR = "#ea580c"; // orange

export function RevenueCostChart({ rows }: { rows: MonthlyRevenueCostRow[] }) {
  const data = rows.map((r) => ({ label: monthLabel(r.month), revenue: r.revenue, tokenCost: r.tokenCost }));

  return (
    <div>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 800, height: 288 }}>
          <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#a1a1aa" strokeOpacity={0.3} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#71717a" }} tickLine={false} axisLine={false} padding={{ left: 40, right: 40 }} />
            <YAxis
              tickFormatter={(v: number) => usdCompact(v)}
              tick={{ fontSize: 12, fill: "#71717a" }}
              tickLine={false}
              axisLine={false}
              width={64}
              domain={[0, "auto"]}
            />
            <Tooltip formatter={(v) => usd(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} itemSorter={null} />
            <Line type="monotone" dataKey="revenue" name="Revenue" stroke={REVENUE_COLOR} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="tokenCost" name="Token cost" stroke={COST_COLOR} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {rows.map((r) => (
          <span key={r.month} className="tabular-nums">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{monthLabel(r.month)}</span>: revenue {usd(r.revenue)} · token cost{" "}
            {usd(r.tokenCost)} · margin {pct(r.grossMargin)}
          </span>
        ))}
      </div>
    </div>
  );
}
