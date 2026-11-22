"use client";

// "Sync to HubSpot" on the Integrations page: runs the same sync as `npm run hubspot:sync` through
// POST /api/hubspot-sync and shows each step as it happens, then the counts or the error that stopped it.
import { useState } from "react";
import type { SyncCount, SyncResult } from "@/lib/hubspot-sync-run";

type Message = { type: "progress"; line: string } | { type: "done"; result: SyncResult } | { type: "error"; message: string };
type State = { status: "idle" } | { status: "running" } | { status: "done"; result: SyncResult } | { status: "error"; message: string };

const BUTTON =
  "inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-70 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";

function countLine(label: string, c: SyncCount) {
  return `${label}: ${c.synced.toLocaleString("en-US")} (${c.created} new, ${c.updated} updated)`;
}

export function HubSpotSyncButton({ available, unavailableNote }: { available: boolean; unavailableNote: string }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [lines, setLines] = useState<string[]>([]);

  if (!available) {
    return (
      <button type="button" disabled title={unavailableNote} className="cursor-not-allowed rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Sync to HubSpot
        <span className="ml-2 text-xs">· {unavailableNote}</span>
      </button>
    );
  }

  const run = async () => {
    if (state.status === "running") return;
    setState({ status: "running" });
    setLines([]);
    try {
      const res = await fetch("/api/hubspot-sync", { method: "POST", headers: { "x-cockpit-sync": "1" } });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return setState({ status: "error", message: body?.error ?? `The sync couldn't start (${res.status}).` });
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
          const msg = JSON.parse(part) as Message;
          if (msg.type === "progress") setLines((l) => [...l, msg.line]);
          else if (msg.type === "done") {
            finished = true;
            setState({ status: "done", result: msg.result });
          } else {
            finished = true;
            setState({ status: "error", message: msg.message });
          }
        }
      }
      if (!finished) setState({ status: "error", message: "The connection closed before the sync reported a result. Check HubSpot before running it again." });
    } catch (e) {
      setState({ status: "error", message: `Lost contact with the sync: ${e instanceof Error ? e.message : String(e)}. It may still have finished; check HubSpot.` });
    }
  };

  const running = state.status === "running";
  return (
    <div className="space-y-3">
      <button type="button" onClick={run} disabled={running} className={BUTTON}>
        {running && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
        {running ? "Syncing…" : "Sync to HubSpot"}
      </button>
      {lines.length > 0 && (
        <ol aria-live="polite" className="max-h-40 space-y-0.5 overflow-y-auto rounded-md bg-zinc-50 p-2 font-mono text-xs text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      )}
      {state.status === "done" && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          <p className="font-medium">Sync finished · no errors</p>
          <ul className="mt-1 space-y-0.5">
            <li>{countLine("Companies", state.result.companies)}</li>
            <li>{countLine("Deals", state.result.deals)}</li>
            <li>{countLine("Contacts", state.result.contacts)}</li>
          </ul>
        </div>
      )}
      {state.status === "error" && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <p className="font-medium">Sync stopped · 1 error</p>
          <p className="mt-1 break-words">{state.message}</p>
        </div>
      )}
    </div>
  );
}
