"use client";

import { useState } from "react";
import type { RenewalRiskResult, RenewalRiskRow, UpcomingRenewalRow, UpcomingRenewalsQuarter } from "@/lib/metrics";
import { explainRenewalRisk, flagRenewalRisk, type AiNote } from "@/app/renewals/actions";
import { pct, pctChange, segmentLabel, shortDate, signedInt, usd, usdCompact } from "@/lib/format";
import { PAGES } from "@/lib/pages";
import { DataTable, type Column } from "./DataTable";
import { PageHeader } from "./PageHeader";
import { SectionSkeleton } from "./Skeleton";
import { AiCell, type AiState, BackButton, ErrorNote, FlagButton, LimitNotice, RiskBadge, RuleNote, SectionHeading, SignalChips, Stat } from "./RiskUi";

// Default order: High first, then Medium, then Low; within a level, soonest renewal first.
const LEVEL_RANK = { High: 0, Medium: 1, Low: 2 } as const;
const riskOrder = (r: RenewalRiskRow) => LEVEL_RANK[r.level] * 10_000 + r.daysToRenewal;

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
    { key: "risk", label: "Renewal Risk", render: (r) => <RiskBadge level={r.level} />, sortValue: riskOrder, firstDir: "asc" },
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="High risk"
                value={`${data.byLevel.High.count} ${data.byLevel.High.count === 1 ? "account" : "accounts"}`}
                detail={`${usd(data.byLevel.High.arr)} ARR at risk · 2+ rules fired`}
                tone={data.byLevel.High.count ? "alert" : "default"}
              />
              <Stat
                label="Medium risk"
                value={`${data.byLevel.Medium.count} ${data.byLevel.Medium.count === 1 ? "account" : "accounts"}`}
                detail={`${usd(data.byLevel.Medium.arr)} ARR at risk · 1 rule fired`}
                tone={data.byLevel.Medium.count ? "warn" : "default"}
              />
              <Stat
                label="Total at-risk ARR"
                value={usdCompact(data.atRiskArr)}
                detail={`${pct(data.renewingArr > 0 ? data.atRiskArr / data.renewingArr : null)} of renewing ARR · ${data.rows.length} of ${data.renewingCount} accounts`}
              />
              <Stat label={`Renewing in next ${windowDays} days`} value={String(data.renewingCount)} detail={`${usd(data.renewingArr)} ARR up for renewal`} />
            </div>
            {aiNotice && <LimitNotice message={aiNotice} />}
            {aiError && <ErrorNote message={aiError} />}
            <section>
              <SectionHeading title="At-Risk Renewals" detail={`Renewing within ${windowDays} days · High first, then soonest renewal`} />
              <DataTable
                columns={riskColumns}
                rows={data.rows}
                rowKey={(r) => r.accountId}
                defaultSort={{ key: "risk", dir: "asc" }}
                empty={{ title: "No renewals at risk", detail: `No customer renewing in the next ${windowDays} days matches the risk rules.` }}
                minWidth="min-w-[1180px]"
              />
              <div className="mt-2 space-y-1">
                <RuleNote>{rules}</RuleNote>
                <RuleNote>
                  Risk level (the same value synced to HubSpot): 2 or more rules = High, 1 rule = Medium. Customers with no rules fired, or renewing
                  later than {windowDays} days, are Low and aren&apos;t listed here.
                </RuleNote>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
