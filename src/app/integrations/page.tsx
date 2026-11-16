import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getClaudeStatus, getSupabaseStatus } from "@/lib/integrations";
import { PAGES, tabTitle } from "@/lib/pages";
import { shortDate, usd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { BlockSkeleton } from "@/components/Skeleton";

export const metadata: Metadata = { title: tabTitle(PAGES.integrations.title) };

export default function IntegrationsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader title={PAGES.integrations.title} description={PAGES.integrations.description} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Suspense fallback={<CardSkeleton />}>
          <SupabaseCard />
        </Suspense>
        <Suspense fallback={<CardSkeleton />}>
          <ClaudeCard />
        </Suspense>
        <PlannedCard name="HubSpot" initial="H" color="bg-orange-500" kind="CRM" note="Planned: sync accounts and deals as HubSpot companies and deals." />
        <PlannedCard
          name="Salesforce"
          initial="S"
          color="bg-sky-500"
          kind="CRM"
          note="Planned: sync accounts and deals as Salesforce accounts and opportunities."
        />
      </div>
    </main>
  );
}

/** 2026-11-16T14:32:05Z -> 16 Nov 2026, 14:32 UTC */
function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${shortDate(d.toISOString())}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function Card({ name, initial, color, kind, connected, children }: { name: string; initial: string; color: string; kind: string; connected: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className={`flex h-10 w-10 items-center justify-center rounded-lg text-base font-semibold text-white ${color}`}>
            {initial}
          </span>
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{name}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{kind}</p>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${
            connected ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-400"}`} />
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="mt-4 flex flex-1 flex-col gap-3 text-sm text-zinc-600 dark:text-zinc-400">{children}</div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-zinc-100 pb-2 last:border-0 last:pb-0 dark:border-zinc-800">
      <span>{label}</span>
      <span className="text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

async function SupabaseCard() {
  await connection();
  const s = await getSupabaseStatus();
  return (
    <Card name="Supabase" initial="S" color="bg-emerald-600" kind="Database · Lumen AI demo data" connected={s.connected}>
      {s.connected ? (
        <>
          <Detail label="Last seed" value={s.lastSeededAt ? dateTime(s.lastSeededAt) : "Not recorded yet"} />
          <Detail label="Data as of" value={s.asOfDate ? shortDate(s.asOfDate) : "n/a"} />
          {!s.lastSeededAt && <p className="text-xs text-zinc-500">The seed date appears once the seed_runs migration has been run and the data re-seeded.</p>}
        </>
      ) : (
        <p className="text-red-700 dark:text-red-300">Can&apos;t reach the database: {s.error}</p>
      )}
    </Card>
  );
}

async function ClaudeCard() {
  await connection();
  const c = await getClaudeStatus();
  const share = c.budgetUsd > 0 ? Math.min(1, c.spendTodayUsd / c.budgetUsd) : 0;
  return (
    <Card name="Anthropic Claude" initial="C" color="bg-[#d97757]" kind="AI · claude-sonnet-5-5" connected={c.connected}>
      {c.error ? (
        <p className="text-red-700 dark:text-red-300">Can&apos;t read today&apos;s spend: {c.error}</p>
      ) : (
        <>
          <Detail label="Spend today (UTC)" value={`$${c.spendTodayUsd.toFixed(2)}`} />
          <Detail label="Calls today" value={c.callsToday.toLocaleString("en-US")} />
          <div>
            <div className="mb-1 flex justify-between text-xs">
              <span>Daily budget</span>
              <span className="tabular-nums">
                ${c.spendTodayUsd.toFixed(2)} of {usd(c.budgetUsd)}
              </span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              aria-label="Share of daily AI budget used"
            >
              <div
                className={`h-full rounded-full ${share >= 1 ? "bg-red-500" : share >= 0.8 ? "bg-amber-500" : "bg-zinc-900 dark:bg-zinc-100"}`}
                style={{ width: `${share * 100}%` }}
              />
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function PlannedCard({ name, initial, color, kind, note }: { name: string; initial: string; color: string; kind: string; note: string }) {
  return (
    <Card name={name} initial={initial} color={color} kind={kind} connected={false}>
      <p>{note}</p>
      <div className="mt-auto">
        <button
          type="button"
          disabled
          title="Coming soon"
          className="cursor-not-allowed rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500"
        >
          Connect {name}
        </button>
      </div>
    </Card>
  );
}

function CardSkeleton() {
  return <BlockSkeleton className="h-48" />;
}
