"use client";

// The Pipeline agent on ADR Insights ("AI agent"). Display only: the agent runs on the server
// (POST /api/pipeline-agent) and streams each tool call; proposals are approved or rejected through a
// server action (local only). The grounding check runs on the server.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { decideAgentAction } from "@/app/pipeline/adr-insights/actions";
import {
  ACTION_LABELS,
  DEFAULT_DECIDER_ID,
  PIPELINE_AGENT_LIMITS,
  STOP_REASON_LABELS,
  groundingKey,
  type AcceptanceStats,
  type AgentActionView,
  type AgentEvent,
  type AgentRunView,
  type PauseDetails,
  type ReassignDetails,
  type TaskDetails,
  type ToolCallRecord,
} from "@/lib/pipeline-agent-shared";
import { aiUsd, dayMonth, dayMonthTimeUtc, modelLabel, pct, shortDate } from "@/lib/format";
import { firstPhrase, plain, splitSummary } from "@/lib/summary-text";
import { AiBadge } from "./AiBadge";
import { AI_TYPE, AiCallout, AiCard, AiField, AiFields, AiMeta, AiPanel, GroundedChip } from "./AiPanel";
import { Marked } from "./AdrMemoPanel";
import { ErrorNote, FlagButton, LimitNotice } from "./RiskUi";
import { Spinner } from "./Spinner";

const DECIDER_KEY = "cockpit_decider";
const DECIDER_EVENT = "cockpit-decider";
/** The browser remembers who is deciding (localStorage). On the server, and on the first render, it's the default. */
function subscribeDecider(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(DECIDER_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DECIDER_EVENT, onChange);
  };
}

type Props = {
  initial: AgentRunView | null;
  acceptance: AcceptanceStats;
  deciders: { id: string; name: string; role: string }[];
  canDecide: boolean;
  unavailableNote: string;
  missingMigration: boolean;
  goal: string;
};

