"use client";

import { useState, type ReactNode } from "react";
import { generateAdrMemoAction } from "@/app/pipeline/adr-insights/actions";
import { FIELD_LABELS, REC_FIELDS, memoFieldKey, type AdrMemo } from "@/lib/adr-memo-shared";
import { aiUsd, dayMonth, dayMonthTimeUtc, modelLabel } from "@/lib/format";
import { AiBadge } from "./AiBadge";
import { AI_TYPE, AiCallout, AiCard, AiField, AiFields, AiMeta, AiPanel, GroundedChip } from "./AiPanel";
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

  const info = "Claude Sonnet turns this page's numbers into 3 to 5 recommendations. Every number and date is checked against the data it was given.";
  return (
    <AiPanel
      title="Memo for the ADR Manager"
      info={info}
      badge={memo && <AiBadge model={memo.model} costUsd={memo.costUsd} />}
      action={<FlagButton onClick={run} busy={busy} busyLabel="Claude is writing…" label={memo ? "Regenerate" : "Generate memo"} />}
      meta={
        memo && (
          <AiMeta
            items={[
              adrManager && `For ${adrManager}`,
              `Generated ${dayMonthTimeUtc(memo.createdAt)}`,
              `Data as of ${dayMonth(memo.asOfDate)}`,
              modelLabel(memo.model),
              aiUsd(memo.costUsd),
              <GroundedChip key="g" checked={memo.grounding.checked} flagged={flags.length} against="Cockpit's data" />,
            ]}
          />
        )
      }
    >
      {(notice || error || saveError) && (
        <div className="mt-3 space-y-2">
          {notice && <LimitNotice message={notice} />}
          {error && <ErrorNote message={error} />}
          {saveError && <LimitNotice message={saveError} />}
        </div>
      )}

      {busy && !memo && (
        <p className={`mt-4 inline-flex items-center gap-2 ${AI_TYPE.body}`}>
          <Spinner /> Claude is writing the memo…
        </p>
      )}

      {memo && (
        <div className={busy ? "opacity-50" : ""}>
          <AiCallout>
            <Marked text={memo.content.headline} flags={flagsFor(memoFieldKey(null, "headline"))} />
          </AiCallout>
          {memo.note && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{memo.note}</p>}
          <ol className="mt-4 grid gap-3 lg:grid-cols-2">
            {memo.content.recommendations.map((r, i) => (
              <AiCard key={i} label={`Recommendation ${i + 1}`}>
                <AiFields>
                  {REC_FIELDS.map((f) => (
                    <AiField key={f} label={FIELD_LABELS[f]} emphasis={f === "finding" || f === "action"}>
                      <Marked text={r[f]} flags={flagsFor(memoFieldKey(i, f))} />
                    </AiField>
                  ))}
                </AiFields>
              </AiCard>
            ))}
          </ol>
        </div>
      )}
      {!memo && !busy && <p className={`mt-4 ${AI_TYPE.label}`}>No memo yet. Generating one costs about $0.03.</p>}
    </AiPanel>
  );
}

/** The text, with each flagged number highlighted. */
export function Marked({ text, flags }: { text: string; flags: string[] }) {
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
