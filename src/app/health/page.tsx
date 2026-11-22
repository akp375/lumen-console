import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ADOPTION_DROP_BELOW, HEALTH_RULES, HEALTH_WEIGHTS, getHealth, type HealthPageRow } from "@/lib/metrics";
import { segmentLabel } from "@/lib/format";
import { PAGES, tabTitle } from "@/lib/pages";
import { PageHeader } from "@/components/PageHeader";
import { RuleNote, SectionHeading, Stat } from "@/components/RiskUi";
import { SectionSkeleton } from "@/components/Skeleton";
import { AdoptionDropChips, HealthBadge, TrendArrow } from "@/components/HealthUi";

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
  const rows = await getHealth();
  const count = (band: string) => rows.filter((r) => r.band === band).length;
  const declining = rows.filter((r) => r.declining).length;

  return (
    <>
      <PageHeader title={PAGES.health.title} description={PAGES.health.description} />
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Healthy (${R.greenFrom}+)`} value={String(count("green"))} detail={`of ${rows.length} customers`} />
        <Stat label={`Watch (${R.amberFrom}–${R.greenFrom - 1})`} value={String(count("amber"))} detail="Amber" tone="warn" />
        <Stat label={`At risk (below ${R.amberFrom})`} value={String(count("red"))} detail="Red" tone="alert" />
        <Stat label="Declining" value={String(declining)} detail={`Down ${R.decliningDrop}+ points on last week`} tone={declining > 0 ? "alert" : "default"} />
      </div>

      <section>
        <SectionHeading title="Customer Health" detail="Today's score (as of the app's date) with the change since last week's snapshot. Lowest score first." />
        <HealthTable rows={rows} />
        <div className="mt-2">
          <RuleNote>
            Score out of 100: Behavioral {W.behavioral.adoption} (each product line&apos;s usage trend, allowance used and active-user trend, weighted by
            line ARR; unused lines count as zero), Relationship {W.relationship.lastTouch + W.relationship.execMeeting + W.relationship.qbrThisTerm} (last
            CSM touch, an exec meeting in {R.lookbackDays} days, a QBR this contract term), Feedback {W.feedback.latestNps + W.feedback.npsChange + W.feedback.csat}{" "}
            (latest NPS, NPS change, CSAT), Support {W.support.openTickets + W.support.resolutionTime} (open tickets by severity, resolution time) and
            Financial {W.financial.overdueInvoices + W.financial.netExpansion} (overdue invoices, invoice growth over 12 months). Gross margin is a separate
            signal. Adoption drop = a product&apos;s usage fell more than {Math.abs(ADOPTION_DROP_BELOW * 100)}% (last 30 days vs the 30 before).
          </RuleNote>
        </div>
      </section>
    </>
  );
}

function HealthTable({ rows }: { rows: HealthPageRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-2">Account</th>
            <th className="px-4 py-2">CSM</th>
            <th className="px-4 py-2 text-center">Health</th>
            <th className="px-4 py-2">Week</th>
            <th className="px-4 py-2">Adoption Drop</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.accountId}>
              <td className="px-4 py-3">
                <Link href={`/accounts/${r.accountId}`} className="font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100">
                  {r.name}
                </Link>
                <div className="text-xs text-zinc-500">{segmentLabel(r.segment)}</div>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.csm ?? "None"}</td>
              <td className="px-4 py-3 text-center">
                <HealthBadge score={r.score} band={r.band} />
              </td>
              <td className="px-4 py-3">
                <TrendArrow change={r.change} declining={r.declining} />
              </td>
              <td className="px-4 py-3">
                <AdoptionDropChips products={r.lines.filter((l) => l.adoptionDrop).map((l) => l.product)} />
              </td>
              <td className="px-4 py-3">
                {r.declining && (
                  <span className="whitespace-nowrap rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500">Declining</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
