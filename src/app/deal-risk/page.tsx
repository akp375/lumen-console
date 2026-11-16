import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { DEAL_RISK_RULES, getUpcomingDeals } from "@/lib/metrics";
import { PAGES, tabTitle } from "@/lib/pages";
import { DealRiskPanel } from "@/components/DealRiskPanel";
import { PageHeader } from "@/components/PageHeader";
import { SectionSkeleton } from "@/components/Skeleton";

export const metadata: Metadata = { title: tabTitle(PAGES.dealRisk.title) };

const R = DEAL_RISK_RULES;
const limits = Object.entries(R.maxDaysInStage)
  .map(([stage, days]) => `${stage} ${days}`)
  .join(", ");
const RULES =
  `How flags work: an open deal with at least one of no executive sponsor in ${R.sponsorRequiredStages.join(" or ")}, ` +
  `too long in its stage (max days: ${limits}), no activity in ${R.noActivityDays}+ days, a close date in the past, or no next step.`;

export default function DealRiskPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <DealRiskContent />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function DealRiskContent() {
  await connection();
  const upcoming = await getUpcomingDeals();
  return <DealRiskPanel rules={RULES} upcoming={upcoming} />;
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.dealRisk.title} description={PAGES.dealRisk.description} />
      <div className="space-y-8">
        <SectionSkeleton columns={6} rows={10} />
        <SectionSkeleton columns={6} rows={10} />
      </div>
    </>
  );
}
