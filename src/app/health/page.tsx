import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ADOPTION_DROP_BELOW, HEALTH_RULES, HEALTH_WEIGHTS, getHealth } from "@/lib/metrics";
import { PAGES, tabTitle } from "@/lib/pages";
import { PageHeader } from "@/components/PageHeader";
import { RuleNote } from "@/components/RiskUi";
import { SectionSkeleton } from "@/components/Skeleton";
import { HealthExplorer } from "@/components/HealthExplorer";

export const metadata: Metadata = { title: tabTitle(PAGES.health.title) };

const W = HEALTH_WEIGHTS;
const R = HEALTH_RULES;

export default function HealthPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <HealthContent />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function HealthContent() {
  await connection();
  const data = await getHealth();

  return (
    <>
      <PageHeader title={PAGES.health.title} description={PAGES.health.description} />
      <section>
        <HealthExplorer data={data} rules={{ greenFrom: R.greenFrom, amberFrom: R.amberFrom, decliningDrop: R.decliningDrop }} />
        <div className="mt-2">
          <RuleNote>
            Click a row to open the account. Score out of 100: Behavioral {W.behavioral.adoption} (each product line&apos;s usage trend, allowance used and
            active-user trend, weighted by line ARR; unused lines count as zero), Relationship{" "}
            {W.relationship.lastTouch + W.relationship.execMeeting + W.relationship.qbrThisTerm} (last CSM touch, an exec meeting in {R.lookbackDays} days,
            a QBR this contract term), Feedback {W.feedback.latestNps + W.feedback.npsChange + W.feedback.csat} (latest NPS, NPS change, CSAT), Support{" "}
            {W.support.openTickets + W.support.resolutionTime} (open tickets by severity, resolution time) and Financial{" "}
            {W.financial.overdueInvoices + W.financial.netExpansion} (overdue invoices, invoice growth over 12 months). Gross margin is a separate signal.
            ARR at risk = total ARR of customers below {R.amberFrom}. Adoption drop = a product&apos;s usage fell more than{" "}
            {Math.abs(ADOPTION_DROP_BELOW * 100)}% (last 30 days vs the 30 before).
          </RuleNote>
        </div>
      </section>
    </>
  );
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.health.title} description={PAGES.health.description} />
      <div className="space-y-8">
        <SectionSkeleton columns={4} rows={1} />
        <SectionSkeleton columns={6} rows={12} />
      </div>
    </>
  );
}
