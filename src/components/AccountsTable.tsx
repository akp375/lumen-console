"use client";

import { useMemo, useState } from "react";
import type { AccountEconomicsRow } from "@/lib/metrics";
import { pct, segmentLabel, shortDate, tenureLabel, usd } from "@/lib/format";
import { LIFECYCLE_COLORS } from "./chart-colors";

type SortKey =
  | "name"
  | "segment"
  | "owner"
  | "startDate"
  | "lifecycleStage"
  | "daysToRenewal"
  | "mrr"
  | "tokenCost30d"
  | "grossMargin"
  | "capacityUsed"
  | "flags";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string; numeric: boolean; firstDir: SortDir }[] = [
  { key: "name", label: "Account", numeric: false, firstDir: "asc" },
  { key: "segment", label: "Segment", numeric: false, firstDir: "asc" },
  { key: "owner", label: "Account owner", numeric: false, firstDir: "asc" },
  { key: "startDate", label: "Customer since", numeric: false, firstDir: "asc" },
  { key: "lifecycleStage", label: "Lifecycle", numeric: false, firstDir: "asc" },
  { key: "daysToRenewal", label: "Renewal", numeric: false, firstDir: "asc" },
  { key: "mrr", label: "MRR", numeric: true, firstDir: "desc" },
  { key: "tokenCost30d", label: "30-day token cost", numeric: true, firstDir: "desc" },
  { key: "grossMargin", label: "Gross margin", numeric: true, firstDir: "asc" },
  { key: "capacityUsed", label: "Capacity used", numeric: true, firstDir: "desc" },
  { key: "flags", label: "Flags", numeric: false, firstDir: "desc" },
];

const SEGMENTS = ["all", "enterprise", "mid-market", "SMB"] as const;
const STAGE_ORDER = ["Onboarding", "First year", "Established", "Renewal due"];

// Sort value per column. Flags sort underwater first, then overage.
function sortValue(row: AccountEconomicsRow, key: SortKey): string | number | null {
  switch (key) {
    case "flags":
      return (row.underwater ? 2 : 0) + (row.overage ? 1 : 0);
    case "name":
      return row.name.toLowerCase();
    case "segment":
      return segmentLabel(row.segment);
    case "owner":
      return row.owner;
    case "startDate":
      return row.startDate;
    case "lifecycleStage":
      return row.lifecycleStage === null ? null : STAGE_ORDER.indexOf(row.lifecycleStage);
    default:
      return row[key];
  }
}

const selectClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300";

export function AccountsTable({ rows }: { rows: AccountEconomicsRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("grossMargin");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]>("all");
  const [stage, setStage] = useState("all");
  const [owner, setOwner] = useState("all");

  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner))].sort(), [rows]);

  const visible = useMemo(() => {
    const filtered = rows.filter(
      (r) =>
        (segment === "all" || r.segment === segment) &&
        (stage === "all" || r.lifecycleStage === stage) &&
        (owner === "all" || r.owner === owner),
    );
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // blanks always last
      if (vb === null) return -1;
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.name.localeCompare(b.name);
    });
  }, [rows, segment, stage, owner, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(COLUMNS.find((c) => c.key === key)!.firstDir);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex flex-wrap rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800" role="group" aria-label="Filter by segment">
          {SEGMENTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSegment(s)}
              aria-pressed={segment === s}
              className={`rounded px-3 py-1 text-sm ${
                segment === s
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {s === "all" ? "All segments" : segmentLabel(s)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          Lifecycle
          <select value={stage} onChange={(e) => setStage(e.target.value)} className={selectClass}>
            <option value="all">All stages</option>
            {STAGE_ORDER.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          Owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={selectClass}>
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto text-sm text-zinc-500 dark:text-zinc-400">
          Showing {visible.length} of {rows.length} customers
        </div>
      </div>

      <div className="max-h-[640px] overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900">
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={sortKey === c.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  className={`whitespace-nowrap px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300 ${c.numeric ? "text-right" : "text-left"}`}
                >
                  <button type="button" onClick={() => onSort(c.key)} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white">
                    {c.label}
                    <span className="w-3 text-xs">{sortKey === c.key ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.accountId} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900/60">
                <td className="whitespace-nowrap px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{r.name}</td>
                <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{segmentLabel(r.segment)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-600 dark:text-zinc-400">{r.owner}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.startDate ? (
                    <>
                      <div className="tabular-nums text-zinc-700 dark:text-zinc-300">{shortDate(r.startDate)}</div>
                      {r.tenureMonths !== null && <div className="text-xs text-zinc-500">{tenureLabel(r.tenureMonths)}</div>}
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.lifecycleStage && (
                    <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: LIFECYCLE_COLORS[r.lifecycleStage] }} aria-hidden="true" />
                      {r.lifecycleStage}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {r.renewalDate ? (
                    <>
                      <div className="tabular-nums text-zinc-700 dark:text-zinc-300">{shortDate(r.renewalDate)}</div>
                      {r.daysToRenewal !== null && <div className="text-xs text-zinc-500">in {r.daysToRenewal} days</div>}
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{usd(r.mrr)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{usd(r.tokenCost30d)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${r.underwater ? "font-medium text-red-600 dark:text-red-400" : ""}`}>
                  {pct(r.grossMargin)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${r.overage ? "font-medium text-amber-600 dark:text-amber-400" : ""}`}>
                  {pct(r.capacityUsed, 0)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {r.underwater && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">Underwater</span>
                    )}
                    {r.overage && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">Overage</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-8 text-center text-zinc-500">
                  No customers match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
