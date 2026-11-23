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
import { dateTimeUtc, modelLabel, pct, shortDate } from "@/lib/format";
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

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">AI agent</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Claude Sonnet investigates with read-only tools (up to {PIPELINE_AGENT_LIMITS.maxToolCalls} calls), then proposes up to {PIPELINE_AGENT_LIMITS.maxProposals} fixes. Nothing changes until
            someone approves a proposal.
          </p>
          <p className="mt-2 text-sm italic text-zinc-700 dark:text-zinc-300">&ldquo;{goal}&rdquo;</p>
        </div>
        <FlagButton onClick={start} busy={busy} busyLabel="Agent is working…" label="Run agent" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-zinc-600 dark:text-zinc-400">
        <span>
          Acceptance rate:{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            {stats.rate === null ? "no decisions yet" : `${pct(stats.rate)} (${stats.approved} of ${stats.approved + stats.rejected} decided approved)`}
          </span>
          {stats.waiting > 0 && <> · {stats.waiting} waiting</>}
        </span>
        <label className="inline-flex items-center gap-2">
          Deciding as
          <select
            value={decider}
            onChange={(e) => pickDecider(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            {deciders.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.role})
              </option>
            ))}
          </select>
          <span className="text-zinc-400">not verified until Cockpit has a login</span>
        </label>
      </div>

      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}

      {(calls.length > 0 || busy) && (
        <ol aria-live="polite" className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
          {calls.map((c, i) => (
            <li key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="text-zinc-400">→</span>}
              <span
                title={c.summary}
                className={`rounded-full border px-2 py-0.5 font-mono ${
                  c.ok ? "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200" : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                }`}
              >
                {c.label}
                <span className="ml-1 font-sans text-zinc-500 dark:text-zinc-400">· {c.summary}</span>
              </span>
            </li>
          ))}
          {busy && (
            <li className="inline-flex items-center gap-1.5 text-zinc-500">
              {calls.length > 0 && <span aria-hidden className="text-zinc-400">→</span>}
              <Spinner /> thinking…
            </li>
          )}
        </ol>
      )}

      {busy && live && live.actions.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">{live.actions.length} proposal(s) recorded so far…</p>
      )}

      {run && !busy && (
        <div className="mt-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Ran {dateTimeUtc(run.createdAt)} UTC · data as of {shortDate(run.asOfDate)} · {run.model ? modelLabel(run.model) : "no model"} · {run.claudeCalls} Claude call
            {run.claudeCalls === 1 ? "" : "s"} · ${run.costUsd.toFixed(4)} · {STOP_REASON_LABELS[run.stopReason ?? ""] ?? run.stopReason ?? run.status}
          </p>
          {run.status === "running" && <LimitNotice message="This run didn't finish (the server stopped or the page lost contact). Run the agent again." />}
          {run.summary ? (
            <>
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">
                <Marked text={run.summary} flags={flagsFor(groundingKey(null))} />
              </p>
              {run.grounding && <Grounding checked={run.grounding.checked} flagged={flags.length} />}
            </>
          ) : (
            run.status !== "running" && <p className="mt-3 text-sm text-zinc-500">No summary: the run stopped before Claude wrote one.</p>
          )}

          {run.actions.length > 0 && (
            <ol className="mt-4 grid gap-3 md:grid-cols-2">
              {run.actions.map((a, i) => (
                <ActionCard key={a.id} action={a} index={i} flags={flagsFor(groundingKey(i))} decider={decider} canDecide={canDecide} unavailableNote={unavailableNote} onDecided={onDecided} />
              ))}
            </ol>
          )}
          {run.actions.length === 0 && run.status !== "running" && <p className="mt-3 text-sm text-zinc-500">The agent proposed no actions.</p>}
        </div>
      )}
      {!run && !busy && !error && <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">No runs yet. A run costs about $0.10 to $0.35.</p>}
    </section>
  );
}

function Grounding({ checked, flagged }: { checked: number; flagged: number }) {
  if (flagged === 0) return <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">All {checked} numbers and dates in the summary and reasons appear in the tool results.</p>;
  return (
    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
      {flagged} of {checked} numbers or dates couldn&apos;t be found in the tool results. They are highlighted; treat them with care.
    </p>
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
    <li className="flex flex-col rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Proposal {index + 1} · {ACTION_LABELS[a.type]}
        </span>
        <StatusBadge action={a} />
      </div>
      <div className="text-sm text-zinc-900 dark:text-zinc-100">
        <ActionDetailsView action={a} />
      </div>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        <span className="font-medium text-zinc-500">Why: </span>
        <Marked text={a.reason} flags={flags} />
      </p>
      {a.status === "proposed" ? (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
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
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {busy === "reject" && <Spinner />}Reject
          </button>
          {!canDecide && <span className="text-xs text-zinc-500">{unavailableNote}</span>}
        </div>
      ) : (
        <p className="mt-auto pt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {a.status === "approved" ? "Approved" : "Rejected"} by {a.decidedByName ?? a.decidedBy} · {a.decidedAt ? `${dateTimeUtc(a.decidedAt)} UTC` : ""}
          {a.outcome === "failed" && <span className="block text-red-700 dark:text-red-300">Didn&apos;t execute: {String(a.result?.error ?? "unknown error")}</span>}
          {a.outcome === "done" && <span className="block">{doneNote(a)}</span>}
          {a.outcome === "reverted" && <span className="block">Reverted by npm run agent:reset.</span>}
        </p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
    </li>
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
  if (a.type === "reassign_leads") return `${(a.details as ReassignDetails).leads.length} lead(s) now owned by ${(a.details as ReassignDetails).to_adr}.`;
  if (a.type === "pause_sequence") return `${(a.details as PauseDetails).sequence} is paused.`;
  return `HubSpot task created (id ${String(a.result?.hubspot_task_id ?? "?")}).`;
}

function ActionDetailsView({ action: a }: { action: AgentActionView }): ReactNode {
  if (a.type === "reassign_leads") {
    const d = a.details as ReassignDetails;
    return (
      <>
        <p>
          Move {d.leads.length} lead{d.leads.length === 1 ? "" : "s"} from <b>{d.from_adr}</b> to <b>{d.to_adr}</b>
        </p>
        <details className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
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
      <p>
        Pause <b>{d.sequence}</b> <span className="text-xs text-zinc-500">({d.sequence_id})</span>
      </p>
    );
  }
  const d = a.details as TaskDetails;
  return (
    <>
      <p>
        <b>{d.title}</b>
      </p>
      <p className="text-xs text-zinc-500">
        On the HubSpot {d.object}: {d.record} · due {shortDate(d.due_date)}
      </p>
    </>
  );
}
