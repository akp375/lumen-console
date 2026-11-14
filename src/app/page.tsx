import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { AS_OF_DATE } from "@/lib/as-of-date";
import { getHomePageData, usageHistory } from "@/lib/metrics";
import { longDate, modelLabel, pct, segmentLabel, usd, usdCompact } from "@/lib/format";
import { KpiCard } from "@/components/KpiCard";
import { RevenueCostChart } from "@/components/RevenueCostChart";
import { AccountsTable } from "@/components/AccountsTable";
import { LifecycleMixChart, PipelineByStageChart, SegmentEconomicsChart, TokenCostByModelChart } from "@/components/BreakdownCharts";

export default function Home() {
  return (
    <div className="flex-1 bg-zinc-50 dark:bg-black">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Demo data: Lumen AI is a fictional company. As of {longDate(AS_OF_DATE)}.
      </div>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Cockpit</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Lumen AI · revenue, pipeline and AI cost across its customers</p>
        </header>

        <Suspense fallback={<DashboardSkeleton />}>
          <Dashboard />
        </Suspense>
      </main>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
      {subtitle && <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      {children}
    </section>
  );
}

// Reads live data from Supabase on each request (server-side only).
async function Dashboard() {
  await connection();
  const d = await getHomePageData();
  const byType = Object.fromEntries(d.winRate.byType.map((t) => [t.type, t]));
  const typeLabel: Record<string, string> = { new: "New business", expansion: "Expansion", renewal: "Renewal" };
  const days = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(0)} days`);
  const renewalDue = d.lifecycleMix.find((s) => s.stage === "Renewal due");

  return (
    <div className="space-y-8">
      <section aria-label="Key metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <KpiCard
          label="ARR"
          period="Today"
          value={usdCompact(d.arr.totalArr)}
          detail="Customers, MRR × 12"
          backTitle="ARR by segment"
          back={[
            ...d.arr.bySegment.map((s) => ({ label: segmentLabel(s.segment), value: `${usdCompact(s.arr)} · ${pct(s.share, 0)}` })),
            { label: "Top 10 customers", value: pct(d.arr.top10Share, 0) },
          ]}
        />
        <KpiCard
          label="Customers"
          period="Today"
          value={String(d.arr.customerCount)}
          detail="Active accounts"
          backTitle="Customers"
          back={[
            ...d.arr.bySegment.map((s) => ({ label: segmentLabel(s.segment), value: String(s.customers) })),
            { label: "Renewal due, next 90 days", value: String(renewalDue?.customers ?? 0) },
            { label: "Churned, last 90 days", value: String(d.nrr.churnedCount) },
          ]}
        />
        <KpiCard
          label="Open pipeline"
          period="Today"
          value={usdCompact(d.pipeline.total.value)}
          detail={`${usdCompact(d.pipeline.total.weightedValue)} weighted · ${d.pipeline.total.count} deals`}
          backTitle="Growth (new + expansion) vs renewal"
          back={[
            { label: `Growth · ${d.pipeline.growth.count} deals`, value: usdCompact(d.pipeline.growth.value) },
            { label: "Growth, weighted", value: usdCompact(d.pipeline.growth.weightedValue) },
            { label: `Renewal · ${d.pipeline.renewal.count} deals`, value: usdCompact(d.pipeline.renewal.value) },
            { label: "Renewal, weighted", value: usdCompact(d.pipeline.renewal.weightedValue) },
          ]}
        />
        <KpiCard
          label="Win rate"
          period="Last 6 months"
          value={pct(d.winRate.winRate)}
          detail={`${d.winRate.won} won · ${d.winRate.lost} lost`}
          backTitle="Win rate by deal type"
          back={["new", "expansion", "renewal"].map((t) => ({
            label: `${typeLabel[t]} · ${byType[t]?.won ?? 0} won, ${byType[t]?.lost ?? 0} lost`,
            value: pct(byType[t]?.winRate ?? null),
          }))}
        />
        <KpiCard
          label="Avg sales cycle"
          period="Last 6 months"
          value={days(d.winRate.avgSalesCycleDays)}
          detail="Won deals, created to closed"
          backTitle="Sales cycle by deal type"
          back={["new", "expansion", "renewal"].map((t) => ({ label: typeLabel[t], value: days(byType[t]?.avgSalesCycleDays ?? null) }))}
        />
        <KpiCard
          label="Token cost"
          period="Last 30 days"
          value={usdCompact(d.portfolio.totalTokenCost30d)}
          detail="Customers' AI usage, priced per model"
          backTitle="Token cost by model"
          back={d.tokenCostByModel.map((m) => ({ label: modelLabel(m.model), value: `${usdCompact(m.cost)} · ${pct(m.share, 0)}` }))}
        />
        <KpiCard
          label="Blended gross margin"
          period="Last 30 days"
          value={pct(d.portfolio.blendedGrossMargin)}
          detail="MRR after token costs only"
          backTitle="Margin by segment"
          back={d.bySegment.map((s) => ({ label: segmentLabel(s.segment), value: pct(s.grossMargin) }))}
        />
        <KpiCard
          label="Underwater accounts"
          period="Last 30 days"
          value={String(d.portfolio.underwaterCount)}
          detail={`of ${d.portfolio.customerCount} customers · margin below 30%`}
          tone={d.portfolio.underwaterCount > 0 ? "alert" : "default"}
          backTitle="What's at stake"
          back={[
            { label: "Their MRR", value: `${usd(d.portfolio.underwaterMrr)} · ${pct(d.portfolio.underwaterMrrShare, 0)}` },
            { label: "Their share of token cost", value: pct(d.portfolio.underwaterTokenCostShare, 0) },
            { label: "Losing money (below 0%)", value: String(d.portfolio.negativeMarginCount) },
            { label: "Overage accounts", value: String(d.portfolio.overageCount) },
          ]}
        />
        <KpiCard
          label="NRR"
          period="Last 90 days"
          value={pct(d.nrr.nrr)}
          detail={`GRR ${pct(d.nrr.grr)} · from monthly invoices`}
          backTitle="MRR bridge"
          back={[
            { label: "Starting MRR", value: usd(d.nrr.startingMrr) },
            { label: `+ Upgrades (${d.nrr.upgradedCount})`, value: usd(d.nrr.upgrades) },
            { label: `− Downgrades (${d.nrr.downgradedCount})`, value: usd(d.nrr.downgrades) },
            { label: `− Churned (${d.nrr.churnedCount})`, value: usd(d.nrr.churnedMrr) },
          ]}
        />
      </section>

      <Panel
        title="Monthly revenue vs token cost"
        subtitle={`Whole company, including churned accounts while they were paying. Complete months only: usage history starts ${longDate(usageHistory(d.asOf).start)}, so partial months are left out.`}
      >
        <RevenueCostChart rows={d.monthly} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Open pipeline by stage" subtitle="Today · value and weighted value (amount × probability)">
          <PipelineByStageChart rows={d.pipeline.byStage} />
        </Panel>
        <Panel title="Revenue vs token cost by segment" subtitle="Customers · MRR today vs token cost, last 30 days">
          <SegmentEconomicsChart rows={d.bySegment} />
        </Panel>
        <Panel title="Token cost by model" subtitle="Customers · last 30 days">
          <TokenCostByModelChart rows={d.tokenCostByModel} total={d.portfolio.totalTokenCost30d} />
        </Panel>
        <Panel title="Customers by lifecycle stage" subtitle="Today · renewal due = renewal date within 90 days">
          <LifecycleMixChart rows={d.lifecycleMix} total={d.arr.customerCount} />
        </Panel>
      </div>

      <section>
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">Customer accounts</h2>
        <AccountsTable rows={d.accounts} />
      </section>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading data">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-72 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
        ))}
      </div>
    </div>
  );
}
