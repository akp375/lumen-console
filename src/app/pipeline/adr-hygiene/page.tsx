import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ADR_RULES, getAdrHygiene, type AdrHygieneCheck, type AdrHygieneItem } from "@/lib/metrics";
import { PAGES, tabTitle } from "@/lib/pages";
import { QUALIFYING, QUALIFYING_DESCRIPTION, pct } from "@/lib/format";
import { ACCOUNT_LINK } from "@/lib/ui";
import { PageHeader } from "@/components/PageHeader";
import { RuleNote, Stat } from "@/components/RiskUi";
import { BlockSkeleton, SectionSkeleton } from "@/components/Skeleton";

// Display only: every count, age and rate comes from metrics.ts (getAdrHygiene).

export const metadata: Metadata = { title: tabTitle(PAGES.adrHygiene.title) };

type Props = { searchParams: Promise<{ adr?: string | string[] }> };

export default function AdrHygienePage({ searchParams }: Props) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <HygieneContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

const R = ADR_RULES;

// Reads live data on each request (server-side only).
async function HygieneContent({ searchParams }: Props) {
  await connection();
  const raw = (await searchParams).adr;
  const requested = typeof raw === "string" ? raw : null;
  const data = await getAdrHygiene(requested);
  const adr = data.adrId;
  const adrName = adr ? data.adrs.find((a) => a.id === adr)!.name : null;
  const rate = data.slaBreachRate30d;

  return (
    <>
      <PageHeader title={PAGES.adrHygiene.title} description={PAGES.adrHygiene.description} />

      <nav aria-label="Filter by ADR" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-zinc-500 dark:text-zinc-400">ADR:</span>
        <FilterLink href={PAGES.adrHygiene.href} active={adr === null} label="All" />
        {data.adrs.map((a) => (
          <FilterLink key={a.id} href={`${PAGES.adrHygiene.href}?adr=${a.id}`} active={adr === a.id} label={a.name} />
        ))}
      </nav>

      <section className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          label={adrName ? `Hygiene issues · ${adrName}` : "Hygiene issues"}
          value={String(data.total)}
          tone={data.total > 0 ? "alert" : "good"}
          detail={adrName ? `of ${data.teamTotal} across the team` : "Open issues across all checks below"}
        />
        <Stat
          label="MQL SLA breach rate, last 30 days"
          value={pct(rate.rate)}
          tone={rate.rate !== null && rate.rate > 0 ? "warn" : "default"}
          detail={`${rate.breached} of ${rate.eligible} MQLs touched after ${R.slaHours} hours or never`}
        />
      </section>

      <section className="space-y-3">
        {data.checks.map((c) => (
          <CheckCard key={c.key} check={c} />
        ))}
      </section>

      <div className="mt-4">
        <RuleNote>
          Unassigned = an open lead at New, Engaged or MQL with no ADR. SLA breach = an MQL not touched within {R.slaHours} hours; the list shows MQLs still
          untouched, and the rate covers MQLs from the last {R.slaBreachRateDays} days whose {R.slaHours} hours are up. Stale = a deal at {QUALIFYING} ({QUALIFYING_DESCRIPTION}) with no update
          for {R.staleStage01Days}+ days. Handoff leak = a lead at Sales qualified for {R.handoffGraceDays}+ days with no meeting booked with an AE. Pairing mismatch = an open deal created
          on or after the pairing date whose ADR isn&apos;t paired with its AE. Account tags cover prospects and customers. The ADR filter uses each lead&apos;s
          ADR (or, if unassigned, the ADR who covers its territory), each deal&apos;s ADR, and for accounts the ADR paired with the account owner.
        </RuleNote>
      </div>
    </>
  );
}

function FilterLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full border px-3 py-1 ${
        active
          ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
          : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </Link>
  );
}

function age(i: AdrHygieneItem): string {
  if (i.ageDays === null) return "Not tracked";
  if (i.ageDays === 0) return "Under 1 day";
  return i.ageDays === 1 ? "1 day" : `${i.ageDays} days`;
}

function CheckCard({ check }: { check: AdrHygieneCheck }) {
  return (
    <details className="group rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="flex cursor-pointer list-none items-start gap-4 p-4 [&::-webkit-details-marker]:hidden">
        <span className={`min-w-12 text-2xl font-semibold tabular-nums ${check.count > 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
          {check.count}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-zinc-900 dark:text-zinc-50">{check.title}</span>
          <span className="block text-sm text-zinc-500 dark:text-zinc-400">{check.why}</span>
        </span>
        {check.count > 0 && (
          <span className="mt-1 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="group-open:hidden">Show list ▾</span>
            <span className="hidden group-open:inline">Hide list ▴</span>
          </span>
        )}
      </summary>
      {check.count > 0 && (
        <div className="max-h-[480px] overflow-auto border-t border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
              <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
                <th scope="col" className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300">Record</th>
                <th scope="col" className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300">Account</th>
                <th scope="col" className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300">Problem</th>
                <th scope="col" className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300">Owner</th>
                <th scope="col" className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-300">How long</th>
              </tr>
            </thead>
            <tbody className="align-top">
              {check.items.map((i) => (
                <tr key={i.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{i.record}</td>
                  <td className="px-3 py-2">
                    <Link href={`/accounts/${i.accountId}`} className={ACCOUNT_LINK}>
                      {i.accountName}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{i.problem}</td>
                  <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{i.owner}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{age(i)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.adrHygiene.title} description={PAGES.adrHygiene.description} />
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <BlockSkeleton className="h-24" />
          <BlockSkeleton className="h-24" />
        </div>
        <SectionSkeleton columns={5} rows={6} />
      </div>
    </>
  );
}
