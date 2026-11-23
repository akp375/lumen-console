// Approving, rejecting and reverting the Pipeline agent's proposed actions. Server-side only.
//
// - Reject records who decided and when, and changes nothing else.
// - Approve records the decision first (only if the action is still "proposed"), then executes it:
//   reassign_leads sets the leads' ADR (and their sequence enrollments' ADR); pause_sequence sets the
//   sequence to paused; create_hubspot_task writes a task on the HubSpot company or deal. What
//   changed (each lead's previous ADR, the HubSpot task id) is saved with the action, or the error.
// - Revert (npm run agent:reset) undoes approved reassignments and pauses only. HubSpot tasks stay.
//
// The database and HubSpot are passed in (ActionDb), so all of this can be tested with fakes.
import type { AgentActionView, PauseDetails, ReassignDetails, TaskDetails } from "./pipeline-agent-shared.ts";

export type ActionDb = {
  getAction(id: string): Promise<AgentActionView | null>;
  /** Sets the decision only if the action is still "proposed". Returns false if someone already decided. */
  decide(id: string, d: { status: "approved" | "rejected"; decidedBy: string; decidedAt: string }): Promise<boolean>;
  setOutcome(id: string, o: { outcome: "done" | "failed" | "reverted"; result: Record<string, unknown>; revertedAt?: string }): Promise<void>;
  teamMember(id: string): Promise<{ id: string; name: string } | null>;
  /** Each lead's current ADR (null = unassigned). Leads that don't exist are missing from the map. */
  leadOwners(ids: string[]): Promise<Map<string, string | null>>;
  setLeadOwner(ids: string[], adrId: string | null): Promise<void>;
  /** Enrollments of these leads whose adr_id is `adrId` (null = none). */
  enrollmentIds(leadIds: string[], adrId: string | null): Promise<string[]>;
  setEnrollmentAdr(ids: string[], adrId: string | null): Promise<void>;
  sequenceStatus(id: string): Promise<"active" | "paused" | null>;
  setSequenceStatus(id: string, status: "active" | "paused", pausedAt: string | null): Promise<void>;
  createHubSpotTask(t: { object: "company" | "deal"; recordId: string; title: string; body: string; dueDate: string }): Promise<{ taskId: string; hubspotRecordId: string }>;
  /** Approved actions that executed, newest first (for revert). */
  doneActions(): Promise<AgentActionView[]>;
};

export type DecisionResult = { ok: true; action: AgentActionView } | { ok: false; error: string };

const nowIso = () => new Date().toISOString();

export async function rejectAction(db: ActionDb, id: string, deciderId: string): Promise<DecisionResult> {
  const who = await db.teamMember(deciderId);
  if (!who) return { ok: false, error: "Pick who is deciding." };
  const a = await db.getAction(id);
  if (!a) return { ok: false, error: "That proposal doesn't exist." };
  if (a.status !== "proposed") return { ok: false, error: `Already ${a.status}.` };
  if (!(await db.decide(id, { status: "rejected", decidedBy: who.id, decidedAt: nowIso() }))) return { ok: false, error: "Someone decided this one already." };
  return { ok: true, action: (await db.getAction(id))! };
}

export async function approveAction(db: ActionDb, id: string, deciderId: string, decidedOn: string): Promise<DecisionResult> {
  const who = await db.teamMember(deciderId);
  if (!who) return { ok: false, error: "Pick who is deciding." };
  const a = await db.getAction(id);
  if (!a) return { ok: false, error: "That proposal doesn't exist." };
  if (a.status !== "proposed") return { ok: false, error: `Already ${a.status}.` };
  if (!(await db.decide(id, { status: "approved", decidedBy: who.id, decidedAt: nowIso() }))) return { ok: false, error: "Someone decided this one already." };

  try {
    const result = await execute(db, a, who.name, decidedOn);
    await db.setOutcome(id, { outcome: "done", result });
  } catch (e) {
    await db.setOutcome(id, { outcome: "failed", result: { error: e instanceof Error ? e.message : String(e) } });
  }
  return { ok: true, action: (await db.getAction(id))! };
}

