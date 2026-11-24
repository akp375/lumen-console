// Supabase and HubSpot side of the Pipeline agent: saving runs and proposals, reading them back for
// the page, and the writes an approved action makes. Server-side only (service-role key).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hubspot } from "./hubspot.ts";
import { updateLeadOwnership } from "./hubspot-sync-run.ts";
import type { ActionDb } from "./agent-actions.ts";
import type { RunPatch, RunStore } from "./pipeline-agent.ts";
import type { AcceptanceStats, ActionType, AgentActionView, AgentRunView, ToolCallRecord } from "./pipeline-agent-shared.ts";
import type { GroundingResult } from "./grounding.ts";

let client: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what} failed: ${r.error.message}`);
  return r.data;
};

/** True when the error means the agent migration hasn't been run. */
export const isMissingAgentTables = (message: string) => /agent_runs|agent_actions|schema cache|does not exist/i.test(message);

// --- Runs ----------------------------------------------------------------------

export const supabaseRunStore: RunStore = {
  async createRun(r) {
    const row = must(
      await db().from("agent_runs").insert({ agent: "pipeline", goal: r.goal, as_of_date: r.asOfDate, model: r.model, status: "running" }).select("id").single(),
      "Saving the run",
    );
    return String((row as { id: string }).id);
  },
  async updateRun(id: string, patch: RunPatch) {
    must(await db().from("agent_runs").update(patch).eq("id", id), "Updating the run");
  },
  async addProposal(p) {
    const row = must(
      await db().from("agent_actions").insert({ run_id: p.runId, type: p.type, details: p.details, reason: p.reason }).select("*").single(),
      "Saving the proposal",
    );
    return toAction(row as Record<string, unknown>, new Map());
  },
};

function toAction(r: Record<string, unknown>, names: Map<string, string>): AgentActionView {
  const by = r.decided_by ? String(r.decided_by) : null;
  return {
    id: String(r.id),
    runId: String(r.run_id),
    type: r.type as ActionType,
    details: r.details as AgentActionView["details"],
    reason: String(r.reason),
    status: r.status as AgentActionView["status"],
    decidedBy: by,
    decidedByName: by ? (names.get(by) ?? by) : null,
    decidedAt: r.decided_at ? String(r.decided_at) : null,
    outcome: (r.outcome ?? null) as AgentActionView["outcome"],
    result: (r.result ?? null) as Record<string, unknown> | null,
  };
}

async function teamNames(): Promise<Map<string, string>> {
  const rows = must(await db().from("team").select("id, name"), "Reading the team") as { id: string; name: string }[];
  return new Map(rows.map((t) => [t.id, t.name]));
}

/** The people who can decide (everyone on the team), ADR manager first. */
export async function getDeciders(): Promise<{ id: string; name: string; role: string }[]> {
  const rows = must(await db().from("team").select("id, name, role").order("id"), "Reading the team") as { id: string; name: string; role: string }[];
  return rows.sort((a, b) => Number(b.role === "ADR manager") - Number(a.role === "ADR manager") || a.name.localeCompare(b.name));
}

/** The newest run with its proposals, or null. missingMigration when the agent tables don't exist yet. */
export async function getLatestAgentRun(): Promise<{ run: AgentRunView | null; missingMigration: boolean }> {
  const r = await db().from("agent_runs").select("*").eq("agent", "pipeline").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (r.error) {
    if (isMissingAgentTables(r.error.message)) return { run: null, missingMigration: true };
    throw new Error(`Reading agent runs failed: ${r.error.message}`);
  }
  if (!r.data) return { run: null, missingMigration: false };
  return { run: await runView(r.data as Record<string, unknown>), missingMigration: false };
}

async function runView(row: Record<string, unknown>): Promise<AgentRunView> {
  const [acts, names] = await Promise.all([db().from("agent_actions").select("*").eq("run_id", String(row.id)).order("created_at"), teamNames()]);
  const actions = (must(acts, "Reading proposals") as Record<string, unknown>[]).map((a) => toAction(a, names));
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    asOfDate: String(row.as_of_date),
    goal: String(row.goal),
    status: row.status as AgentRunView["status"],
    stopReason: (row.stop_reason ?? null) as string | null,
    model: (row.model ?? null) as string | null,
    toolCalls: (row.tool_calls ?? []) as ToolCallRecord[],
    summary: (row.summary ?? null) as string | null,
    grounding: (row.grounding ?? null) as GroundingResult | null,
    claudeCalls: Number(row.claude_calls ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
    actions,
  };
}

/** Approved / (approved + rejected) across every run; reverted actions still count as approved decisions. */
export async function getAcceptance(): Promise<AcceptanceStats> {
  const rows = must(await db().from("agent_actions").select("status"), "Reading decisions") as { status: string }[];
  const approved = rows.filter((r) => r.status === "approved").length;
  const rejected = rows.filter((r) => r.status === "rejected").length;
  const waiting = rows.filter((r) => r.status === "proposed").length;
  return { approved, rejected, waiting, rate: approved + rejected ? approved / (approved + rejected) : null };
}

// --- Writes an approved action makes ---------------------------------------------

const CHUNK = 200;
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/** HubSpot's default association from a task: 192 = task to company, 216 = task to deal. */
const TASK_ASSOCIATION = { company: 192, deal: 216 } as const;
const LUMEN_ID = { company: { object: "companies", property: "lumen_account_id" }, deal: { object: "deals", property: "lumen_opportunity_id" } } as const;

/** Finds the HubSpot record synced from a Cockpit account or deal (matched on its Lumen id, as the sync does). */
export async function findHubSpotRecord(object: "company" | "deal", lumenId: string): Promise<string> {
  const { object: o, property } = LUMEN_ID[object];
  const r = await hubspot<{ results: { id: string }[] }>("POST", `/crm/v3/objects/${o}/search`, {
    filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value: lumenId }] }],
    properties: [property],
    limit: 1,
  });
  if (!r.results.length) throw new Error(`No HubSpot ${object} has ${property} = ${lumenId}. Run the HubSpot sync first.`);
  return r.results[0].id;
}

/** Creates a HubSpot task on one company, or on one deal and that deal's company. Returns the task id. */
export async function createHubSpotTask(t: { object: "company" | "deal"; recordId: string; accountId: string; title: string; body: string; dueDate: string }): Promise<{ taskId: string; hubspotRecordId: string; hubspotCompanyId: string }> {
  const hubspotRecordId = await findHubSpotRecord(t.object, t.recordId);
  const hubspotCompanyId = t.object === "company" ? hubspotRecordId : await findHubSpotRecord("company", t.accountId);
  const link = (id: string, object: "company" | "deal") => ({ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: TASK_ASSOCIATION[object] }] });
  const task = await hubspot<{ id: string }>("POST", "/crm/v3/objects/tasks", {
    properties: {
      hs_timestamp: `${t.dueDate}T12:00:00.000Z`, // the due date
      hs_task_subject: t.title,
      hs_task_body: t.body,
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "MEDIUM",
      hs_task_type: "TODO",
    },
    associations: t.object === "deal" ? [link(hubspotRecordId, "deal"), link(hubspotCompanyId, "company")] : [link(hubspotRecordId, "company")],
  });
  return { taskId: task.id, hubspotRecordId, hubspotCompanyId };
}

export const supabaseActionDb: ActionDb = {
  async getAction(id) {
    const r = await db().from("agent_actions").select("*").eq("id", id).maybeSingle();
    const row = must(r, "Reading the proposal") as Record<string, unknown> | null;
    return row ? toAction(row, await teamNames()) : null;
  },
  async decide(id, d) {
    const r = await db()
      .from("agent_actions")
      .update({ status: d.status, decided_by: d.decidedBy, decided_at: d.decidedAt })
      .eq("id", id)
      .eq("status", "proposed")
      .select("id");
    return (must(r, "Saving the decision") as unknown[]).length === 1;
  },
  async setOutcome(id, o) {
    must(await db().from("agent_actions").update({ outcome: o.outcome, result: o.result, ...(o.revertedAt ? { reverted_at: o.revertedAt } : {}) }).eq("id", id), "Saving the outcome");
  },
  async teamMember(id) {
    const r = await db().from("team").select("id, name").eq("id", id).maybeSingle();
    return (must(r, "Reading the team") as { id: string; name: string } | null) ?? null;
  },
  async leadOwners(ids) {
    const out = new Map<string, string | null>();
    for (const part of chunks(ids)) {
      const rows = must(await db().from("leads").select("id, assigned_adr_id").in("id", part), "Reading leads") as { id: string; assigned_adr_id: string | null }[];
      for (const l of rows) out.set(l.id, l.assigned_adr_id);
    }
    return out;
  },
  async setLeadOwner(ids, adrId) {
    for (const part of chunks(ids)) must(await db().from("leads").update({ assigned_adr_id: adrId }).in("id", part), "Updating leads");
  },
  async enrollmentIds(leadIds, adrId) {
    const out: string[] = [];
    for (const part of chunks(leadIds)) {
      let q = db().from("sequence_enrollments").select("id").in("lead_id", part);
      q = adrId === null ? q.is("adr_id", null) : q.eq("adr_id", adrId);
      out.push(...(must(await q, "Reading enrollments") as { id: string }[]).map((e) => e.id));
    }
    return out;
  },
  async setEnrollmentAdr(ids, adrId) {
    for (const part of chunks(ids)) must(await db().from("sequence_enrollments").update({ adr_id: adrId }).in("id", part), "Updating enrollments");
  },
  async sequenceStatus(id) {
    const r = await db().from("sequences").select("status").eq("id", id).maybeSingle();
    const row = must(r, "Reading the sequence") as { status: string } | null;
    return row ? (row.status === "paused" ? "paused" : "active") : null;
  },
  async setSequenceStatus(id, status, pausedAt) {
    must(await db().from("sequences").update({ status, paused_at: pausedAt }).eq("id", id), "Updating the sequence");
  },
  createHubSpotTask,
  updateLeadContacts: updateLeadOwnership,
  async doneActions() {
    const r = await db().from("agent_actions").select("*").eq("status", "approved").eq("outcome", "done").order("decided_at", { ascending: false });
    const names = await teamNames();
    return (must(r, "Reading approved actions") as Record<string, unknown>[]).map((a) => toAction(a, names));
  },
};
