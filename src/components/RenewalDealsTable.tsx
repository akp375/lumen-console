"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ACCOUNT_LINK } from "@/lib/ui";
import type { AdoptionStatus, RenewalDealRow } from "@/lib/metrics";
import { pctChange, shortDate, usd } from "@/lib/format";

// One row per renewal deal (full amount), expandable to the contract's active lines.
// Display only: every number comes from metrics.ts (calcRenewalDeals).

const STATUS_CHIP: Record<AdoptionStatus, string> = {
  "Adoption drop": "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  "Not adopted": "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  "In use": "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function Difference({ row }: { row: RenewalDealRow }) {
  if (row.difference === null) return <span className="text-zinc-400">No active lines</span>;
  if (row.differenceKind === "matches") return <span className="text-zinc-500 dark:text-zinc-400">Matches</span>;
  const up = row.differenceKind === "uplift";
  return (
    <span className={`whitespace-nowrap tabular-nums ${up ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
      {up ? "+" : "−"}
      {usd(Math.abs(row.difference))} {row.differenceKind}
    </span>
  );
}

export function RenewalDealsTable({ rows, showAccount, empty }: { rows: RenewalDealRow[]; showAccount: boolean; empty: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = rows.length > 0 && open.size === rows.length;
  const columns = showAccount ? 8 : 7;

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">{empty}</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <tr>
            <th className="w-10 px-3 py-2">
              <button
                type="button"
                onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((r) => r.opportunityId)))}
                className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                aria-label={allOpen ? "Collapse all deals" : "Expand all deals"}
                title={allOpen ? "Collapse all" : "Expand all"}
              >
                {allOpen ? "▾" : "▸"}
              </button>
            </th>
            {showAccount && <th className="px-3 py-2">Account</th>}
            <th className="px-3 py-2">Stage</th>
            <th className="px-3 py-2">Close</th>
            <th className="px-3 py-2 text-right">Deal Amount</th>
            <th className="px-3 py-2 text-right">Contract Lines</th>
            <th className="px-3 py-2">Difference</th>
            <th className="px-3 py-2 text-right">Downsell Risk</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => {
            const isOpen = open.has(r.opportunityId);
            return (
              <Fragment key={r.opportunityId}>
                <tr className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={() => toggle(r.opportunityId)}>
                  <td className="px-3 py-3">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Hide" : "Show"} contract lines for ${r.accountName}`}
                      className="text-zinc-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(r.opportunityId);
                      }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                  </td>
                  {showAccount && (
                    <td className="px-3 py-3">
                      <Link
                        href={`/accounts/${r.accountId}`}
                        onClick={(e) => e.stopPropagation()}
                        className={ACCOUNT_LINK}
                      >
                        {r.accountName}
                      </Link>
                      <div className="whitespace-nowrap text-xs text-zinc-500">{r.owner}</div>
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-3">{r.stage}</td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums">{shortDate(r.closeDate)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{usd(r.amount)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                    {usd(r.linesArr)}
                    <div className="text-xs text-zinc-500">
                      {r.lines.length} {r.lines.length === 1 ? "line" : "lines"}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Difference row={r} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                    {r.downsellRiskArr > 0 ? <span className="font-medium text-red-700 dark:text-red-400">{usd(r.downsellRiskArr)}</span> : <span className="text-zinc-400">None</span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="bg-zinc-50 dark:bg-zinc-950/40">
                    <td />
                    <td colSpan={columns - 1} className="px-3 pb-3 pt-1">
                      {r.lines.length === 0 ? (
                        <p className="py-2 text-xs text-zinc-500 dark:text-zinc-400">
                          {r.contractId ? "No active lines: this contract has churned." : "This deal isn't linked to a contract."}
                        </p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead className="text-left text-zinc-500 dark:text-zinc-400">
                            <tr>
                              <th className="py-1.5 pr-3 font-medium">Product</th>
                              <th className="py-1.5 pr-3 text-right font-medium">ARR</th>
                              <th className="py-1.5 pr-3 font-medium">Adoption</th>
                              <th className="py-1.5 pr-3 text-right font-medium">Usage, last 30 days</th>
                              <th className="py-1.5 font-medium" />
                            </tr>
                          </thead>
                          <tbody>
                            {r.lines.map((l) => (
                              <tr key={l.lineId} className="border-t border-zinc-200/70 dark:border-zinc-800">
                                <td className="py-1.5 pr-3 font-medium text-zinc-900 dark:text-zinc-100">{l.product}</td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{usd(l.arr)}</td>
                                <td className="py-1.5 pr-3">
                                  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${STATUS_CHIP[l.adoptionStatus]}`}>{l.adoptionStatus}</span>
                                </td>
                                <td className="py-1.5 pr-3 text-right tabular-nums">{pctChange(l.usageChange)}</td>
                                <td className="py-1.5">
                                  {l.downsellRisk && (
                                    <span className="inline-block whitespace-nowrap rounded-md bg-red-600 px-2 py-0.5 font-semibold text-white dark:bg-red-500">Downsell risk</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
