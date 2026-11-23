import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ADR_RULES, getAdrInsights, type AdrInsightsResult } from "@/lib/metrics";
import { getLatestAdrMemo } from "@/lib/adr-memo";
import { PAGES, tabTitle } from "@/lib/pages";
import { QUALIFYING, QUALIFYING_DESCRIPTION, pct, shortDate } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { RuleNote, SectionHeading } from "@/components/RiskUi";
import { AdrMemoPanel } from "@/components/AdrMemoPanel";
import { BlockSkeleton, SectionSkeleton } from "@/components/Skeleton";

// Display only: every number comes from metrics.ts (getAdrInsights).

export const metadata: Metadata = { title: tabTitle(PAGES.adrInsights.title) };

const R = ADR_RULES;

export default function AdrInsightsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <InsightsContent />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function InsightsContent() {
  await connection();
  const [data, latest] = await Promise.all([getAdrInsights(), getLatestAdrMemo()]);
  const window = `${shortDate(data.windowStart)} to ${shortDate(data.asOf)}`;

  return (
    <>
      <PageHeader title={PAGES.adrInsights.title} description={PAGES.adrInsights.description} />
      <AdrMemoPanel initial={latest.memo} missingMigration={latest.missingMigration} adrManager={data.adrManager} />
      <div className="space-y-8">
        <Funnel data={data} window={window} />
        <Speed data={data} window={window} />
        <Sequences data={data} window={window} />
        <Scorecard data={data} window={window} />
      </div>
    </>
  );
}

// --- Tables ------------------------------------------------------------------

const TH = "whitespace-nowrap px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300";
const TD = "px-3 py-2";
const NUM = "px-3 py-2 text-right tabular-nums";

