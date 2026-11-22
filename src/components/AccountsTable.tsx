"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AccountEconomicsRow } from "@/lib/metrics";
import { pct, segmentLabel, shortDate, tenureLabel, usd } from "@/lib/format";
import { LIFECYCLE_COLORS } from "./chart-colors";
import { DataTable, type Column } from "./DataTable";

const SEGMENTS = ["all", "enterprise", "mid-market", "SMB"] as const;
const STAGE_ORDER = ["Onboarding", "First year", "Established", "Renewal due"];

const COLUMNS: Column<AccountEconomicsRow>[] = [
  {
    key: "name",
    label: "Account",
    render: (r) => (
      <Link href={`/accounts/${r.accountId}`} className="whitespace-nowrap font-medium text-zinc-900 underline-offset-2 hover:underline dark:text-zinc-100">
        {r.name}
      </Link>
    ),
    sortValue: (r) => r.name.toLowerCase(),
  },
  { key: "segment", label: "Segment", render: (r) => segmentLabel(r.segment), sortValue: (r) => segmentLabel(r.segment) },
  { key: "owner", label: "Account Owner", render: (r) => <span className="whitespace-nowrap">{r.owner}</span>, sortValue: (r) => r.owner },
  {
    key: "startDate",
    label: "Customer Since",
    render: (r) =>
      r.startDate ? (
        <div className="whitespace-nowrap">
          <div className="tabular-nums">{shortDate(r.startDate)}</div>
          {r.tenureMonths !== null && <div className="text-xs text-zinc-500">{tenureLabel(r.tenureMonths)}</div>}
        </div>
      ) : (
        "n/a"
      ),
    sortValue: (r) => r.startDate,
  },
  {
    key: "lifecycle",
    label: "Lifecycle",
    render: (r) =>
      r.lifecycleStage && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: LIFECYCLE_COLORS[r.lifecycleStage] }} aria-hidden="true" />
          {r.lifecycleStage}
        </span>
      ),
    sortValue: (r) => (r.lifecycleStage === null ? null : STAGE_ORDER.indexOf(r.lifecycleStage)),
  },
  {
    key: "renewal",
    label: "Renewal",
    render: (r) =>
      r.renewalDate ? (
        <div className="whitespace-nowrap">
          <div className="tabular-nums">{shortDate(r.renewalDate)}</div>
          {r.daysToRenewal !== null && <div className="text-xs text-zinc-500">in {r.daysToRenewal} days</div>}
        </div>
      ) : (
        "n/a"
      ),
    sortValue: (r) => r.daysToRenewal,
  },
  { key: "mrr", label: "MRR", numeric: true, render: (r) => usd(r.mrr), sortValue: (r) => r.mrr },
  { key: "tokenCost", label: "30-Day Token Cost", numeric: true, render: (r) => usd(r.tokenCost30d), sortValue: (r) => r.tokenCost30d },
  {
    key: "margin",
    label: "Gross Margin",
    numeric: true,
    render: (r) => <span className={r.underwater ? "font-medium text-red-600 dark:text-red-400" : ""}>{pct(r.grossMargin)}</span>,
    sortValue: (r) => r.grossMargin,
    firstDir: "asc",
  },
  {
    key: "capacity",
    label: "Capacity Used",
    numeric: true,
    render: (r) => <span className={r.overage ? "font-medium text-amber-600 dark:text-amber-400" : ""}>{pct(r.capacityUsed)}</span>,
    sortValue: (r) => r.capacityUsed,
  },
  {
    key: "flags",
    label: "Flags",
    render: (r) => (
      <div className="flex gap-1">
        {r.underwater && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">Underwater</span>}
        {r.overage && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">Overage</span>}
      </div>
    ),
    // Underwater first, then overage.
    sortValue: (r) => (r.underwater ? 2 : 0) + (r.overage ? 1 : 0),
    firstDir: "desc",
  },
];

const selectClass =
  "rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300";

export function AccountsTable({ rows }: { rows: AccountEconomicsRow[] }) {
  const [segment, setSegment] = useState<(typeof SEGMENTS)[number]>("all");
  const [stage, setStage] = useState("all");
  const [owner, setOwner] = useState("all");

  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner))].sort(), [rows]);
  const visible = useMemo(
    () =>
      rows.filter(
        (r) => (segment === "all" || r.segment === segment) && (stage === "all" || r.lifecycleStage === stage) && (owner === "all" || r.owner === owner),
      ),
    [rows, segment, stage, owner],
  );

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
                segment === s ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
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

      <DataTable
        columns={COLUMNS}
        rows={visible}
        rowKey={(r) => r.accountId}
        defaultSort={{ key: "margin", dir: "asc" }}
        empty={{ title: "No customers match these filters", detail: "Try a different segment, lifecycle stage or owner." }}
        minWidth="min-w-[1180px]"
      />
    </div>
  );
}
