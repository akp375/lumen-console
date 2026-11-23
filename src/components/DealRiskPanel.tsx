"use client";

import { useState } from "react";
import type { DealRiskResult, DealRiskRow, UpcomingDealRow, UpcomingDealsQuarter } from "@/lib/metrics";
import { explainDealRisk, flagDealRisk, type AiNote } from "@/app/pipeline/deal-risk/actions";
import { pct, shortDate, usd, usdCompact } from "@/lib/format";
import { PAGES } from "@/lib/pages";
import { DataTable, type Column } from "./DataTable";
import { PageHeader } from "./PageHeader";
import { SectionSkeleton } from "./Skeleton";
import { AiCell, type AiState, BackButton, ErrorNote, FlagButton, LimitNotice, RuleNote, SectionHeading, SignalChips, Stat } from "./RiskUi";


const TYPE_LABEL: Record<string, string> = { new: "New business", expansion: "Expansion", renewal: "Renewal" };
const STAGE_ORDER = ["Discovery", "Demo", "Proposal", "Negotiation"];

const deal = (r: { opportunityId: string; type: string }) => (
  <>
    <div className="whitespace-nowrap font-medium text-zinc-900 dark:text-zinc-100">{r.opportunityId}</div>
    <div className="whitespace-nowrap text-xs text-zinc-500">{TYPE_LABEL[r.type] ?? r.type}</div>
  </>
);
const nowrap = (text: string) => <span className="whitespace-nowrap">{text}</span>;

const UPCOMING_COLUMNS: Column<UpcomingDealRow>[] = [
  { key: "deal", label: "Deal", render: deal, sortValue: (r) => r.opportunityId },
  { key: "account", label: "Account", render: (r) => nowrap(r.accountName), sortValue: (r) => r.accountName.toLowerCase() },
  { key: "stage", label: "Stage", render: (r) => r.stage, sortValue: (r) => STAGE_ORDER.indexOf(r.stage) },
  { key: "amount", label: "Amount", numeric: true, render: (r) => usd(r.amount), sortValue: (r) => r.amount },
  { key: "probability", label: "Probability", numeric: true, render: (r) => pct(r.probability / 100), sortValue: (r) => r.probability },
  { key: "close", label: "Close Date", render: (r) => nowrap(shortDate(r.closeDate)), sortValue: (r) => r.closeDate },
];

function UpcomingDeals({ quarters }: { quarters: UpcomingDealsQuarter[] }) {
  return (
    <div className="space-y-8">
      {quarters.map((q, i) => (
        <section key={q.quarter.label}>
          <SectionHeading
            title={`Top ${q.top.length} Deals Closing ${i === 0 ? "This Quarter" : "Next Quarter"} (${q.quarter.label})`}
            detail={`${q.count} open deals · ${usd(q.totalAmount)} pipeline · ${usd(q.weightedAmount)} weighted`}
          />
          <DataTable
            columns={UPCOMING_COLUMNS}
            rows={q.top}
            rowKey={(r) => r.opportunityId}
            defaultSort={{ key: "amount", dir: "desc" }}
            empty={{ title: `No deals closing in ${q.quarter.label}`, detail: "No open deal has a close date in this quarter." }}
            minWidth="min-w-[760px]"
          />
        </section>
      ))}
    </div>
  );
}

export function DealRiskPanel({ rules, upcoming }: { rules: string; upcoming: UpcomingDealsQuarter[] }) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<DealRiskResult | null>(null);
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
    const res = await flagDealRisk();
    setBusy(false);
    if (res.error || !res.data) return setError(res.error ?? "Something went wrong.");
    setData(res.data);
    if (res.data.rows.length === 0) return;
    setAi("loading");
    const explained = await explainDealRisk();
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

  const riskColumns: Column<DealRiskRow>[] = [
    { key: "deal", label: "Deal", render: deal, sortValue: (r) => r.opportunityId },
    { key: "account", label: "Account", render: (r) => nowrap(r.accountName), sortValue: (r) => r.accountName.toLowerCase() },
    { key: "amount", label: "Amount", numeric: true, render: (r) => usd(r.amount), sortValue: (r) => r.amount },
    { key: "stage", label: "Stage", render: (r) => r.stage, sortValue: (r) => STAGE_ORDER.indexOf(r.stage) },
    {
      key: "days",
      label: "Days in Stage",
      numeric: true,
      render: (r) => (
        <>
          <div>{r.daysInStage ?? "n/a"}</div>
          <div className="text-xs text-zinc-500">max {r.maxDaysInStage}</div>
        </>
      ),
      sortValue: (r) => r.daysInStage,
    },
    { key: "close", label: "Close Date", render: (r) => nowrap(shortDate(r.closeDate)), sortValue: (r) => r.closeDate },
    { key: "signals", label: "Rules Fired", render: (r) => <SignalChips signals={r.signals} />, sortValue: (r) => r.signals.length, firstDir: "desc" },
    { key: "ai", label: "Claude: Reason and Next Step", render: (r) => <AiCell state={ai} note={notes[r.opportunityId]} /> },
  ];

  return (
    <>
      <PageHeader
        title={PAGES.dealRisk.title}
        description={PAGES.dealRisk.description}
        actions={
          <>
            {data && !busy && <BackButton onClick={() => setData(null)} label="Back to upcoming deals" />}
            <FlagButton onClick={run} busy={busy || ai === "loading"} busyLabel={ai === "loading" ? "Claude is writing…" : "Checking…"} label="Flag deal risk" />
          </>
        }
      />
      <div className="space-y-6">
        {error && <ErrorNote message={error} />}
        {busy && <SectionSkeleton columns={8} rows={8} />}
        {!busy && !data && <UpcomingDeals quarters={upcoming} />}

        {!busy && data && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat
                label="At-risk pipeline"
                value={usdCompact(data.atRiskPipeline)}
                detail={`${usd(data.atRiskPipeline)} across ${data.rows.length} deals`}
                tone={data.rows.length ? "alert" : "default"}
              />
              <Stat label="Open pipeline" value={usdCompact(data.openPipeline)} detail={`${usd(data.openPipeline)} across ${data.openCount} open deals`} />
              <Stat
                label="Share of pipeline at risk"
                value={pct(data.openPipeline > 0 ? data.atRiskPipeline / data.openPipeline : null)}
                detail={`${data.rows.length} of ${data.openCount} open deals flagged`}
              />
            </div>
            {aiNotice && <LimitNotice message={aiNotice} />}
            {aiError && <ErrorNote message={aiError} />}
            <section>
              <SectionHeading title="At-Risk Deals" detail="Open deals with at least one warning sign, largest first" />
              <DataTable
                columns={riskColumns}
                rows={data.rows}
                rowKey={(r) => r.opportunityId}
                defaultSort={{ key: "amount", dir: "desc" }}
                empty={{ title: "No deals at risk", detail: "No open deal matches the risk rules." }}
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
