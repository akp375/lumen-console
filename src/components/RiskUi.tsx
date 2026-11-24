"use client";

import type { ReactNode } from "react";
import { Spinner } from "./Spinner";

// Shared building blocks for the Renewals and Deal Risk pages. Display only.

// Stays disabled, with a spinner, until the whole run (rules + Claude notes)
// finishes, so a second click can never start a second, paid Claude call.
export function FlagButton({ onClick, busy, busyLabel = "Checking…", label }: { onClick: () => void; busy: boolean; busyLabel?: string; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {busy && <Spinner />}
      {busy ? busyLabel : label}
    </button>
  );
}

export function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      ← {label}
    </button>
  );
}

const STAT_TONE = {
  default: "text-zinc-900 dark:text-zinc-50",
  alert: "text-red-600 dark:text-red-400",
  warn: "text-amber-600 dark:text-amber-400",
  good: "text-emerald-600 dark:text-emerald-400",
} as const;

export function Stat({ label, value, detail, tone = "default" }: { label: string; value: string; detail: ReactNode; tone?: keyof typeof STAT_TONE }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${STAT_TONE[tone]}`}>
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

const RISK_BADGE = {
  High: "bg-red-600 text-white dark:bg-red-500",
  Medium: "bg-amber-400 text-amber-950 dark:bg-amber-500",
  Low: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200",
} as const;

/** Renewal risk level badge: High red, Medium amber, Low grey. Same levels the HubSpot sync sends. */
export function RiskBadge({ level }: { level: keyof typeof RISK_BADGE }) {
  return <span className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${RISK_BADGE[level]}`}>{level}</span>;
}

export type AiState = "idle" | "loading" | "done" | "error";

export function AiCell({ state, note }: { state: AiState; note?: { reason: string; nextAction: string } }) {
  if (state === "loading")
    return (
      <span className="inline-flex items-center gap-2 text-xs text-zinc-400">
        <Spinner className="h-3 w-3" /> Claude is writing…
      </span>
    );
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

/** Title Case section heading with a one-line detail. */
export function SectionHeading({ title, detail, badge }: { title: string; detail: string; badge?: ReactNode }) {
  return (
    <div className="mb-2">
      <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
        {title}
        {badge}
      </h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>
    </div>
  );
}

export function RuleNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-zinc-500 dark:text-zinc-400">{children}</p>;
}

/** A guardrail was hit (e.g. daily AI budget): informational, not an error. */
export function LimitNotice({ message }: { message: string }) {
  return (
    <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      {message}
    </p>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{message}</p>;
}