export function PipelineAgentPanel({ initial, acceptance, deciders, canDecide, unavailableNote, missingMigration, goal }: Props) {
  const [run, setRun] = useState<AgentRunView | null>(initial);
  const [live, setLive] = useState<{ calls: ToolCallRecord[]; actions: AgentActionView[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(missingMigration ? "The AI agent needs supabase/migrations/20261130000000_pipeline_agent.sql to be run in Supabase." : null);
  const [stats, setStats] = useState(acceptance);
  const saved = useSyncExternalStore(subscribeDecider, () => window.localStorage.getItem(DECIDER_KEY), () => null);
  const decider = saved && deciders.some((d) => d.id === saved) ? saved : DEFAULT_DECIDER_ID;
  const pickDecider = (id: string) => {
    window.localStorage.setItem(DECIDER_KEY, id);
    window.dispatchEvent(new Event(DECIDER_EVENT));
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setLive({ calls: [], actions: [] });
    try {
      const res = await fetch("/api/pipeline-agent", { method: "POST", headers: { "x-cockpit-agent": "1" } });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `The agent couldn't start (${res.status}).`);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          const msg = JSON.parse(part) as AgentEvent;
          if (msg.type === "tool") setLive((l) => (l ? { ...l, calls: [...l.calls, msg.call] } : l));
          else if (msg.type === "proposal") {
            setLive((l) => (l ? { ...l, actions: [...l.actions, msg.action] } : l));
            setStats((s) => ({ ...s, waiting: s.waiting + 1 }));
          } else if (msg.type === "done") {
            finished = true;
            setRun(msg.run);
          } else if (msg.type === "error") {
            finished = true;
            setError(msg.message);
          }
        }
      }
      if (!finished) setError("The connection closed before the agent finished. Reload the page to see what it saved.");
    } catch (e) {
      setError(`Lost contact with the agent: ${e instanceof Error ? e.message : String(e)}. Reload the page to see what it saved.`);
    } finally {
      setLive(null);
      setBusy(false);
    }
  };

  const onDecided = (updated: AgentActionView, was: AgentActionView) => {
    setRun((r) => (r ? { ...r, actions: r.actions.map((a) => (a.id === updated.id ? updated : a)) } : r));
    if (was.status === "proposed" && updated.status !== "proposed") {
      setStats((s) => {
        const approved = s.approved + (updated.status === "approved" ? 1 : 0);
        const rejected = s.rejected + (updated.status === "rejected" ? 1 : 0);
        return { approved, rejected, waiting: Math.max(0, s.waiting - 1), rate: approved + rejected ? approved / (approved + rejected) : null };
      });
    }
  };

  const calls = live ? live.calls : (run?.toolCalls ?? []);
  const flags = run?.grounding?.ungrounded ?? [];
  const flagsFor = (field: string) => flags.filter((f) => f.field === field).map((f) => f.text);

  const info = `Claude Sonnet investigates with read-only tools (up to ${PIPELINE_AGENT_LIMITS.maxToolCalls} calls), then proposes up to ${PIPELINE_AGENT_LIMITS.maxProposals} fixes. Nothing changes until someone approves a proposal.`;
  const done = run && !busy ? run : null;
  return (
    <AiPanel
      title="AI agent"
      info={info}
      badge={done && <AiBadge model={done.model} costUsd={done.costUsd} />}
      action={<FlagButton onClick={start} busy={busy} busyLabel="Agent is working…" label="Run agent" />}
      meta={
        done && (
          <AiMeta
            items={[
              `Ran ${dayMonthTimeUtc(done.createdAt)}`,
              `Data as of ${dayMonth(done.asOfDate)}`,
              done.model ? modelLabel(done.model) : null,
              `${done.claudeCalls} Claude call${done.claudeCalls === 1 ? "" : "s"}`,
              aiUsd(done.costUsd),
              STOP_REASON_LABELS[done.stopReason ?? ""] ?? done.stopReason ?? done.status,
              done.grounding && <GroundedChip key="g" checked={done.grounding.checked} flagged={flags.length} against="the tool results" />,
            ]}
          />
        )
      }
    >
      <div className={`mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800 ${AI_TYPE.label}`}>
        <span className="min-w-0 flex-1 basis-80">
          Goal: <span className="italic text-zinc-700 dark:text-zinc-300">&ldquo;{goal}&rdquo;</span>
        </span>
        <span className="whitespace-nowrap">
          Accepted:{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {stats.rate === null ? "no decisions yet" : `${pct(stats.rate)} (${stats.approved} of ${stats.approved + stats.rejected})`}
          </span>
          {stats.waiting > 0 && <> · {stats.waiting} waiting</>}
        </span>
        <label className="inline-flex items-center gap-2 whitespace-nowrap" title="Not verified until Cockpit has a login">
          Deciding as
          <select
            value={decider}
            onChange={(e) => pickDecider(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {deciders.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.role})
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}

      {busy && (
        <div className="mt-4">
          <Steps calls={calls} busy />
          {live && live.actions.length > 0 && <p className={`mt-2 ${AI_TYPE.label}`}>{live.actions.length} proposal(s) recorded so far…</p>}
        </div>
      )}

      {done && (
        <div>
          {done.status === "running" && (
            <div className="mt-3">
              <LimitNotice message="This run didn't finish (the server stopped or the page lost contact). Run the agent again." />
            </div>
          )}
          {done.summary ? (
            <Summary text={done.summary} flags={flagsFor(groundingKey(null))} />
          ) : (
            done.status !== "running" && <p className={`mt-4 ${AI_TYPE.label}`}>No summary: the run stopped before Claude wrote one.</p>
          )}

          {calls.length > 0 && (
            <details className="group mt-4 rounded-md border border-zinc-200 dark:border-zinc-800">
              <summary className={`flex cursor-pointer list-none items-center gap-2 px-3 py-2 ${AI_TYPE.label} hover:text-zinc-700 dark:hover:text-zinc-200`}>
                <span aria-hidden className="inline-block transition-transform group-open:rotate-90">▸</span>
                Investigation steps ({calls.length})
              </summary>
              <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <Steps calls={calls} busy={false} />
              </div>
            </details>
          )}

          {done.actions.length > 0 && (
            <ol className="mt-4 grid gap-3 lg:grid-cols-2">
              {done.actions.map((a, i) => (
                <ActionCard key={a.id} action={a} index={i} flags={flagsFor(groundingKey(i))} decider={decider} canDecide={canDecide} unavailableNote={unavailableNote} onDecided={onDecided} />
              ))}
            </ol>
          )}
          {done.actions.length === 0 && done.status !== "running" && <p className={`mt-4 ${AI_TYPE.label}`}>The agent proposed no actions.</p>}
        </div>
      )}
      {!run && !busy && !error && <p className={`mt-4 ${AI_TYPE.label}`}>No runs yet. A run costs about $0.10 to $0.35.</p>}
    </AiPanel>
  );
}

