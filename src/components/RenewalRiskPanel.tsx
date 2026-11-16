"use client";

import { useState } from "react";
import type { RenewalRiskResult, RenewalRiskRow, UpcomingRenewalRow, UpcomingRenewalsQuarter } from "@/lib/metrics";
import { explainRenewalRisk, flagRenewalRisk, type AiNote } from "@/app/renewals/actions";
import { pct, pctChange, segmentLabel, shortDate, signedInt, usd, usdCompact } from "@/lib/format";
import { PAGES } from "@/lib/pages";
import { DataTable, type Column } from "./DataTable";
import { PageHeader } from "./PageHeader";
import { SectionSkeleton } from "./Skeleton";
import { AiCell, type AiState, BackButton, ErrorNote, FlagButton, LimitNotice, RuleNote, SectionHeading, SignalChips, Stat } from "./RiskUi";


const account = (r: { name: string; owner: string }) => (
  <>
    <div className="whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-100">{r.name}</div>
    <div className="whitespace-nowrap text-xs text-zinc-500">{r.owner}</div>
  </>
);
const renewal = (r: { renewalDate: string; daysToRenewal: number }) => (
  <div className="whitespace-nowrap">
    <div className="tabular-nums">{shortDate(r.renewalDate)}</div>
    <div className="text-xs text-zinc-500">in {r.daysToRenewal} days</div>
  </div>
);

const UPCOMING_COLUMNS: Column<UpcomingRenewalRow>[] = [
  { key: "name", label: "Account", render: account, sortValue: (r) => r.name.toLowerCase() },
  { key: "segment", label: "Segment", render: (r) => segmentLabel(r.segment), sortValue: (r) => segmentLabel(r.segment) },
  { key: "arr", label: "ARR", numeric: true, render: (r) => usd(r.arr), sortValue: (r) => r.arr },
  { key: "renewal", label: "Renewal", render: renewal, sortValue: (r) => r.renewalDate },
];

function UpcomingRenewals({ quarters }: { quarters: UpcomingRenewalsQuarter[] }) {
  return (
    <div className="space-y-8">
      {quarters.map((q, i) => (
        <section key={q.quarter.label}>
          <SectionHeading
            title={`Top ${q.top.length} Renewals ${i === 0 ? "This Quarter" : "Next Quarter"} (${q.quarter.label})`}
            detail={`${q.count} renewals · ${usd(q.totalArr)} ARR${i === 0 ? ` · today to ${shortDate(q.quarter.end)}` : ""}`}
          />
          <DataTable
            columns={UPCOMING_COLUMNS}
            rows={q.top}
            rowKey={(r) => r.accountId}
            defaultSort={{ key: "arr", dir: "desc" }}
            empty={{ title: `No renewals in ${q.quarter.label}`, detail: "Nothing comes up for renewal in this quarter." }}
            minWidth="min-w-[640px]"
          />
        </section>
      ))}
    </div>
  );
}

export function RenewalRiskPanel({ windowDays, rules, upcoming }: { windowDays: number; rules: string; upcoming: UpcomingRenewalsQuarter[] }) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<RenewalRiskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, AiNote>>({});
  const [ai, setAi] = useState<AiState>("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const run = async () => {
    if (busy || ai === "loading") return; // one run at a time
    setBusy(true);
    setError(null);
    setAiError(null);
    setAiNotice(null);
    setNotes({});
    const res = await flagRenewalRisk();
    setBusy(false);
    if (res.error || !res.data) return setError(res.error ?? "Something went wrong.");
    setData(res.data);
    if (res.data.rows.length === 0) return;
    setAi("loading");
    const explained = await explainRenewalRisk();
    if (explained.notice) {
      setAi("error");
      setAiNotice(explained.notice);
    } else if (explained.error) {
      setAi("error");
      setAiError(`Claude notes unavailable: ${explained.error}`);
    } else {
      setNotes(explained.notes ?? {});
      setAi("done");
    }
  };

  const riskColumns: Column<RenewalRiskRow>[] = [
    { key: "name", label: "Account", render: account, sortValue: (r) => r.name.toLowerCase() },
    { key: "arr", label: "ARR", numeric: true, render: (r) => usd(r.arr), sortValue: (r) => r.arr },
    { key: "renewal", label: "Renewal", render: renewal, sortValue: (r) => r.renewalDate },
    { key: "nps", label: "NPS", numeric: true, render: (r) => r.latestNps ?? "n/a", sortValue: (r) => r.latestNps, firstDir: "asc" },
    { key: "npsChange", label: "NPS Change", numeric: true, render: (r) => signedInt(r.npsChange), sortValue: (r) => r.npsChange, firstDir: "asc" },
    { key: "usage", label: "Usage Trend", numeric: true, render: (r) => pctChange(r.usageChange), sortValue: (r) => r.usageChange, firstDir: "asc" },
    { key: "margin", label: "Margin", numeric: true, render: (r) => pct(r.grossMargin), sortValue: (r) => r.grossMargin, firstDir: "asc" },
    { key: "signals", label: "Rules Fired", render: (r) => <SignalChips signals={r.signals} />, sortValue: (r) => r.signals.length, firstDir: "desc" },
    { key: "ai", label: "Claude: Reason and Next Action", render: (r) => <AiCell state={ai} note={notes[r.accountId]} /> },
  ];

  return (
    <>
      <PageHeader
        title={PAGES.renewals.title}
        description={PAGES.renewals.description}
        actions={
          <>
            {data && !busy && <BackButton onClick={() => setData(null)} label="Back to upcoming renewals" />}
            <FlagButton onClick={run} busy={busy || ai === "loading"} busyLabel={ai === "loading" ? "Claude is writing…" : "Checking…"} label="Flag renewal risk" />
          </>
        }
      />
      <div className="space-y-6">
        {error && <ErrorNote message={error} />}
        {busy && <SectionSkeleton columns={8} rows={8} />}
        {!busy && !data && <UpcomingRenewals quarters={upcoming} />}

        {!busy && data && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="At-risk ARR" value={usdCompact(data.atRiskArr)} detail={`${usd(data.atRiskArr)} across ${data.rows.length} accounts`} tone={data.rows.length ? "alert" : "default"} />
              <Stat label={`Renewing in next ${windowDays} days`} value={String(data.renewingCount)} detail={`${usd(data.renewingArr)} ARR up for renewal`} />
              <Stat
                label="Share of renewing ARR at risk"
                value={pct(data.renewingArr > 0 ? data.atRiskArr / data.renewingArr : null)}
                detail={`${data.rows.length} of ${data.renewingCount} renewing accounts flagged`}
              />
            </div>
            {aiNotice && <LimitNotice message={aiNotice} />}
            {aiError && <ErrorNote message={aiError} />}
            <section>
              <SectionHeading title="At-Risk Renewals" detail={`Renewing within ${windowDays} days, soonest first`} />
              <DataTable
                columns={riskColumns}
                rows={data.rows}
                rowKey={(r) => r.accountId}
                defaultSort={{ key: "renewal", dir: "asc" }}
                empty={{ title: "No renewals at risk", detail: `No customer renewing in the next ${windowDays} days matches the risk rules.` }}
                minWidth="min-w-[1100px]"
              />
              <div className="mt-2">
                <RuleNote>{rules}</RuleNote>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
