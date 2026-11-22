"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { HealthPageData, HealthPageRow } from "@/lib/metrics";
import { segmentLabel, usd } from "@/lib/format";
import { ACCOUNT_LINK } from "@/lib/ui";
import { Stat } from "./RiskUi";
import { AdoptionDropChips, HealthBadge, TrendArrow } from "./HealthUi";

// The Health page's cards and table, with segment and CSM filters and sorting.
// Display only: every number (scores, ARR, totals per filter) comes from metrics.ts (getHealth).

type SortKey = "score" | "arr";
type Sort = { key: SortKey; dir: "asc" | "desc" };

const filterKey = (segment: string, csm: string) => `${segment}|${csm}`; // same as healthFilterKey in metrics.ts

export function HealthExplorer({ data, rules }: { data: HealthPageData; rules: { greenFrom: number; amberFrom: number; decliningDrop: number } }) {
  const router = useRouter();
  const [segment, setSegment] = useState("all");
  const [csm, setCsm] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "score", dir: "asc" });

  const summary = data.summaries[filterKey(segment, csm)];
  const rows = useMemo(() => {
    const shown = data.rows.filter((r) => (segment === "all" || r.segment === segment) && (csm === "all" || r.csm === csm));
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...shown].sort((a, b) => sign * (a[sort.key] - b[sort.key]) || a.name.localeCompare(b.name));
  }, [data.rows, segment, csm, sort]);

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "arr" ? "desc" : "asc" }));
  const of = `of ${summary.customers} customers`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Filter label="Segment" value={segment} onChange={setSegment} options={data.segments.map((s) => [s, segmentLabel(s)])} />
        <Filter label="CSM" value={csm} onChange={setCsm} options={data.csms.map((c) => [c, c])} />
        {(segment !== "all" || csm !== "all") && (
          <button
            type="button"
            onClick={() => {
              setSegment("all");
              setCsm("all");
            }}
            className="pb-2 text-sm text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Healthy (${rules.greenFrom}+)`} value={String(summary.green)} detail={of} tone="good" />
        <Stat label={`Watch (${rules.amberFrom}–${rules.greenFrom - 1})`} value={String(summary.amber)} detail={of} tone="warn" />
        <Stat label={`At risk (below ${rules.amberFrom})`} value={String(summary.red)} detail={
            <>
              {of}
              <span className="mt-1 block text-sm font-semibold tabular-nums text-red-600 dark:text-red-400">{usd(summary.arrAtRisk)} ARR at risk</span>
            </>
          }
          tone="alert"
        />
        <Stat label="Declining" value={String(summary.declining)} detail={`Down ${rules.decliningDrop}+ points on last week`} tone={summary.declining > 0 ? "alert" : "default"} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2">Account</th>
              <th className="px-4 py-2">CSM</th>
              <SortHeader label="ARR" sortKey="arr" sort={sort} onClick={toggle} align="right" />
              <SortHeader label="Health" sortKey="score" sort={sort} onClick={toggle} align="center" />
              <th className="px-4 py-2">Week</th>
              <th className="px-4 py-2">Adoption Drop</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-zinc-500">
                  No customers match these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <Row key={r.accountId} r={r} onOpen={() => router.push(`/accounts/${r.accountId}`)} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ r, onOpen }: { r: HealthPageRow; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50" onClick={onOpen}>
      <td className="px-4 py-3">
        <Link href={`/accounts/${r.accountId}`} onClick={(e) => e.stopPropagation()} className={ACCOUNT_LINK}>
          {r.name}
        </Link>
        <div className="text-xs text-zinc-500">{segmentLabel(r.segment)}</div>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.csm ?? "None"}</td>
      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{usd(r.arr)}</td>
      <td className="px-4 py-3 text-center">
        <HealthBadge score={r.score} band={r.band} />
      </td>
      <td className="px-4 py-3">
        <TrendArrow change={r.change} declining={r.declining} />
      </td>
      <td className="px-4 py-3">
        <AdoptionDropChips products={r.lines.filter((l) => l.adoptionDrop).map((l) => l.product)} />
      </td>
      <td className="px-4 py-3">
        {r.declining && <span className="whitespace-nowrap rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500">Declining</span>}
      </td>
    </tr>
  );
}

function SortHeader({ label, sortKey, sort, onClick, align }: { label: string; sortKey: SortKey; sort: Sort; onClick: (k: SortKey) => void; align: "right" | "center" }) {
  const active = sort.key === sortKey;
  return (
    <th className={`px-4 py-2 ${align === "right" ? "text-right" : "text-center"}`} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onClick(sortKey)} className={`inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 ${active ? "text-zinc-900 dark:text-zinc-100" : ""}`}>
        {label}
        <span aria-hidden className={active ? "" : "text-zinc-300 dark:text-zinc-600"}>
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "▲▼"}
        </span>
      </button>
    </th>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-48 rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <option value="all">All</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
