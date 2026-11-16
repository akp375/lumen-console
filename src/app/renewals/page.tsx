import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getUpcomingRenewals, RENEWAL_RISK_RULES } from "@/lib/metrics";
import { PAGES, tabTitle } from "@/lib/pages";
import { RenewalRiskPanel } from "@/components/RenewalRiskPanel";
import { PageHeader } from "@/components/PageHeader";
import { SectionSkeleton } from "@/components/Skeleton";

export const metadata: Metadata = { title: tabTitle(PAGES.renewals.title) };

const R = RENEWAL_RISK_RULES;
const RULES =
  `How flags work: renewal within ${R.renewalWithinDays} days AND at least one of latest NPS below ${R.npsBelow}, ` +
  `NPS down ${Math.abs(R.npsDropOf)} or more, usage down more than ${Math.abs(R.usageDropBelow * 100)}% (last 30 days vs the 30 before), ` +
  `or margin below 30%.`;

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
  const upcoming = await getUpcomingRenewals();
  return <RenewalRiskPanel windowDays={R.renewalWithinDays} rules={RULES} upcoming={upcoming} />;
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.renewals.title} description={PAGES.renewals.description} />
      <div className="space-y-8">
        <SectionSkeleton columns={4} rows={10} />
        <SectionSkeleton columns={4} rows={10} />
      </div>
    </>
  );
}
