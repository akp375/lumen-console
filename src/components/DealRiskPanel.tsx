"use client";

import { useState } from "react";
import type { DealRiskResult } from "@/lib/metrics";
import { explainDealRisk, flagDealRisk, type AiNote } from "@/app/deal-risk/actions";
import { pct, shortDate, usd, usdCompact } from "@/lib/format";
import { AiCell, type AiState, cellClass, ErrorNote, FlagButton, rowClass, SignalChips, Stat, TableShell } from "./RiskUi";

const HEADERS = [
  { label: "Deal" },
  { label: "Account" },
  { label: "Amount", numeric: true },
  { label: "Stage" },
  { label: "Days in stage", numeric: true },
  { label: "Close date" },
  { label: "Rules fired" },
  { label: "Claude: reason and next step" },
];

const TYPE_LABEL: Record<string, string> = { new: "New business", expansion: "Expansion", renewal: "Renewal" };

export function DealRiskPanel() {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<DealRiskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, AiNote>>({});
  const [ai, setAi] = useState<AiState>("idle");
  const [aiError, setAiError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setAiError(null);
    setNotes({});
    const res = await flagDealRisk();
    setBusy(false);
    if (res.error || !res.data) return setError(res.error ?? "Something went wrong.");
    setData(res.data);
    if (res.data.rows.length === 0) return;
    setAi("loading");
    const explained = await explainDealRisk();
    if (explained.error) {
      setAi("error");
      setAiError(`Claude notes unavailable: ${explained.error}`);
    } else {
      setNotes(explained.notes ?? {});
      setAi("done");
    }
  };

  return (
    <div className="space-y-6">
      <FlagButton onClick={run} busy={busy} label="Flag deal risk" />
      {error && <ErrorNote message={error} />}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label="At-risk pipeline"
              value={usdCompact(data.atRiskPipeline)}
              detail={`${usd(data.atRiskPipeline)} across ${data.rows.length} deals`}
              tone={data.rows.length ? "alert" : "default"}
            />
            <Stat label="Open pipeline" value={usdCompact(data.openPipeline)} detail={`${data.openCount} open deals`} />
            <Stat
              label="Share of pipeline at risk"
              value={pct(data.openPipeline > 0 ? data.atRiskPipeline / data.openPipeline : null, 0)}
              detail={`${data.rows.length} of ${data.openCount} open deals flagged`}
            />
          </div>
          {aiError && <ErrorNote message={aiError} />}

          {data.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">No open deals match the risk rules.</p>
          ) : (
            <TableShell headers={HEADERS}>
              {data.rows.map((r) => (
                <tr key={r.opportunityId} className={rowClass}>
                  <td className={`${cellClass} whitespace-nowrap`}>
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.opportunityId}</div>
                    <div className="text-xs text-zinc-500">{TYPE_LABEL[r.type] ?? r.type}</div>
                  </td>
                  <td className={`${cellClass} whitespace-nowrap`}>{r.accountName}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>{usd(r.amount)}</td>
                  <td className={`${cellClass} whitespace-nowrap`}>{r.stage}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>
                    <div>{r.daysInStage ?? "n/a"}</div>
                    <div className="text-xs text-zinc-500">max {r.maxDaysInStage}</div>
                  </td>
                  <td className={`${cellClass} whitespace-nowrap tabular-nums`}>{shortDate(r.closeDate)}</td>
                  <td className={cellClass}>
                    <SignalChips signals={r.signals} />
                  </td>
                  <td className={cellClass}>
                    <AiCell state={ai} note={notes[r.opportunityId]} />
                  </td>
                </tr>
              ))}
            </TableShell>
          )}
        </>
      )}
    </div>
  );
}
