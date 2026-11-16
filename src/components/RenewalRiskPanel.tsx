"use client";

import { useState } from "react";
import type { RenewalRiskResult } from "@/lib/metrics";
import { explainRenewalRisk, flagRenewalRisk, type AiNote } from "@/app/renewals/actions";
import { pct, shortDate, usd, usdCompact } from "@/lib/format";
import { AiCell, type AiState, cellClass, ErrorNote, FlagButton, rowClass, SignalChips, signed, Stat, TableShell } from "./RiskUi";

const HEADERS = [
  { label: "Account" },
  { label: "ARR", numeric: true },
  { label: "Renewal" },
  { label: "NPS", numeric: true },
  { label: "NPS change", numeric: true },
  { label: "Usage trend", numeric: true },
  { label: "Margin", numeric: true },
  { label: "Rules fired" },
  { label: "Claude: reason and next action" },
];

export function RenewalRiskPanel({ windowDays }: { windowDays: number }) {
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<RenewalRiskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, AiNote>>({});
  const [ai, setAi] = useState<AiState>("idle");
  const [aiError, setAiError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setAiError(null);
    setNotes({});
    const res = await flagRenewalRisk();
    setBusy(false);
    if (res.error || !res.data) return setError(res.error ?? "Something went wrong.");
    setData(res.data);
    if (res.data.rows.length === 0) return;
    setAi("loading");
    const explained = await explainRenewalRisk();
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
      <FlagButton onClick={run} busy={busy} label="Flag renewal risk" />
      {error && <ErrorNote message={error} />}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="At-risk ARR" value={usdCompact(data.atRiskArr)} detail={`${usd(data.atRiskArr)} across ${data.rows.length} accounts`} tone={data.rows.length ? "alert" : "default"} />
            <Stat label={`Renewing in next ${windowDays} days`} value={String(data.renewingCount)} detail={`${usdCompact(data.renewingArr)} ARR up for renewal`} />
            <Stat
              label="Share of renewing ARR at risk"
              value={pct(data.renewingArr > 0 ? data.atRiskArr / data.renewingArr : null, 0)}
              detail={`${data.rows.length} of ${data.renewingCount} renewing accounts flagged`}
            />
          </div>
          {aiError && <ErrorNote message={aiError} />}

          {data.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">No renewals in the window match the risk rules.</p>
          ) : (
            <TableShell headers={HEADERS}>
              {data.rows.map((r) => (
                <tr key={r.accountId} className={rowClass}>
                  <td className={`${cellClass} whitespace-nowrap`}>
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.name}</div>
                    <div className="text-xs text-zinc-500">{r.owner}</div>
                  </td>
                  <td className={`${cellClass} text-right tabular-nums`}>{usd(r.arr)}</td>
                  <td className={`${cellClass} whitespace-nowrap`}>
                    <div className="tabular-nums">{shortDate(r.renewalDate)}</div>
                    <div className="text-xs text-zinc-500">in {r.daysToRenewal} days</div>
                  </td>
                  <td className={`${cellClass} text-right tabular-nums`}>{r.latestNps ?? "n/a"}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>{signed(r.npsChange)}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>{r.usageChange === null ? "n/a" : signed(Math.round(r.usageChange * 100), "%")}</td>
                  <td className={`${cellClass} text-right tabular-nums`}>{pct(r.grossMargin)}</td>
                  <td className={cellClass}>
                    <SignalChips signals={r.signals} />
                  </td>
                  <td className={cellClass}>
                    <AiCell state={ai} note={notes[r.accountId]} />
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
