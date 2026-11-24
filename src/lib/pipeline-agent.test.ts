// Tests for the Pipeline agent loop (pipeline-agent.ts) and its approve / reject / revert rules
// (agent-actions.ts). Claude, the database and HubSpot are all faked: nothing leaves this process.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipelineAgent, checkProposal, type ModelReply, type ModelRequest, type RunStore, type RunPatch } from "./pipeline-agent.ts";
import { approveAction, rejectAction, revertApprovedActions, type ActionDb } from "./agent-actions.ts";
import { PIPELINE_AGENT_LIMITS, type AgentActionView, type ActionType, type ActionDetails } from "./pipeline-agent-shared.ts";
import { calcAdrHygiene, calcAdrInsights, calcAdrMemoInput, calcAgentAdrCapacity, calcAgentHygieneSummary, calcAgentOverdueMqls, type AdrInputs, type AdrLeadRow } from "./metrics.ts";

const AS_OF = "2026-11-13"; // the data's date: every analysis number
const TODAY = "2026-11-23"; // the real calendar date: HubSpot task due dates only

// --- A tiny dataset ---------------------------------------------------------
// Ada (d1) covers Alpha (A1, owner Ann); Dan (d2) covers Bravo (A2, owner Bob).
//   L1, L2: Ada's MQLs, never touched, past the 24-hour SLA -> overdue
//   L3: unassigned New lead at Alpha -> in Ada's territory
//   S2: bounces on 4 of 20 emails (20%) -> bounce alert
//   O1: Dan's Qualifying deal, no update for 14 days -> stale

const lead = (id: string, over: Partial<AdrLeadRow>): AdrLeadRow => ({
  id, account_id: "A1", contact_name: `Contact ${id}`, contact_title: "Head of Ops", lead_source: "inbound demo request", lead_stage: "new",
  created_at: "2026-11-01T00:00:00Z", engaged_at: null, mql_at: null, first_touch_at: null, sales_accepted_at: null, sales_qualified_at: null,
  meeting_booked_at: null, converted_at: null, disqualified_at: null, nurtured_at: null, disqualify_reason: null, assigned_adr_id: null, opportunity_id: null, ...over,
});