function Table({ head, children, minWidth = "min-w-[760px]" }: { head: { label: string; numeric?: boolean }[]; children: ReactNode; minWidth?: string }) {
  return (
    <div className="overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className={`w-full ${minWidth} text-sm`}>
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {head.map((h) => (
              <th key={h.label} scope="col" className={`${TH} ${h.numeric ? "text-right" : "text-left"}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="align-top">{children}</tbody>
      </table>
    </div>
  );
}
const ROW = "border-b border-zinc-100 last:border-0 dark:border-zinc-800/60";
const TOTAL_ROW = "border-t border-zinc-200 bg-zinc-50 font-medium dark:border-zinc-800 dark:bg-zinc-900";
const sourceLabel = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hours = (h: number | null) => (h === null ? "n/a" : `${h.toFixed(1)} h`);

function Funnel({ data, window }: { data: AdrInsightsResult; window: string }) {
  const rows = data.funnel.filter((f) => f.source !== "All sources");
  const all = data.funnel.find((f) => f.source === "All sources")!;
  const cells = (f: (typeof data.funnel)[number]) => (
    <>
      <td className={NUM}>{f.leads}</td>
      <td className={NUM}>{f.mql}</td>
      <td className={NUM}>{f.sql}</td>
      <td className={NUM}>{f.stage01}</td>
      <td className={NUM}>{f.opportunity}</td>
      <td className={NUM}>{pct(f.leadToMql)}</td>
      <td className={NUM}>{pct(f.mqlToSql)}</td>
      <td className={NUM}>{pct(f.sqlToStage01)}</td>
      <td className={NUM}>{pct(f.stage01ToOpportunity)}</td>
      <td className={`${NUM} font-medium`}>{pct(f.leadToOpportunity)}</td>
    </>
  );
  return (
    <section>
      <SectionHeading title="Funnel by Lead Source" detail={`Leads created ${window}, best lead-to-opportunity rate first.`} />
      <Table
        minWidth="min-w-[960px]"
        head={[
          { label: "Source" },
          ...["Leads", "MQL", "SQL", QUALIFYING, "Opportunity", "Lead → MQL", "MQL → SQL", `SQL → ${QUALIFYING}`, `${QUALIFYING} → Opp`, "Lead → Opp"].map((label) => ({ label, numeric: true })),
        ]}
      >
        {rows.map((f) => (
          <tr key={f.source} className={ROW}>
            <td className={`${TD} whitespace-nowrap text-zinc-900 dark:text-zinc-100`}>{sourceLabel(f.source)}</td>
            {cells(f)}
          </tr>
        ))}
        <tr className={TOTAL_ROW}>
          <td className={TD}>All sources</td>
          {cells(all)}
        </tr>
      </Table>
      <div className="mt-2">
        <RuleNote>
          {QUALIFYING} = the lead has a deal; it is the first deal stage ({QUALIFYING_DESCRIPTION}), so every deal has passed it. Opportunity = that
          deal has moved past {QUALIFYING}, open or closed. Deals opened before this stage existed went straight into a later stage and count as having
          passed it. Recent leads have had less time to convert.
        </RuleNote>
      </div>
    </section>
  );
}

function Speed({ data, window }: { data: AdrInsightsResult; window: string }) {
  const tone = (r: number | null) => (r === null ? "" : r >= data.team.onTimeRate! ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400");
  const cells = (s: AdrInsightsResult["team"]) => (
    <>
      <td className={NUM}>{s.mqls}</td>
      <td className={`${NUM} font-medium ${s.adrId !== null ? tone(s.onTimeRate) : ""}`}>{pct(s.onTimeRate)}</td>
      <td className={NUM}>{s.late}</td>
      <td className={NUM}>{s.never}</td>
      <td className={NUM}>{hours(s.medianHoursToTouch)}</td>
    </>
  );
  return (
    <section>
      <SectionHeading title="Speed to Lead by ADR" detail={`MQLs from ${window} whose ${R.slaHours} hours are up.`} />
      <Table minWidth="min-w-[640px]" head={[{ label: "ADR" }, ...["MQLs", `Touched within ${R.slaHours}h`, "Touched late", "Never touched", "Median time to first touch"].map((label) => ({ label, numeric: true }))]}>
        {data.speed.map((s) => (
          <tr key={s.adrId ?? "unassigned"} className={ROW}>
            <td className={`${TD} text-zinc-900 dark:text-zinc-100`}>{s.name}</td>
            {cells(s)}
          </tr>
        ))}
        <tr className={TOTAL_ROW}>
          <td className={TD}>Team</td>
          {cells(data.team)}
        </tr>
      </Table>
      <div className="mt-2">
        <RuleNote>Green = at or above the team rate, red = below it. The median uses touched MQLs only; never-touched MQLs are counted separately.</RuleNote>
      </div>
    </section>
  );
}

function Sequences({ data, window }: { data: AdrInsightsResult; window: string }) {
  return (
    <section>
      <SectionHeading title="Sequence Performance" detail={`Enrollments from ${window}, highest meeting rate first.`} />
      <Table head={[{ label: "Sequence" }, { label: "Owner" }, ...["Enrollments", "Open", "Reply", "Meeting", "Bounce"].map((label) => ({ label, numeric: true }))]}>
        {data.sequences.map((s) => (
          <tr key={s.id} className={`${ROW} ${s.rank === "best" ? "bg-emerald-50/60 dark:bg-emerald-950/30" : s.rank === "worst" ? "bg-red-50/60 dark:bg-red-950/30" : ""}`}>
            <td className={`${TD} text-zinc-900 dark:text-zinc-100`}>
              {s.name}
              {s.rank && (
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                    s.rank === "best" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200"
                  }`}
                >
                  {s.rank === "best" ? "Best" : "Worst"}
                </span>
              )}
            </td>
            <td className={`${TD} whitespace-nowrap text-zinc-700 dark:text-zinc-300`}>{s.owner}</td>
            <td className={NUM}>{s.enrollments}</td>
            <td className={NUM}>{pct(s.openRate)}</td>
            <td className={NUM}>{pct(s.replyRate)}</td>
            <td className={`${NUM} font-medium`}>{pct(s.meetingRate)}</td>
            <td className={`${NUM} ${s.bounceAlert ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>{pct(s.bounceRate)}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-2">
        <RuleNote>
          Each rate is the share of enrollments with at least one open, reply, booked meeting or bounce. Best and worst are by meeting rate among sequences with{" "}
          {R.sequenceMinEnrollments}+ enrollments (a tie goes to the higher bounce rate as worse). Bounce rates above {pct(R.sequenceBounceAlertAbove)} are red.
        </RuleNote>
      </div>
    </section>
  );
}

function Scorecard({ data, window }: { data: AdrInsightsResult; window: string }) {
  return (
    <section>
      <SectionHeading title="Results per ADR" detail={`Leads created ${window}.`} />
      <Table minWidth="min-w-[640px]" head={[{ label: "ADR" }, ...["Leads owned", `SLA (within ${R.slaHours}h)`, "Meetings booked", `${QUALIFYING} deals created`].map((label) => ({ label, numeric: true }))]}>
        {data.scorecard.map((s) => (
          <tr key={s.adrId} className={ROW}>
            <td className={`${TD} text-zinc-900 dark:text-zinc-100`}>{s.name}</td>
            <td className={NUM}>{s.leadsOwned}</td>
            <td className={NUM}>{pct(s.slaRate)}</td>
            <td className={NUM}>{s.meetingsBooked}</td>
            <td className={NUM}>{s.stage01Created}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-2">
        <RuleNote>
          Meetings booked = sequence enrollments with a meeting booked (in the window), credited to the enrollment&apos;s ADR. Meetings outside a sequence
          aren&apos;t recorded anywhere, so they aren&apos;t counted; SQLs with no sequence meeting: {data.sqlsWithoutSequenceMeeting}. {QUALIFYING} deals created = the
          ADR&apos;s leads that got a deal (the deal&apos;s first stage: {QUALIFYING_DESCRIPTION}).
        </RuleNote>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <>
      <PageHeader title={PAGES.adrInsights.title} description={PAGES.adrInsights.description} />
      <div className="space-y-8">
        <BlockSkeleton className="h-40" />
        <SectionSkeleton columns={8} rows={7} />
        <SectionSkeleton columns={6} rows={4} />
      </div>
    </>
  );
}