async function execute(db: ActionDb, a: AgentActionView, deciderName: string, decidedOn: string): Promise<Record<string, unknown>> {
  if (a.type === "reassign_leads") {
    const d = a.details as ReassignDetails;
    const ids = d.leads.map((l) => l.id);
    // Nothing changes unless every lead is still where the proposal found it.
    const owners = await db.leadOwners(ids);
    const moved = ids.filter((id) => !owners.has(id) || owners.get(id) !== d.from_adr_id);
    if (moved.length) throw new Error(`Nothing changed: ${moved.length} of ${ids.length} leads aren't ${d.from_adr_id ? `owned by ${d.from_adr}` : "unassigned"} any more (${moved.slice(0, 5).join(", ")}).`);
    const enrollments = await db.enrollmentIds(ids, d.from_adr_id);
    await db.setLeadOwner(ids, d.to_adr_id);
    await db.setEnrollmentAdr(enrollments, d.to_adr_id);
    return { previous_adr_id: d.from_adr_id, new_adr_id: d.to_adr_id, lead_ids: ids, enrollment_ids: enrollments };
  }
  if (a.type === "pause_sequence") {
    const d = a.details as PauseDetails;
    const status = await db.sequenceStatus(d.sequence_id);
    if (status === null) throw new Error(`Sequence ${d.sequence_id} doesn't exist.`);
    if (status === "paused") throw new Error(`${d.sequence} is already paused.`);
    const pausedAt = nowIso();
    await db.setSequenceStatus(d.sequence_id, "paused", pausedAt);
    return { sequence_id: d.sequence_id, previous_status: status, paused_at: pausedAt };
  }
  if (a.type === "create_hubspot_task") {
    const d = a.details as TaskDetails;
    // Due dates are on the real calendar: don't create a task that is already overdue.
    const today = new Date().toISOString().slice(0, 10);
    if (d.due_date < today) throw new Error(`Nothing created: the due date (${d.due_date}) has passed. Run the agent again for a fresh proposal.`);
    // Work state only: no Cockpit numbers go to HubSpot.
    const body = `Proposed by Cockpit's Pipeline agent and approved by ${deciderName} on ${decidedOn}. The numbers behind it are on ADR Insights in Cockpit.`;
    const t = await db.createHubSpotTask({ object: d.object, recordId: d.record_id, title: d.title, body, dueDate: d.due_date });
    return { hubspot_task_id: t.taskId, hubspot_record_id: t.hubspotRecordId, object: d.object };
  }
  throw new Error(`Unknown action type "${String(a.type)}".`);
}

export type RevertLine = { id: string; type: string; status: "reverted" | "skipped" | "kept"; note: string };

/**
 * Undoes approved reassignments and pauses, newest first, and marks them reverted. HubSpot tasks
 * are kept (and stay "done"). A lead that has changed hands since is left alone and reported.
 */
export async function revertApprovedActions(db: ActionDb): Promise<RevertLine[]> {
  const out: RevertLine[] = [];
  for (const a of await db.doneActions()) {
    if (a.type === "create_hubspot_task") {
      out.push({ id: a.id, type: a.type, status: "kept", note: "HubSpot task left in place" });
      continue;
    }
    const r = (a.result ?? {}) as Record<string, unknown>;
    if (a.type === "reassign_leads") {
      const ids = (r.lead_ids as string[] | undefined) ?? [];
      const prev = (r.previous_adr_id as string | null | undefined) ?? null;
      const now = r.new_adr_id as string;
      const owners = await db.leadOwners(ids);
      const back = ids.filter((id) => owners.get(id) === now);
      const skipped = ids.filter((id) => owners.get(id) !== now);
      await db.setLeadOwner(back, prev);
      const enr = ((r.enrollment_ids as string[] | undefined) ?? []);
      const enrNow = await db.enrollmentIds(back, now);
      await db.setEnrollmentAdr(enr.filter((e) => enrNow.includes(e)), prev);
      await db.setOutcome(a.id, { outcome: "reverted", result: { ...r, reverted_leads: back, not_reverted_leads: skipped }, revertedAt: nowIso() });
      out.push({ id: a.id, type: a.type, status: "reverted", note: `${back.length} lead(s) back to ${prev ?? "unassigned"}${skipped.length ? `; ${skipped.length} left alone (changed hands since)` : ""}` });
      continue;
    }
    if (a.type === "pause_sequence") {
      const id = r.sequence_id as string;
      if ((await db.sequenceStatus(id)) === "paused") await db.setSequenceStatus(id, "active", null);
      await db.setOutcome(a.id, { outcome: "reverted", result: r, revertedAt: nowIso() });
      out.push({ id: a.id, type: a.type, status: "reverted", note: `${id} active again` });
      continue;
    }
    out.push({ id: a.id, type: a.type, status: "skipped", note: "Unknown type" });
  }
  return out;
}