const makeInputs = (): AdrInputs => ({
  leads: [
    lead("L1", { lead_stage: "mql", engaged_at: "2026-11-01T00:00:00Z", mql_at: "2026-11-10T00:00:00Z", assigned_adr_id: "d1" }),
    lead("L2", { lead_stage: "mql", engaged_at: "2026-11-01T00:00:00Z", mql_at: "2026-11-11T00:00:00Z", assigned_adr_id: "d1" }),
    lead("L3", {}),
  ],
  enrollments: Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`, sequence_id: "S2", lead_id: `X${i}`, adr_id: "d1", enrolled_at: "2026-10-01T00:00:00Z", emails_sent: 1, opens: 0, clicks: 0, replies: 0, bounces: i < 4 ? 1 : 0, meeting_booked: false, meeting_booked_at: null,
  })),
  sequences: [
    { id: "S1", name: "Sequence S1", owner_id: "d1", status: "active" },
    { id: "S2", name: "Bought list", owner_id: "d1", status: "active" },
  ],
  deals: [{ id: "O1", account_id: "A2", type: "new", amount_usd: 24000, stage: "Stage 0.1", created_date: "2026-10-20", last_activity_date: "2026-10-30", ae_id: "a2", adr_id: "d2" }],
  accounts: [
    { id: "A1", name: "Alpha", status: "prospect", owner: "Ann", icp_tier: 1, target_account: true, territory: "T1" },
    { id: "A2", name: "Bravo", status: "prospect", owner: "Bob", icp_tier: 2, target_account: false, territory: "T2" },
  ],
  team: [
    { id: "a1", name: "Ann", role: "AE", territory: "T1" },
    { id: "a2", name: "Bob", role: "AE", territory: "T2" },
    { id: "d1", name: "Ada Lane", role: "ADR", territory: "T1" },
    { id: "d2", name: "Dan Moss", role: "ADR", territory: "T2" },
    { id: "m1", name: "Mia Cole", role: "ADR manager", territory: null },
  ],
  pairings: [
    { adr_id: "d1", ae_id: "a1", effective_from: "2026-10-01" },
    { adr_id: "d2", ae_id: "a2", effective_from: "2026-10-01" },
  ],
});

// --- Fakes ----------------------------------------------------------------------

let uid = 0;
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id: `tu_${++uid}`, name, input });
const text = (t: string) => ({ type: "text", text: t, citations: null });
const reply = (blocks: object[], costUsd = 0.001): ModelReply => ({
  content: blocks as unknown as ModelReply["content"],
  stopReason: blocks.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
  costUsd,
  model: "claude-sonnet-5-5",
});

/** A fake Claude: answers each turn with script(turn, request). Records every request. */
function fakeClaude(script: (turn: number, req: ModelRequest) => ModelReply) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    callModel: async (req: ModelRequest) => {
      requests.push(structuredClone(req));
      return script(requests.length - 1, req);
    },
  };
}

/** An in-memory run store. Proposals are only ever stored as "proposed". */
function fakeStore() {
  const runs = new Map<string, RunPatch>();
  const proposals: AgentActionView[] = [];
  const store: RunStore = {
    createRun: async () => {
      runs.set("run1", { status: "running" });
      return "run1";
    },
    updateRun: async (id, patch) => void runs.set(id, { ...runs.get(id), ...patch }),
    addProposal: async (p) => {
      const a: AgentActionView = { id: `act${proposals.length + 1}`, runId: p.runId, type: p.type, details: p.details, reason: p.reason, status: "proposed", decidedBy: null, decidedByName: null, decidedAt: null, outcome: null, result: null };
      proposals.push(a);
      return a;
    },
  };
  return { store, runs, proposals };
}

const run = (claude: ReturnType<typeof fakeClaude>, store: RunStore, inputs = makeInputs()) =>
  runPipelineAgent({ callModel: claude.callModel, store, inputs, asOf: AS_OF, today: TODAY, model: "claude-sonnet-5-5", goal: "Find leaks." });

const READS = ["get_hygiene_summary", "get_speed_to_lead", "get_adr_capacity", "get_sequence_stats"];

// --- The loop -------------------------------------------------------------------

test("Pipeline agent: stops at 8 investigation calls, then gets one last turn with no tools", async () => {
  // Claude asks for a read tool on every turn until it is told it can't.
  const claude = fakeClaude((turn, req) => (req.toolChoice.type === "none" ? reply([text("Summary.")]) : reply([toolUse(READS[turn % READS.length])])));
  const { store, runs } = fakeStore();
  const r = await run(claude, store);

  assert.equal(r.toolCalls.filter((c) => c.ok).length, PIPELINE_AGENT_LIMITS.maxToolCalls);
  assert.equal(PIPELINE_AGENT_LIMITS.maxToolCalls, 8);
  // 8 reads, 2 refused asks, then the forced last turn.
  assert.equal(r.toolCalls.filter((c) => !c.ok).length, 2);
  assert.equal(claude.requests.length, 11);
  assert.equal(claude.requests.at(-1)!.toolChoice.type, "none");
  assert.equal(r.summary, "Summary.");
  assert.equal(r.stopReason, "tool_limit");
  assert.equal(runs.get("run1")!.status, "finished");
});

test("Pipeline agent: a burst of tool calls past the limit runs only the ones that fit", async () => {
  const claude = fakeClaude((turn) => (turn === 0 ? reply(Array.from({ length: 10 }, () => toolUse("get_hygiene_summary"))) : reply([text("Done.")])));
  const { store } = fakeStore();
  const r = await run(claude, store);
  assert.equal(r.toolCalls.filter((c) => c.ok).length, 8);
  assert.equal(r.toolCalls.filter((c) => c.summary.startsWith("Not run")).length, 2);
});

test("Pipeline agent: proposals don't count toward the 8 calls, and at most 3 are recorded", async () => {
  const task = (title: string) => toolUse("propose_action", { type: "create_hubspot_task", details: { object: "company", record_id: "A1", title, due_date: "2026-11-25" }, reason: "Leak." });
  const claude = fakeClaude((turn) =>
    turn < 8 ? reply([toolUse(READS[turn % READS.length])]) : turn === 8 ? reply([task("One"), task("Two"), task("Three"), task("Four")]) : reply([text("Summary.")]),
  );
  const { store, proposals } = fakeStore();
  const r = await run(claude, store);
  assert.equal(r.toolCalls.filter((c) => c.ok && c.name !== "propose_action").length, 8);
  assert.equal(proposals.length, 3);
  assert.equal(r.actions.length, 3);
  assert.ok(r.toolCalls.some((c) => c.summary === "Proposal limit reached"));
});

test("Pipeline agent: proposals are recorded as waiting and execute nothing", async () => {
  const inputs = makeInputs();
  const before = JSON.stringify(inputs);
  const claude = fakeClaude((turn) =>
    turn === 0
      ? reply([toolUse("list_overdue_mqls", { adr: "Ada" }), toolUse("get_sequence_stats")])
      : turn === 1
        ? reply([
            toolUse("propose_action", { type: "reassign_leads", details: { from_adr: "Ada", to_adr: "Dan", lead_ids: ["L1", "L2"] }, reason: "2 overdue MQLs." }),
            toolUse("propose_action", { type: "pause_sequence", details: { sequence_id: "S2" }, reason: "Bounces 20%." }),
          ])
        : reply([text("Ada has 2 overdue MQLs; Bought list bounces 20%.")]),
  );
  const { store, proposals } = fakeStore();
  const r = await run(claude, store, inputs);
  assert.equal(proposals.length, 2);
  assert.ok(proposals.every((p) => p.status === "proposed" && p.outcome === null && p.decidedBy === null));
  // The loop has no way to write anything but the run and its proposals: the data is untouched.
  assert.equal(JSON.stringify(inputs), before);
  assert.deepEqual(r.toolCalls.map((c) => c.label), ["list_overdue_mqls(Ada Lane)", "get_sequence_stats", "propose_action(reassign_leads)", "propose_action(pause_sequence)"]);
  assert.equal(r.grounding!.ungrounded.length, 0);
});

test("Pipeline agent: stops at the cost limit before a turn that could pass it", async () => {
  const claude = fakeClaude(() => reply([toolUse("get_hygiene_summary")], 0.24));
  const { store } = fakeStore();
  const r = await run(claude, store);
  assert.equal(claude.requests.length, 2); // 0.48 spent; the next turn could pass $0.50
  assert.equal(r.stopReason, "cost_limit");
  assert.equal(r.status, "stopped");
  assert.ok(r.costUsd <= PIPELINE_AGENT_LIMITS.maxRunCostUsd);
});

test("Pipeline agent: near the cost limit, Claude gets one last turn to write the summary", async () => {
  const claude = fakeClaude((turn, req) => (req.toolChoice.type === "none" ? reply([text("Short summary.")], 0.01) : reply([toolUse("get_hygiene_summary")], 0.46)));
  const { store } = fakeStore();
  const r = await run(claude, store);
  assert.equal(claude.requests.length, 2);
  assert.equal(claude.requests[1].toolChoice.type, "none");
  assert.equal(r.summary, "Short summary.");
  assert.equal(r.stopReason, "cost_limit");
});

test("Pipeline agent: the daily budget stops the run and keeps what it found", async () => {
  const claude = fakeClaude((turn) => {
    if (turn === 0) return reply([toolUse("get_hygiene_summary")]);
    throw Object.assign(new Error("Today's AI budget has been used."), { name: "ClaudeLimitError", kind: "daily_budget" });
  });
  const { store } = fakeStore();
  const r = await run(claude, store);
  assert.equal(r.status, "stopped");
  assert.equal(r.stopReason, "daily_budget");
  assert.equal(r.toolCalls.length, 1);
});

test("Pipeline agent: numbers in the summary that no tool returned are flagged", async () => {
  const claude = fakeClaude((turn) => (turn === 0 ? reply([toolUse("list_overdue_mqls", { adr: "Ada" })]) : reply([text("Ada has 2 overdue MQLs, and 37 more next week.")])));
  const { store } = fakeStore();
  const r = await run(claude, store);
  assert.deepEqual(r.grounding!.ungrounded.map((u) => u.text), ["37"]);
});

// --- Checking proposals ------------------------------------------------------------

test("Proposals: made-up ids, a non-ADR target, a past due date and a Qualifying deal are turned away", () => {
  const ctx = { inputs: makeInputs(), asOf: AS_OF, today: TODAY, seenLeads: new Set(["L1"]), seenSequences: new Set(["S2"]) };
  const err = (p: Record<string, unknown>) => {
    const r = checkProposal({ reason: "Why.", ...p }, ctx);
    return "error" in r ? r.error : "recorded";
  };
  assert.match(err({ type: "reassign_leads", details: { from_adr: "Ada", to_adr: "Dan", lead_ids: ["L2"] } }), /didn't come from a list tool/);
  assert.match(err({ type: "reassign_leads", details: { from_adr: "Ada", to_adr: "Dan", lead_ids: ["L99"] } }), /no lead/);
  assert.match(err({ type: "reassign_leads", details: { from_adr: "Ada", to_adr: "Ann", lead_ids: ["L1"] } }), /Unknown to_adr/);
  assert.match(err({ type: "reassign_leads", details: { from_adr: "Dan", to_adr: "Ada", lead_ids: ["L1"] } }), /isn't owned by Dan Moss/);
  assert.match(err({ type: "create_hubspot_task", details: { object: "deal", record_id: "O1", title: "Qualify", due_date: "2026-11-25" } }), /Qualifying deals aren't in HubSpot/);
  assert.match(err({ type: "pause_sequence", details: { sequence_id: "S1" } }), /get_sequence_stats first/);
  assert.equal(err({ type: "reassign_leads", details: { from_adr: "ada", to_adr: "d2", lead_ids: ["L1"] } }), "recorded");
});

test("Proposals: task due dates use the real calendar (today + 7 days), not the data's as-of date", () => {
  const ctx = { inputs: makeInputs(), asOf: AS_OF, today: TODAY, seenLeads: new Set<string>(), seenSequences: new Set<string>() };
  const due = (d: string) => {
    const r = checkProposal({ type: "create_hubspot_task", details: { object: "company", record_id: "A1", title: "Call Alpha", due_date: d }, reason: "Why." }, ctx);
    return "error" in r ? r.error : "recorded";
  };
  assert.equal(PIPELINE_AGENT_LIMITS.taskDueWithinDays, 7);
  assert.match(due("2026-11-18"), /between 2026-11-23 and 2026-11-30/); // within 7 days of the as-of date, but in the real past
  assert.match(due("2026-11-22"), /between/); // yesterday
  assert.equal(due("2026-11-23"), "recorded"); // today
  assert.equal(due("2026-11-30"), "recorded"); // today + 7
  assert.match(due("2026-12-01"), /between/); // today + 8
});

test("Pipeline agent: the system prompt gives the real date for due dates and the as-of date for the data", () => {
  const claude = fakeClaude(() => reply([text("Done.")]));
  const { store } = fakeStore();
  return run(claude, store).then(() => {
    const system = claude.requests[0].system;
    assert.match(system, /Today is 13 Nov 2026/);
    assert.match(system, /today is 2026-11-23, so due_date is between 2026-11-23 and 2026-11-30/);
  });
});

// --- One definition for "MQLs past the SLA" ---------------------------------------

test("MQLs past the SLA: the memo, the agent's list, its capacity and its hygiene summary agree for every ADR", () => {
  // Add an unassigned overdue MQL in Ada's territory: it must never count as Ada's.
  const inputs = makeInputs();
  inputs.leads.push(lead("L4", { lead_stage: "mql", engaged_at: "2026-11-01T00:00:00Z", mql_at: "2026-11-09T00:00:00Z" }));
  const h = calcAdrHygiene(inputs, AS_OF);
  const memo = calcAdrMemoInput(h, calcAdrInsights(inputs, AS_OF), inputs.team, (d) => d);
  const memoCard = memo.hygiene.checks.find((c) => c.check === "MQLs past the 24-hour SLA")!;
  const agentCard = calcAgentHygieneSummary(inputs, AS_OF).checks.find((c) => c.check === "MQLs past the 24-hour SLA")!;
  const capacity = calcAgentAdrCapacity(inputs, AS_OF).adrs;
  for (const [id, name, own] of [["d1", "Ada Lane", 2], ["d2", "Dan Moss", 0]] as const) {
    assert.equal((memoCard.owned_by_adr as Record<string, number>)[name], own, `memo, ${name}`);
    assert.equal(calcAgentOverdueMqls(inputs, AS_OF, id).total, own, `list_overdue_mqls, ${name}`);
    assert.equal(capacity.find((a) => a.adr === name)!.overdue_mqls, own, `get_adr_capacity, ${name}`);
    assert.equal(agentCard.by_adr.find((a) => a.adr === name)!.owned_by_adr, own, `get_hygiene_summary, ${name}`);
  }
  // The unassigned one is in Ada's territory, in both.
  assert.equal((memoCard.no_adr_by_territory as Record<string, number>)["in Ada Lane's territory"], 1);
  assert.equal(agentCard.by_adr.find((a) => a.adr === "Ada Lane")!.no_adr_in_their_territory, 1);
});

// --- Approve, reject, revert --------------------------------------------------------

/** An in-memory ActionDb that counts every write. */
function fakeActionDb(actions: AgentActionView[], inputs = makeInputs(), opts: { hubspotDown?: boolean } = {}) {
  const writes: string[] = [];
  /** Lead ids sent to HubSpot's contact update, per call. */
  const hubspotLeadUpdates: string[][] = [];
  const leads = new Map(inputs.leads.map((l) => [l.id, l.assigned_adr_id]));
  const enrollments = new Map([["en1", { lead: "L1", adr: "d1" as string | null }], ["en2", { lead: "L2", adr: "d1" as string | null }]]);
  const sequences = new Map(inputs.sequences.map((s) => [s.id, s.status ?? "active"]));
  const byId = new Map(actions.map((a) => [a.id, { ...a }]));
  const db: ActionDb = {
    getAction: async (id) => (byId.has(id) ? { ...byId.get(id)! } : null),
    decide: async (id, d) => {
      const a = byId.get(id)!;
      if (a.status !== "proposed") return false;
      Object.assign(a, { status: d.status, decidedBy: d.decidedBy, decidedAt: d.decidedAt });
      return true;
    },
    setOutcome: async (id, o) => void Object.assign(byId.get(id)!, { outcome: o.outcome, result: o.result }),
    teamMember: async (id) => (id === "m1" ? { id, name: "Mia Cole" } : null),
    leadOwners: async (ids) => new Map(ids.filter((i) => leads.has(i)).map((i) => [i, leads.get(i)!])),
    setLeadOwner: async (ids, adr) => {
      if (ids.length) writes.push(`leads:${ids.join(",")}->${adr}`);
      ids.forEach((i) => leads.set(i, adr));
    },
    enrollmentIds: async (ids, adr) => [...enrollments].filter(([, e]) => ids.includes(e.lead) && e.adr === adr).map(([k]) => k),
    setEnrollmentAdr: async (ids, adr) => {
      if (ids.length) writes.push(`enrollments:${ids.join(",")}->${adr}`);
      ids.forEach((i) => (enrollments.get(i)!.adr = adr));
    },
    sequenceStatus: async (id) => (sequences.get(id) as "active" | "paused") ?? null,
    setSequenceStatus: async (id, s) => {
      writes.push(`sequence:${id}->${s}`);
      sequences.set(id, s);
    },
    createHubSpotTask: async (t) => {
      writes.push(`hubspot:${t.recordId}`);
      return { taskId: "hs_task_1", hubspotRecordId: "hs_co_1" };
    },
    updateLeadContacts: async (ids) => {
      if (opts.hubspotDown) throw new Error("Couldn't reach HubSpot");
      hubspotLeadUpdates.push([...ids]);
      return { updated: ids.length, notInHubSpot: [] };
    },
    doneActions: async () => [...byId.values()].filter((a) => a.status === "approved" && a.outcome === "done").reverse(),
  };
  return { db, writes, leads, enrollments, sequences, byId, hubspotLeadUpdates };
}

/** The real date plus some days: approval checks due dates against the real calendar. */
const realDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const proposal = (id: string, type: ActionType, details: ActionDetails): AgentActionView => ({ id, runId: "run1", type, details, reason: "Why.", status: "proposed", decidedBy: null, decidedByName: null, decidedAt: null, outcome: null, result: null });
const REASSIGN = proposal("act1", "reassign_leads", { from_adr_id: "d1", from_adr: "Ada Lane", to_adr_id: "d2", to_adr: "Dan Moss", leads: [{ id: "L1", contact: "Contact L1", account: "Alpha" }, { id: "L2", contact: "Contact L2", account: "Alpha" }] });
const PAUSE = proposal("act2", "pause_sequence", { sequence_id: "S2", sequence: "Bought list" });
const TASK = proposal("act3", "create_hubspot_task", { object: "company", record_id: "A2", record: "Bravo", account_id: "A2", title: "Qualify or close the Qualifying deal at Bravo", due_date: realDate(3) });

test("Reject: records who and when, and changes nothing else", async () => {
  const f = fakeActionDb([REASSIGN, PAUSE, TASK]);
  for (const id of ["act1", "act2", "act3"]) {
    const r = await rejectAction(f.db, id, "m1");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.action.status, "rejected");
      assert.equal(r.action.decidedBy, "m1");
      assert.ok(r.action.decidedAt);
      assert.equal(r.action.outcome, null);
    }
  }
  assert.deepEqual(f.writes, []);
  // A rejected action can't be approved afterwards.
  const again = await approveAction(f.db, "act1", "m1", "13 Nov 2026");
  assert.equal(again.ok, false);
  assert.deepEqual(f.writes, []);
});

test("Approve and decide: nobody can decide without picking who they are", async () => {
  const f = fakeActionDb([REASSIGN]);
  const r = await approveAction(f.db, "act1", "nobody", "13 Nov 2026");
  assert.equal(r.ok, false);
  assert.equal(f.byId.get("act1")!.status, "proposed");
  assert.deepEqual(f.writes, []);
});

test("Approve: reassigns the leads and their enrollments, pauses, creates the task; revert undoes all but the task", async () => {
  const f = fakeActionDb([REASSIGN, PAUSE, TASK]);
  for (const id of ["act1", "act2", "act3"]) assert.ok((await approveAction(f.db, id, "m1", "13 Nov 2026")).ok);
  assert.equal(f.leads.get("L1"), "d2");
  assert.equal(f.enrollments.get("en1")!.adr, "d2");
  assert.equal(f.sequences.get("S2"), "paused");
  assert.equal(f.byId.get("act3")!.result!.hubspot_task_id, "hs_task_1");
  assert.ok([...f.byId.values()].every((a) => a.outcome === "done" && a.decidedBy === "m1"));

  const lines = await revertApprovedActions(f.db);
  assert.equal(f.leads.get("L1"), "d1");
  assert.equal(f.leads.get("L2"), "d1");
  assert.equal(f.enrollments.get("en1")!.adr, "d1");
  assert.equal(f.sequences.get("S2"), "active");
  assert.equal(f.byId.get("act1")!.outcome, "reverted");
  assert.equal(f.byId.get("act2")!.outcome, "reverted");
  assert.equal(f.byId.get("act3")!.outcome, "done"); // the HubSpot task stays
  assert.deepEqual(lines.map((l) => l.status).sort(), ["kept", "reverted", "reverted"]);
  assert.equal(f.writes.filter((w) => w.startsWith("hubspot")).length, 1); // only the approval wrote to HubSpot
});

test("Approve: a task whose due date has passed (real calendar) creates nothing", async () => {
  const late = proposal("act9", "create_hubspot_task", { ...(TASK.details as object), due_date: realDate(-1) } as ActionDetails);
  const f = fakeActionDb([late]);
  const r = await approveAction(f.db, "act9", "m1", "23 Nov 2026");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.action.outcome, "failed");
    assert.match(String(r.action.result!.error), /due date .* has passed/);
  }
  assert.deepEqual(f.writes, []);
});

test("Approve: a reassignment updates the leads' HubSpot contacts and records the result; revert sends them back", async () => {
  const f = fakeActionDb([REASSIGN]);
  assert.ok((await approveAction(f.db, "act1", "m1", "23 Nov 2026")).ok);
  assert.deepEqual(f.hubspotLeadUpdates, [["L1", "L2"]]);
  assert.deepEqual(f.byId.get("act1")!.result!.hubspot, { updated: 2, not_in_hubspot: [] });
  await revertApprovedActions(f.db);
  assert.deepEqual(f.hubspotLeadUpdates, [["L1", "L2"], ["L1", "L2"]]);
  assert.deepEqual(f.byId.get("act1")!.result!.hubspot_revert, { updated: 2, not_in_hubspot: [] });
});

test("Approve: if HubSpot is down, the reassignment in Cockpit stands and the HubSpot error is recorded", async () => {
  const f = fakeActionDb([REASSIGN], makeInputs(), { hubspotDown: true });
  const r = await approveAction(f.db, "act1", "m1", "23 Nov 2026");
  assert.ok(r.ok);
  assert.equal(f.leads.get("L1"), "d2");
  assert.equal(f.byId.get("act1")!.outcome, "done");
  assert.deepEqual(f.byId.get("act1")!.result!.hubspot, { error: "Couldn't reach HubSpot" });
});

test("Reject and other actions never touch HubSpot contacts", async () => {
  const f = fakeActionDb([REASSIGN, PAUSE]);
  await rejectAction(f.db, "act1", "m1");
  await approveAction(f.db, "act2", "m1", "23 Nov 2026");
  assert.deepEqual(f.hubspotLeadUpdates, []);
});

test("Approve: if a lead changed hands since the proposal, nothing changes and the card says why", async () => {
  const f = fakeActionDb([REASSIGN]);
  f.leads.set("L2", "d2");
  const r = await approveAction(f.db, "act1", "m1", "13 Nov 2026");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.action.status, "approved");
    assert.equal(r.action.outcome, "failed");
    assert.match(String(r.action.result!.error), /Nothing changed/);
  }
  assert.equal(f.leads.get("L1"), "d1");
  assert.deepEqual(f.writes, []);
});
