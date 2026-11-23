import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ADR_RULES, LEAD_FUNNEL, getAdrInsights, type AdrInsightsResult } from "@/lib/metrics";
import { getLatestAdrMemo } from "@/lib/adr-memo";
import { PAGES, tabTitle } from "@/lib/pages";
import { LEAD_STAGE_DESCRIPTIONS, QUALIFYING, QUALIFYING_DESCRIPTION, leadStageLabel, pct, shortDate } from "@/lib/format";
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
      {f.reached.map((n, i) => (
        <td key={LEAD_FUNNEL[i].stage} className={NUM}>
          <div>{n}</div>
          {i > 0 && <div className="text-xs text-zinc-500 dark:text-zinc-400">{pct(f.stepRates[i])}</div>}
        </td>
      ))}
      <td className={`${NUM} font-medium`}>{pct(f.overall)}</td>
      <td className={`${NUM} border-l border-zinc-200 dark:border-zinc-800`}>{f.disqualified}</td>
      <td className={NUM}>{f.nurture}</td>
      <td className={NUM}>{f.open}</td>
    </>
  );
  return (
    <section>
      <SectionHeading title="Funnel by Lead Source" detail={`Leads created ${window}, best New-to-Converted rate first. Under each count: conversion from the stage before.`} />
      <Table
        minWidth="min-w-[1040px]"
        head={[
          { label: "Source" },
          ...LEAD_FUNNEL.map((f) => ({ label: leadStageLabel(f.stage), numeric: true })),
          { label: "New → Converted", numeric: true },
          ...["Disqualified", "Nurture", "Still open"].map((label) => ({ label, numeric: true })),
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
          {LEAD_FUNNEL.map((f) => `${leadStageLabel(f.stage)}: ${LEAD_STAGE_DESCRIPTIONS[f.stage]}`).join(". ")}. Endings: Disqualified (with a reason) or
          Nurture (returned to marketing). Counts are leads that reached each stage. Meeting booked creates the {QUALIFYING} deal ({QUALIFYING_DESCRIPTION}).
          Deals opened before that stage existed went straight to an opportunity, so they convert on the day of the meeting. Recent leads have had less time to
          convert.
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
  const cols = ["Enrollments", "Emails sent", "Open", "Click-through", "Reply", "Bounce", "Call booked (per enrollment)"];
  return (
    <section>
      <SectionHeading title="Sequence Performance" detail={`Enrollments from ${window}, highest call-booked rate first.`} />
      <Table minWidth="min-w-[1000px]" head={[{ label: "Sequence" }, { label: "Used by" }, ...cols.map((label) => ({ label, numeric: true }))]}>
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
            <td className={`${TD} text-zinc-700 dark:text-zinc-300`}>
              {s.usedBy.length ? s.usedBy.join(", ") : "No ADR"}
              {s.unassignedEnrollments > 0 && <span className="text-xs text-zinc-500 dark:text-zinc-400"> (+{s.unassignedEnrollments} unassigned)</span>}
            </td>
            <td className={NUM}>{s.enrollments}</td>
            <td className={NUM}>{s.emailsSent}</td>
            <td className={NUM}>{pct(s.openRate)}</td>
            <td className={NUM}>{pct(s.clickRate)}</td>
            <td className={NUM}>{pct(s.replyRate)}</td>
            <td className={`${NUM} ${s.bounceAlert ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>{pct(s.bounceRate)}</td>
            <td className={`${NUM} font-medium`}>{pct(s.callBookedRate)}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-2 space-y-1">
        <RuleNote>
          Rates per email sent: <strong className="font-medium">Open</strong> = emails opened ÷ emails sent. <strong className="font-medium">Click-through</strong>{" "}
          = emails with a link clicked ÷ emails sent. <strong className="font-medium">Reply</strong> = replies ÷ emails sent.{" "}
          <strong className="font-medium">Bounce</strong> = emails that bounced ÷ emails sent (red above {pct(R.sequenceBounceAlertAbove)}).{" "}
          <strong className="font-medium">Call booked</strong> is per enrollment: enrollments that booked a call ÷ enrollments. A booked call is a meeting with an AE
          or an ADR&apos;s qualifying call, so calls booked can be more than meetings booked.
        </RuleNote>
        <RuleNote>
          Used by = the ADRs who enrolled leads in the sequence, most enrollments first. Best and worst are by call-booked rate among sequences with{" "}
          {R.sequenceMinEnrollments}+ enrollments (a tie goes to the higher bounce rate as worse).
        </RuleNote>
      </div>
    </section>
  );
}

function Scorecard({ data, window }: { data: AdrInsightsResult; window: string }) {
  const cols = ["Leads owned", `SLA (within ${R.slaHours}h)`, "Sales accepted", "Sales qualified", "Meetings booked", `${QUALIFYING} deals created`, "Converted"];
  return (
    <section>
      <SectionHeading title="Results per ADR" detail={`Leads created ${window}; stages reached in the same period.`} />
      <Table minWidth="min-w-[860px]" head={[{ label: "ADR" }, ...cols.map((label) => ({ label, numeric: true }))]}>
        {data.scorecard.map((s) => (
          <tr key={s.adrId} className={ROW}>
            <td className={`${TD} text-zinc-900 dark:text-zinc-100`}>{s.name}</td>
            <td className={NUM}>{s.leadsOwned}</td>
            <td className={NUM}>{pct(s.slaRate)}</td>
            <td className={NUM}>{s.salesAccepted}</td>
            <td className={NUM}>{s.salesQualified}</td>
            <td className={NUM}>{s.meetingsBooked}</td>
            <td className={NUM}>{s.qualifyingDealsCreated}</td>
            <td className={NUM}>{s.converted}</td>
          </tr>
        ))}
      </Table>
      <div className="mt-2">
        <RuleNote>
          Leads owned and {QUALIFYING} deals created count the ADR&apos;s leads created in the period; the stage columns count leads that reached the stage in the
          period. Meetings booked = leads that reached Meeting booked (a meeting set with an AE); every one has a {QUALIFYING} deal ({QUALIFYING_DESCRIPTION}).
          SLA = MQLs first touched within {R.slaHours} hours.
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
