"use client";

import { useMemo, useState, type ReactNode } from "react";

// One table for the whole app: sticky header, subtle row hover, click-to-sort
// columns with an arrow, and a friendly empty state. Display only.

export type SortDir = "asc" | "desc";
type SortValue = string | number | null;

export type Column<T> = {
  key: string;
  label: string;
  numeric?: boolean; // right-aligned, tabular figures
  render: (row: T) => ReactNode;
  /** Omit to make the column not sortable. Nulls always sort last. */
  sortValue?: (row: T) => SortValue;
  firstDir?: SortDir; // direction on first click (numbers usually "desc")
  className?: string; // extra cell classes
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  defaultSort,
  empty,
  minWidth = "min-w-[900px]",
  maxHeight = "max-h-[640px]",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: SortDir };
  empty: { title: string; detail?: string };
  minWidth?: string;
  maxHeight?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !col?.sortValue) return rows;
    const value = col.sortValue;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === vb) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
      return (va < vb ? -1 : 1) * dir;
    });
  }, [rows, columns, sort]);

  const onSort = (col: Column<T>) => {
    if (!col.sortValue) return;
    setSort((s) => (s?.key === col.key ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: col.firstDir ?? (col.numeric ? "desc" : "asc") }));
  };

  return (
    <div className={`${maxHeight} overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950`}>
      <table className={`w-full ${minWidth} text-sm`}>
        <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortValue ? "none" : undefined}
                  className={`whitespace-nowrap px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300 ${c.numeric ? "text-right" : "text-left"}`}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => onSort(c)}
                      className={`group inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-white ${c.numeric ? "flex-row-reverse" : ""}`}
                    >
                      {c.label}
                      <span aria-hidden="true" className={`w-3 text-xs ${active ? "text-zinc-900 dark:text-white" : "text-zinc-300 group-hover:text-zinc-400 dark:text-zinc-600"}`}>
                        {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="align-top">
          {sorted.map((row) => (
            <tr key={rowKey(row)} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900/60">
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 ${c.numeric ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-12 text-center">
                <p className="font-medium text-zinc-700 dark:text-zinc-300">{empty.title}</p>
                {empty.detail && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{empty.detail}</p>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