/** The tool calls as a numbered list, in label size. */
function Steps({ calls, busy }: { calls: ToolCallRecord[]; busy: boolean }) {
  return (
    <ol aria-live={busy ? "polite" : undefined} className={`list-decimal space-y-0.5 pl-5 ${AI_TYPE.label}`}>
      {calls.map((c, i) => (
        <li key={i} className={c.ok ? "" : "text-amber-700 dark:text-amber-300"}>
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{c.label}</span> · {c.summary}
        </li>
      ))}
      {busy && (
        <li className="-ml-5 inline-flex list-none items-center gap-2 pt-1">
          <Spinner /> thinking…
        </li>
      )}
    </ol>
  );
}

/**
 * The run summary: its first paragraph in the callout, numbered points as a numbered list with each
 * point's first phrase in bold, and anything after as body text.
 */
function Summary({ text, flags }: { text: string; flags: string[] }) {
  const { intro, points, outro } = splitSummary(text);
  return (
    <>
      {intro && (
        <AiCallout>
          <Marked text={plain(intro)} flags={flags} />
        </AiCallout>
      )}
      {points.length > 0 && (
        <ol className={`mt-3 list-decimal space-y-2 pl-5 marker:text-zinc-400 ${AI_TYPE.body}`}>
          {points.map((p, i) => {
            const [lead, rest] = firstPhrase(p);
            return (
              <li key={i} className="pl-1">
                <b className="font-semibold text-zinc-900 dark:text-zinc-50">
                  <Marked text={lead} flags={flags} />
                </b>
                <Marked text={rest} flags={flags} />
              </li>
            );
          })}
        </ol>
      )}
      {outro.map((o, i) => (
        <p key={i} className={`mt-3 ${AI_TYPE.body}`}>
          <Marked text={plain(o)} flags={flags} />
        </p>
      ))}
    </>
  );
}

