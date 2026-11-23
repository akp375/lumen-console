import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { getClaudeStatus, getHubSpotStatus, getSupabaseStatus } from "@/lib/integrations";
import { PAGES, tabTitle } from "@/lib/pages";
import { modelLabel, shortDate, usd } from "@/lib/format";
import { getLastSyncRuns, type SyncRunRow } from "@/lib/sync-runs";
import { PageHeader } from "@/components/PageHeader";
import { BlockSkeleton } from "@/components/Skeleton";
import { HubSpotSyncButton } from "@/components/HubSpotSyncButton";
import { isLocalDev, LOCAL_ONLY_NOTE } from "@/lib/local-only";

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
        <Suspense fallback={<CardSkeleton />}>
          <HubSpotCard />
        </Suspense>
        <PlannedCard
          name="Salesforce"
          initial="S"
          color="bg-sky-500"
          kind="CRM"
          note="Planned: sync accounts and deals as Salesforce accounts and opportunities."
        />
        <PlannedCard name="Gainsight" initial="G" color="bg-teal-600" kind="Customer success" note="Planned: push health scores to scorecards and renewal risk as CTAs." />
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
    <Card name="Anthropic Claude" initial="C" color="bg-[#d97757]" kind={`AI · ${[...new Set(c.byFeature.map((f) => modelLabel(f.model)))].join(", ") || "no calls yet"}`} connected={c.connected}>
      {c.error ? (
        <p className="text-red-700 dark:text-red-300">Can&apos;t read today&apos;s spend: {c.error}</p>
      ) : (
        <>
          <Detail label="Spend today (UTC)" value={`$${c.spendTodayUsd.toFixed(2)}`} />
          <Detail label="Calls today" value={c.callsToday.toLocaleString("en-US")} />
          <Detail label="Spend to date" value={`$${c.spendToDateUsd.toFixed(2)}`} />
          <Detail label="Calls to date" value={c.callsToDate.toLocaleString("en-US")} />
          {c.byFeature.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">By feature and model, to date</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-500 dark:text-zinc-400">
                    <th scope="col" className="pb-1 font-normal">Feature</th>
                    <th scope="col" className="pb-1 font-normal">Model</th>
                    <th scope="col" className="pb-1 text-right font-normal">Calls</th>
                    <th scope="col" className="pb-1 text-right font-normal">Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {c.byFeature.map((f) => (
                    <tr key={`${f.feature}|${f.model}`} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1 text-zinc-900 dark:text-zinc-100">
                        {f.label}
                        {f.timeouts > 0 && <span className="text-zinc-500"> ({f.timeouts} timed out)</span>}
                      </td>
                      <td className="py-1">{modelLabel(f.model)}</td>
                      <td className="py-1 text-right tabular-nums">{f.calls.toLocaleString("en-US")}</td>
                      <td className="py-1 text-right tabular-nums text-zinc-900 dark:text-zinc-100">${f.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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

async function HubSpotCard() {
  await connection();
  const [h, runs] = await Promise.all([getHubSpotStatus(), getLastSyncRuns()]);
  const canSync = h.connected && isLocalDev((await headers()).get("host"));
  return (
    <Card name="HubSpot" initial="H" color="bg-orange-500" kind="CRM" connected={h.connected}>
      {h.connected ? (
        <>
          <Detail label="Account" value={h.portalId} />
          <Detail label="Account type" value={h.accountType} />
          <Detail label="Last checked" value={dateTime(h.checkedAt)} />
        </>
      ) : (
        <>
          <p className="text-red-700 dark:text-red-300">Can&apos;t reach HubSpot: {h.error}</p>
          <Detail label="Last checked" value={dateTime(h.checkedAt)} />
        </>
      )}
      {runs.notice ? (
        <p className="text-xs text-zinc-500">{runs.notice}</p>
      ) : runs.last ? (
        <>
          <Detail
            label="Last sync"
            value={
              <>
                {dateTime(runs.last.finished_at)}
                <span className="block text-xs font-normal text-zinc-500">
                  {runs.last.status === "failed" ? "Failed" : "Succeeded"} · {runs.last.scope === "full" ? "full sync" : `one account (${runs.last.account_id})`} ·{" "}
                  {runs.last.source === "button" ? "Sync button" : "command line"}
                </span>
              </>
            }
          />
          {runs.last.status === "failed" ? (
            <p className="text-xs text-red-700 dark:text-red-300">{runs.last.error}</p>
          ) : (
            <Detail label="Sent in that run" value={syncCounts(runs.last)} />
          )}
          {runs.lastFull && runs.lastFull.id !== runs.last.id && (
            <Detail label="Last full sync" value={<>{dateTime(runs.lastFull.finished_at)}<span className="block text-xs font-normal text-zinc-500">{syncCounts(runs.lastFull)}</span></>} />
          )}
        </>
      ) : (
        <Detail label="Last sync" value="No sync recorded yet" />
      )}
      <div className="mt-auto pt-2">
        <HubSpotSyncButton available={canSync} unavailableNote={h.connected ? LOCAL_ONLY_NOTE : "HubSpot isn't connected"} />
      </div>
    </Card>
  );
}

/** "190 companies (0 new), 207 deals (0 new), 81 contacts (0 new)" */
function syncCounts(r: SyncRunRow): string {
  const part = (n: number, created: number, what: string) => `${n.toLocaleString("en-US")} ${what} (${created} new)`;
  return `${part(r.companies_synced, r.companies_created, "companies")}, ${part(r.deals_synced, r.deals_created, "deals")}, ${part(r.contacts_synced, r.contacts_created, "contacts")}`;
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
