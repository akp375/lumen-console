import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ADOPTION_DROP_BELOW, getRenewalDeals, getUpcomingRenewals, RENEWAL_RISK_RULES } from "@/lib/metrics";
import { PAGES, tabTitle } from "@/lib/pages";
import { segmentLabel } from "@/lib/format";
import { RenewalRiskPanel } from "@/components/RenewalRiskPanel";
import { PageHeader } from "@/components/PageHeader";
import { SectionSkeleton } from "@/components/Skeleton";

export const metadata: Metadata = { title: tabTitle(PAGES.renewals.title) };

const R = RENEWAL_RISK_RULES;
const WINDOWS = Object.entries(R.windowDays)
  .map(([segment, days]) => `${segmentLabel(segment)} ${days} days`)
  .join(", ");
const RULES =
  `How levels work, for renewals inside the window: High = health below ${R.highHealthBelow}, or health ${R.highHealthBelow}–${R.mediumHealthBelow - 1} ` +
  `with underwater margin (below ${R.underwaterMarginBelow * 100}%), health down ${R.healthDropOf}+ points on last week, or ${R.downsellShareFrom * 100}%+ of ` +
  `contract ARR at downsell risk. Medium = health ${R.highHealthBelow}–${R.mediumHealthBelow - 1}, or health ${R.mediumHealthBelow}+ with underwater margin ` +
  `or any line at downsell risk (usage down more than ${Math.abs(ADOPTION_DROP_BELOW * 100)}%, last 30 days vs prior 30), or NPS down ` +
  `${R.npsDropOf}+ points since the previous survey. Otherwise NPS and usage count inside the health score.`;

export default function RenewalsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <RenewalsContent />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function RenewalsContent() {
  await connection();
  const [upcoming, renewalDeals] = await Promise.all([getUpcomingRenewals(), getRenewalDeals()]);
  return (
    <RenewalRiskPanel
      windows={WINDOWS}
      rules={RULES}
      upcoming={upcoming}
      renewalDeals={renewalDeals}
      adoptionDropPct={Math.abs(ADOPTION_DROP_BELOW * 100)}
    />
  );
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.renewals.title} description={PAGES.renewals.description} />
      <div className="space-y-8">
        <SectionSkeleton columns={4} rows={2} />
        <SectionSkeleton columns={4} rows={10} />
        <SectionSkeleton columns={4} rows={10} />
      </div>
    </>
  );
}