function ActionCard({
  action: a,
  index,
  flags,
  decider,
  canDecide,
  unavailableNote,
  onDecided,
}: {
  action: AgentActionView;
  index: number;
  flags: string[];
  decider: string;
  canDecide: boolean;
  unavailableNote: string;
  onDecided: (updated: AgentActionView, was: AgentActionView) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (d: "approve" | "reject") => {
    if (busy) return;
    setBusy(d);
    setError(null);
    try {
      const r = await decideAgentAction(a.id, d, decider);
      if (r.action) onDecided(r.action, a);
      if (r.error) setError(r.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AiCard label={`Proposal ${index + 1} · ${ACTION_LABELS[a.type]}`} status={<StatusBadge action={a} />}>
      <AiFields>
        <AiField label="Action" emphasis>
          <ActionDetailsView action={a} />
        </AiField>
        <AiField label="Why">
          <Marked text={a.reason} flags={flags} />
        </AiField>
        {a.status !== "proposed" && (
          <AiField label="Decision">
            {a.status === "approved" ? "Approved" : "Rejected"} by {a.decidedByName ?? a.decidedBy}
            {a.decidedAt ? ` · ${dayMonthTimeUtc(a.decidedAt)}` : ""}
            {a.outcome === "failed" && <span className="block text-red-700 dark:text-red-300">Didn&apos;t execute: {String(a.result?.error ?? "unknown error")}</span>}
            {a.outcome === "done" && <span className="block text-zinc-600 dark:text-zinc-400">{doneNote(a)}</span>}
            {a.outcome === "reverted" && <span className="block text-zinc-600 dark:text-zinc-400">Reverted by npm run agent:reset.</span>}
          </AiField>
        )}
      </AiFields>
      {a.status === "proposed" && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          <button
            type="button"
            onClick={() => decide("approve")}
            disabled={!canDecide || busy !== null}
            title={canDecide ? undefined : unavailableNote}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy === "approve" && <Spinner />}Approve
          </button>
          <button
            type="button"
            onClick={() => decide("reject")}
            disabled={!canDecide || busy !== null}
            title={canDecide ? undefined : unavailableNote}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-transparent dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {busy === "reject" && <Spinner />}Reject
          </button>
          {!canDecide && <span className={AI_TYPE.label}>{unavailableNote}</span>}
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
    </AiCard>
  );
}

function StatusBadge({ action: a }: { action: AgentActionView }) {
  const [label, cls] =
    a.status === "proposed"
      ? ["Waiting", "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"]
      : a.status === "rejected"
        ? ["Rejected", "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"]
        : a.outcome === "failed"
          ? ["Failed", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"]
          : a.outcome === "reverted"
            ? ["Reverted", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"]
            : ["Done", "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

function doneNote(a: AgentActionView): string {
  if (a.type === "reassign_leads") {
    const d = a.details as ReassignDetails;
    const hs = a.result?.hubspot as { updated?: number; not_in_hubspot?: string[]; error?: string } | undefined;
    const hubspot = !hs
      ? ""
      : hs.error
        ? ` Saved in Cockpit; HubSpot not updated: ${hs.error} The next sync will fix it.`
        : ` HubSpot: ${hs.updated} contact(s) updated${hs.not_in_hubspot?.length ? `, ${hs.not_in_hubspot.length} not in HubSpot yet (the next sync adds them)` : ""}.`;
    return `${d.leads.length} lead(s) now owned by ${d.to_adr}.${hubspot}`;
  }
  if (a.type === "pause_sequence") return `${(a.details as PauseDetails).sequence} is paused.`;
  return `HubSpot task created (id ${String(a.result?.hubspot_task_id ?? "?")}).`;
}

function ActionDetailsView({ action: a }: { action: AgentActionView }): ReactNode {
  if (a.type === "reassign_leads") {
    const d = a.details as ReassignDetails;
    return (
      <>
        <span>
          Move {d.leads.length} lead{d.leads.length === 1 ? "" : "s"} from {d.from_adr} to {d.to_adr}
        </span>
        <details className={`mt-1 font-normal ${AI_TYPE.label}`}>
          <summary className="cursor-pointer">Show leads</summary>
          <ul className="mt-1 space-y-0.5">
            {d.leads.map((l) => (
              <li key={l.id}>
                {l.contact} · {l.account} <span className="text-zinc-400">({l.id})</span>
              </li>
            ))}
          </ul>
        </details>
      </>
    );
  }
  if (a.type === "pause_sequence") {
    const d = a.details as PauseDetails;
    return (
      <span>
        Pause {d.sequence} <span className={`font-normal ${AI_TYPE.label}`}>({d.sequence_id})</span>
      </span>
    );
  }
  const d = a.details as TaskDetails;
  return (
    <>
      <span className="block">{d.title}</span>
      <span className={`block font-normal ${AI_TYPE.label}`}>
        On the HubSpot {d.object}: {d.record} · due {shortDate(d.due_date)}
      </span>
    </>
  );
}
