import type { ReactNode } from "react";

// Shared building blocks for the AI panels (ADR memo, Pipeline agent, renewal-risk notes). Display only.
//
// One type scale for every AI panel, nothing else:
//   title    16px semibold   panel title
//   headline 15px medium     the callout: never larger than the title
//   body     14px            values, summaries, list items
//   label    12px            field labels, meta line, card labels, chips
export const AI_TYPE = {
  title: "text-base font-semibold text-zinc-900 dark:text-zinc-50",
  headline: "text-[15px] font-medium leading-relaxed text-zinc-900 dark:text-zinc-50",
  body: "text-sm leading-relaxed text-zinc-800 dark:text-zinc-200",
  label: "text-xs text-zinc-500 dark:text-zinc-400",
} as const;

/** The panel: title, info tip, AI badge and the action button on one row; the meta line underneath. */
export function AiPanel({ title, info, badge, action, meta, children }: { title: string; info: string; badge?: ReactNode; action?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className={AI_TYPE.title}>{title}</h2>
          <InfoTip text={info} />
          {badge}
        </div>
        {action}
      </div>
      {meta}
      {children}
    </section>
  );
}

/** A small (i) with the explanation in a tooltip (hover or keyboard focus). */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={text}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 text-xs font-semibold leading-none text-zinc-500 hover:border-zinc-500 hover:text-zinc-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:border-zinc-600 dark:text-zinc-400"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-72 -translate-x-1/2 rounded-md bg-zinc-900 px-3 py-2 text-xs font-normal leading-snug text-white shadow-lg group-focus-within:block group-hover:block dark:bg-zinc-100 dark:text-zinc-900"
      >
        {text}
      </span>
    </span>
  );
}

/** ONE compact meta line in a light grey box: items joined by " · ", empty items dropped. */
export function AiMeta({ items }: { items: ReactNode[] }) {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== "");
  return (
    <div className={`mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md bg-zinc-100 px-3 py-1.5 dark:bg-zinc-800/60 ${AI_TYPE.label}`}>
      {shown.map((x, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden className="text-zinc-400">·</span>}
          {x}
        </span>
      ))}
    </div>
  );
}

/** The grounding result as a chip for the meta line: green when every number was found. */
export function GroundedChip({ checked, flagged, against }: { checked: number; flagged: number; against: string }) {
  const ok = flagged === 0;
  const found = checked - flagged;
  return (
    <span
      title={ok ? `Every number and date appears in ${against}.` : `${flagged} number(s) or date(s) couldn't be found in ${against}. They are highlighted; treat them with care.`}
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px font-medium ${
        ok ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      }`}
    >
      {ok ? "✓" : "!"} {found}/{checked} numbers grounded
    </span>
  );
}

/** The headline or summary: a tinted callout with a slim left accent. */
export function AiCallout({ children }: { children: ReactNode }) {
  return <div className={`mt-4 rounded-md border-l-2 border-violet-400 bg-violet-50 px-4 py-3 dark:border-violet-500 dark:bg-violet-950/40 ${AI_TYPE.headline}`}>{children}</div>;
}

/** One item (recommendation, proposal, flagged account): light grey card, uppercase label, status on the right. */
export function AiCard({ label, status, children, as: Tag = "li" }: { label: string; status?: ReactNode; children: ReactNode; as?: "li" | "div" }) {
  return (
    <Tag className="flex flex-col rounded-lg bg-zinc-50 p-4 ring-1 ring-zinc-200/70 dark:bg-zinc-800/50 dark:ring-zinc-700/60">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
        {status}
      </div>
      {children}
    </Tag>
  );
}

/** Label / value rows: labels in a narrow (120px) grey column, values in body text. */
export function AiFields({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[120px_1fr]">{children}</dl>;
}

export function AiField({ label, emphasis = false, children }: { label: string; emphasis?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={`pt-0.5 ${AI_TYPE.label}`}>{label}</dt>
      <dd className={`${AI_TYPE.body} ${emphasis ? "font-medium text-zinc-900 dark:text-zinc-50" : ""}`}>{children}</dd>
    </>
  );
}
