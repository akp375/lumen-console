"use client";

import type { ReactNode } from "react";

// Shared building blocks for the /renewals and /deal-risk pages. Display only.

export function FlagButton({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {busy ? "Checking…" : label}
    </button>
  );
}

export function Stat({ label, value, detail, tone = "default" }: { label: string; value: string; detail: string; tone?: "default" | "alert" }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "alert" ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-50"}`}>
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>
    </div>
  );
}

export function SignalChips({ signals }: { signals: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {signals.map((s) => (
        <span key={s} className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
          {s}
        </span>
      ))}
    </div>
  );
}

export type AiState = "idle" | "loading" | "done" | "error";

export function AiCell({ state, note }: { state: AiState; note?: { reason: string; nextAction: string } }) {
  if (state === "loading") return <span className="text-xs text-zinc-400">Claude is writing…</span>;
  if (!note) return <span className="text-xs text-zinc-400">{state === "error" ? "Not available" : ""}</span>;
  return (
    <div className="min-w-[280px] space-y-1 text-xs">
      <p className="text-zinc-700 dark:text-zinc-300">{note.reason}</p>
      <p className="text-zinc-900 dark:text-zinc-100">
        <span className="font-medium">Next: </span>
        {note.nextAction}
      </p>
    </div>
  );
}

export function TableShell({ headers, children }: { headers: { label: string; numeric?: boolean }[]; children: ReactNode }) {
  return (
    <div className="overflow-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-full min-w-[1100px] text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {headers.map((h) => (
              <th key={h.label} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium text-zinc-600 dark:text-zinc-300 ${h.numeric ? "text-right" : "text-left"}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="align-top">{children}</tbody>
      </table>
    </div>
  );
}

export const rowClass = "border-b border-zinc-100 last:border-0 dark:border-zinc-800/60";
export const cellClass = "px-3 py-2";

export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{message}</p>;
}

/** +2 / -3 / 0; n/a for null */
export function signed(n: number | null, suffix = ""): string {
  if (n === null) return "n/a";
  return `${n > 0 ? "+" : ""}${n}${suffix}`;
}
