"use server";

import { generateAdrMemo } from "@/lib/adr-memo";
import type { AdrMemo } from "@/lib/adr-memo-shared";
import { ClaudeLimitError } from "@/lib/claude";
import { headers } from "next/headers";
import { approveAction, rejectAction } from "@/lib/agent-actions";
import { supabaseActionDb } from "@/lib/agent-db";
import { shortDate } from "@/lib/format";
import { isLocalDev, LOCAL_ONLY_NOTE } from "@/lib/local-only";
import type { AgentActionView } from "@/lib/pipeline-agent-shared";

/** Generates a new ADR memo (one paid Claude call) and saves it. */
export async function generateAdrMemoAction(): Promise<{ memo?: AdrMemo; saveError?: string | null; notice?: string; error?: string }> {
  try {
    return await generateAdrMemo();
  } catch (e) {
    if (e instanceof ClaudeLimitError) return { notice: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Pipeline agent decisions (local only, like the HubSpot Sync button) ---

/**
 * Approves (and executes) or rejects one proposed action. Every decision is logged with who and when.
 * The approval date written into a HubSpot task is the real date: tasks are work state on HubSpot's calendar.
 */
export async function decideAgentAction(id: string, decision: "approve" | "reject", deciderId: string): Promise<{ action?: AgentActionView; error?: string }> {
  if (!isLocalDev((await headers()).get("host"))) return { error: `${LOCAL_ONLY_NOTE}.` };
  try {
    const r = decision === "approve" ? await approveAction(supabaseActionDb, id, deciderId, shortDate(new Date().toISOString())) : await rejectAction(supabaseActionDb, id, deciderId);
    return r.ok ? { action: r.action } : { error: r.error };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
