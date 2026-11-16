import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { DEAL_RISK_RULES, getUpcomingDeals } from "@/lib/metrics";
import { DealRiskPanel } from "@/components/DealRiskPanel";

export const metadata: Metadata = { title: "Deal risk · Cockpit · Lumen AI" };

export default function DealRiskPage() {
  const R = DEAL_RISK_RULES;
  const limits = Object.entries(R.maxDaysInStage)
    .map(([stage, days]) => `${stage} ${days}`)
    .join(", ");
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Deal risk</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
          Flags open deals with at least one warning sign: no executive sponsor in {R.sponsorRequiredStages.join(" or ")}, too long in the current stage
          (max days: {limits}), no activity in {R.noActivityDays}+ days, a close date in the past, or no next step. Claude then writes a reason and next
          step for each deal.
        </p>
      </header>
      <Suspense fallback={<UpcomingSkeleton />}>
        <DealRiskContent />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function DealRiskContent() {
  await connection();
  const upcoming = await getUpcomingDeals();
  return <DealRiskPanel upcoming={upcoming} />;
}

function UpcomingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="h-9 w-40 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-80 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-80 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

