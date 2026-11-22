"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { shortDate } from "@/lib/format";

// The last weekly health scores for one account. Display only.

const LINE_COLOR = "#2563eb"; // blue

/** greenFrom / amberFrom come from HEALTH_RULES (passed in, so this client file never imports server code). */
export function HealthChart({ history, greenFrom, amberFrom }: { history: { date: string; score: number }[]; greenFrom: number; amberFrom: number }) {
  const data = history.map((h) => ({ label: shortDate(h.date).replace(/ \d{4}$/, ""), score: Math.round(h.score * 10) / 10 }));
  return (
    <div className="h-48 w-full">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 192 }}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#a1a1aa" strokeOpacity={0.3} vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#71717a" }} tickLine={false} axisLine={false} padding={{ left: 16, right: 16 }} />
          <YAxis domain={[0, 100]} ticks={[0, amberFrom, greenFrom, 100]} tick={{ fontSize: 12, fill: "#71717a" }} tickLine={false} axisLine={false} width={32} />
          <ReferenceLine y={greenFrom} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.6} />
          <ReferenceLine y={amberFrom} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.6} />
          <Tooltip formatter={(v) => [Number(v).toFixed(1), "Health"]} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          <Line type="monotone" dataKey="score" name="Health" stroke={LINE_COLOR} strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
