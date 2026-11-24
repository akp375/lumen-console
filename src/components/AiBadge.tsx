import { aiUsd, modelLabel } from "@/lib/format";

// The one marker for anything Claude wrote: a small "AI" pill with the model and what it cost.
// Cost is the real API spend logged in llm_calls (through the Claude wrapper).
export function AiBadge({ model, costUsd, costNote }: { model: string | null; costUsd: number; costNote?: string }) {
  return (
    <span
      title="Written by Claude. Cost is the real API spend, logged for every call."
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 align-middle text-xs font-medium text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300"
    >
      <span className="font-semibold">AI</span>
      <span aria-hidden>·</span>
      {model ? modelLabel(model) : "Claude"}
      <span aria-hidden>·</span>
      <span className="tabular-nums">{aiUsd(costUsd)}</span>
      {costNote && <span className="font-normal text-violet-600 dark:text-violet-400">{costNote}</span>}
    </span>
  );
}
