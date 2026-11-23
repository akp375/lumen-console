"use client";

import { useState, type ReactNode } from "react";
import { generateAdrMemoAction } from "@/app/pipeline/adr-insights/actions";
import { FIELD_LABELS, REC_FIELDS, memoFieldKey, type AdrMemo } from "@/lib/adr-memo-shared";
import { dateTimeUtc, modelLabel, shortDate } from "@/lib/format";
import { ErrorNote, FlagButton, LimitNotice } from "./RiskUi";
import { Spinner } from "./Spinner";

// The AI memo for the ADR manager. Display only: Claude writes the text from metrics.ts numbers,
// and the grounding check (run on the server) lists any number it couldn't find in that data.


export function AdrMemoPanel({ initial, missingMigration, adrManager }: { initial: AdrMemo | null; missingMigration: boolean; adrManager: string | null }) {
  const [memo, setMemo] = useState<AdrMemo | null>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(missingMigration ? "Saving memos needs supabase/migrations/20261126000000_adr_manager_and_memos.sql to be run in Supabase." : null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await generateAdrMemoAction();
      if (r.memo) setMemo(r.memo);
      setSaveError(r.saveError ?? null);
      if (r.notice) setNotice(r.notice);
      if (r.error) setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  const flags = memo?.grounding.ungrounded ?? [];
  const flagsFor = (field: string) => flags.filter((f) => f.field === field).map((f) => f.text);

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Memo for the ADR Manager</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {adrManager ? `For ${adrManager}. ` : ""}Claude Sonnet turns this page&apos;s numbers into 3 to 5 recommendations. Every number is checked against the data
            it was given.
          </p>
        </div>
        <FlagButton onClick={run} busy={busy} busyLabel="Claude is writing…" label={memo ? "Regenerate" : "Generate memo"} />
      </div>

      <div className="mt-3 space-y-2">
        {notice && <LimitNotice message={notice} />}
        {error && <ErrorNote message={error} />}
        {saveError && <LimitNotice message={saveError} />}
      </div>

      {busy && !memo && (
        <p className="mt-4 inline-flex items-center gap-2 text-sm text-zinc-500">
          <Spinner /> Claude is writing the memo…
        </p>
      )}

      {memo && (
        <div className={`mt-4 ${busy ? "opacity-50" : ""}`}>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Generated {dateTimeUtc(memo.createdAt)} UTC · data as of {shortDate(memo.asOfDate)} · {modelLabel(memo.model)} · ${memo.costUsd.toFixed(4)}
          </p>
          <p className="mt-3 text-lg font-medium text-zinc-900 dark:text-zinc-50">
            <Marked text={memo.content.headline} flags={flagsFor(memoFieldKey(null, "headline"))} />
          </p>
          <GroundingSummary checked={memo.grounding.checked} flagged={flags.length} />
          {memo.note && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{memo.note}</p>}
          <ol className="mt-4 space-y-4">
            {memo.content.recommendations.map((r, i) => (
              <li key={i} className="rounded-md border border-zinc-100 p-4 dark:border-zinc-800">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Recommendation {i + 1}</div>
                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
                  {REC_FIELDS.map((f) => (
                    <Row key={f} label={FIELD_LABELS[f]}>
                      <Marked text={r[f]} flags={flagsFor(memoFieldKey(i, f))} />
                    </Row>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!memo && !busy && <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No memo yet. Generating one costs about $0.03.</p>}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="text-zinc-800 dark:text-zinc-200">{children}</dd>
    </>
  );
}

function GroundingSummary({ checked, flagged }: { checked: number; flagged: number }) {
  if (flagged === 0)
    return <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">All {checked} numbers and dates in this memo appear in Cockpit&apos;s data.</p>;
  return (
    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
      {flagged} of {checked} numbers or dates couldn&apos;t be found in Cockpit&apos;s data. They are highlighted below; treat them with care.
    </p>
  );
}

/** The text, with each flagged number highlighted. */
function Marked({ text, flags }: { text: string; flags: string[] }) {
  if (flags.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (const f of flags) {
    const at = rest.indexOf(f);
    if (at < 0) continue;
    parts.push(rest.slice(0, at));
    parts.push(
      <mark key={k++} title="Not in Cockpit's data" className="rounded bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-700 dark:text-amber-50">
        {f}
      </mark>,
    );
    rest = rest.slice(at + f.length);
  }
  parts.push(rest);
  return <>{parts}</>;
}
