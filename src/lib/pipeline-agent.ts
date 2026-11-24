// The Pipeline agent: a tool-use loop for the ADR team. Server-side only.
//
// Claude Sonnet gets a goal and read-only tools (thin wrappers on lib/metrics.ts), decides which to
// call and in what order, and may record up to 3 proposed actions with propose_action. Proposing
// executes nothing: a person approves or rejects each one on ADR Insights (lib/agent-actions.ts).
//
// Limits per run (PIPELINE_AGENT_LIMITS): 8 investigation calls (proposals don't count), 3 proposals,
// a cost limit, a time limit and a turn limit, plus the daily budget in callClaude(). When a limit is
// reached Claude gets one last turn with no tools to write its summary.
//
// Claude and the database are passed in (AgentDeps), so the loop can be tested with both faked.
import type Anthropic from "@anthropic-ai/sdk";
import { estimateTimedOutCall } from "./claude-cost.ts";
import { shortDate } from "./format.ts";
import { checkGrounding } from "./grounding.ts";
import {
  agentWeek,
  calcAgentAdrCapacity,
  calcAgentHygieneSummary,
  calcAgentOverdueMqls,
  calcAgentSequenceStats,
  calcAgentSpeedToLead,
  calcAgentStaleQualifying,
  calcAgentUnassignedLeads,
  type AdrInputs,
} from "./metrics.ts";
import {
  PIPELINE_AGENT_LIMITS as LIMITS,
  groundingKey,
  type ActionDetails,
  type ActionType,
  type AgentActionView,
  type AgentEvent,
  type AgentRunView,
  type ReassignDetails,
  type RunStatus,
  type TaskDetails,
  type ToolCallRecord,
} from "./pipeline-agent-shared.ts";

type Msg = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlock;
type Tool = Anthropic.Beta.BetaTool;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

// --- Tools -----------------------------------------------------------------

const ADR_ARG = { type: "string", description: "The ADR's name (first name is enough) or team id." } as const;

export const AGENT_TOOLS: Tool[] = [
  {
    name: "get_hygiene_summary",
    description: "Every ADR hygiene check (unassigned leads, MQLs past the 24-hour SLA, stale Qualifying deals, qualified leads not handed to an AE, pairing mismatches, leads in sequences with no owner, account tag problems) with its count, split per ADR into records the ADR owns and unassigned records in their territory. Also the 30-day SLA breach rate.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_speed_to_lead",
    description: "Speed to lead per ADR and for the team (assigned ADRs only), plus unassigned MQLs as their own row: MQLs, first touched on time (within 24 hours), late, never touched, on-time %, median hours to first touch. For this week's MQLs and for the last 6 months.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_overdue_mqls",
    description: "Open MQLs past the 24-hour SLA that were never touched, for one ADR, or for unassigned leads (adr: \"Unassigned\"). Longest waiting first, at most 25 shown plus the total. Gives lead ids for reassign_leads.",
    input_schema: { type: "object", properties: { adr: { type: "string", description: "The ADR's name or team id, or \"Unassigned\"." } }, required: ["adr"], additionalProperties: false },
  },
  {
    name: "get_sequence_stats",
    description: "Every outreach sequence: id, owner, status (active or paused), who uses it, enrollments, emails sent, per-email open, click, reply and bounce %, calls booked per enrollment, best or worst rank, and bounce_alert (bounce rate above the alert line).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_adr_capacity",
    description: "Each ADR's open workload: open leads by stage, open MQLs, overdue MQLs, new MQLs this week, open and stale Qualifying deals, and unassigned leads in their territory. Use it to pick who can take more leads.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_stale_qualifying",
    description: "One ADR's Qualifying deals (meeting held, not yet qualified as an opportunity) with no update for 14 days or more: deal id, account id, amount, days without update, AE. These deals are in HubSpot (Qualifying stage), so a task can go on the deal.",
    input_schema: { type: "object", properties: { adr: ADR_ARG }, required: ["adr"], additionalProperties: false },
  },
  {
    name: "list_unassigned_leads",
    description: "Open leads with no ADR in one ADR's territory (name the territory by its ADR): lead id, contact, account, stage, days since created, sequences. At most 25 shown plus the total. Gives lead ids for reassign_leads.",
    input_schema: { type: "object", properties: { territory: { type: "string", description: "The ADR whose territory it is (name or team id)." } }, required: ["territory"], additionalProperties: false },
  },
  {
    name: "propose_action",
    description:
      "Record one proposed fix for a person to approve or reject. Executes nothing. At most 3 per run; they don't count toward the 8 investigation calls. details by type: " +
      "reassign_leads {from_adr: ADR name or \"Unassigned\", to_adr: ADR name, lead_ids: [ids from list_overdue_mqls or list_unassigned_leads]}; " +
      "pause_sequence {sequence_id}; " +
      "create_hubspot_task {object: \"company\" or \"deal\", record_id: account id or deal id, title, due_date: YYYY-MM-DD}.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["reassign_leads", "pause_sequence", "create_hubspot_task"] },
        details: {
          type: "object",
          properties: {
            from_adr: { type: "string" },
            to_adr: { type: "string" },
            lead_ids: { type: "array", items: { type: "string" } },
            sequence_id: { type: "string" },
            object: { type: "string", enum: ["company", "deal"] },
            record_id: { type: "string" },
            title: { type: "string" },
            due_date: { type: "string" },
          },
          additionalProperties: false,
        },
        reason: { type: "string", description: "The leak this fixes and the numbers behind it, from tool results." },
      },
      required: ["type", "details", "reason"],
      additionalProperties: false,
    },
  },
];

const READ_TOOLS = new Set(AGENT_TOOLS.map((t) => t.name).filter((n) => n !== "propose_action"));

// --- System prompt -----------------------------------------------------------

/** Real-calendar date (YYYY-MM-DD) plus days. */
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * asOf: the data's as-of date (every analysis number). today: the real calendar date, used only for
 * HubSpot task due dates, because tasks are work state on HubSpot's real calendar.
 */
export function pipelineAgentSystem(asOf: string, today: string, team: { name: string; role: string }[]): string {
  const week = agentWeek(asOf);
  const adrs = team.filter((t) => t.role === "ADR").map((t) => t.name).join(", ");
  const manager = team.find((t) => t.role === "ADR manager")?.name ?? "the ADR manager";
  return `You are the Pipeline agent for Lumen AI's ADR team (account development reps: ${adrs}; ADR manager:
${manager}). Today is ${shortDate(asOf)}. "This week" means ${shortDate(week.from)} to ${shortDate(week.to)}.

How to work:
- Use the tools to investigate. Start broad (hygiene, speed to lead, capacity, sequences), then
  drill into the ADRs or territories where the problems are. Don't call a tool twice with the
  same input. You have at most ${LIMITS.maxToolCalls} investigation calls; proposals don't count toward them. Plan them.
- Answer only from tool results. Every number, name, date and id you write must appear in a tool
  result from this run. If the tools can't show something, say so; never guess or estimate.
- A cause is something the data shows (for example: one ADR holds most overdue MQLs while another
  has spare capacity; a sequence bounces above the alert line). Say which tool result shows it.

Proposals:
- Use propose_action for fixes a manager could approve today. Proposing doesn't execute anything:
  a person approves or rejects each one.
- reassign_leads: only to an ADR with fewer open MQLs and overdue MQLs, by get_adr_capacity. List
  every lead id, taken from a list tool's results.
- pause_sequence: only for a sequence with bounce_alert true. Never propose moving contacts from a
  high-bounce sequence into another sequence. The fix is to pause it, remove the bounced addresses
  and verify the rest before re-enrolling anyone.
- create_hubspot_task: for follow-ups a person must do (qualify or close out a stale Qualifying
  deal, fix a tag). A task about a deal goes on the deal (object "deal", its deal_id; it is also
  linked to the company). A task about an account goes on the company (its account id). Title is
  an instruction with no numbers ("Qualify or close the Qualifying deal at Acme"). Due dates use the real calendar, not the data's date:
  today is ${today}, so due_date is between ${today} and ${plusDays(today, LIMITS.taskDueWithinDays)}.
- At most ${LIMITS.maxProposals} proposals, the ones that fix the biggest leaks. Each reason names the leak and the
  numbers behind it.

Terms: Qualifying = meeting held, not yet qualified as an opportunity. Leads with no ADR are
counted by the territory they're in: write "in [name]'s territory", never as that ADR's leads.

Finish with a summary for ${manager}, under 150 words: the 2 to 3 biggest leaks this week with their
numbers, the cause of each, and which proposal addresses it. Plain sentences, no headings, no ids.`;
}

export const pipelineAgentGoalMessage = (goal: string) => `Your goal: ${goal}`;

// --- Dependencies ------------------------------------------------------------

export type ModelRequest = { system: string; messages: Msg[]; tools: Tool[]; toolChoice: Anthropic.Beta.BetaToolChoice; maxTokens: number; timeoutMs: number };
export type ModelReply = { content: Block[]; stopReason: string | null; costUsd: number; model: string };

export type RunPatch = Partial<{
  status: RunStatus;
  stop_reason: string | null;
  tool_calls: ToolCallRecord[];
  summary: string | null;
  grounding: unknown;
  claude_calls: number;
  cost_usd: number;
  model: string;
  finished_at: string;
}>;

/** Where runs and proposals are saved. Proposals are saved as "proposed" and nothing else is written. */
export type RunStore = {
  createRun(r: { goal: string; asOfDate: string; model: string }): Promise<string>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  addProposal(p: { runId: string; type: ActionType; details: ActionDetails; reason: string }): Promise<AgentActionView>;
};

export type AgentDeps = {
  callModel: (req: ModelRequest) => Promise<ModelReply>;
  store: RunStore;
  inputs: AdrInputs;
  asOf: string;
  model: string;
  goal: string;
  onEvent?: (e: AgentEvent) => void;
  /** Milliseconds clock, for the time limit (tests pass a fake). */
  clock?: () => number;
  /** The real calendar date (YYYY-MM-DD) for HubSpot task due dates. Defaults to the real clock's date. */
  today?: string;
};

// --- Running a tool ------------------------------------------------------------

type RunContext = {
  inputs: AdrInputs;
  asOf: string;
  /** Real calendar date, for task due dates only. */
  today: string;
  /** Lead ids, sequence ids and record ids that came back from tools in this run. */
  seenLeads: Set<string>;
  seenSequences: Set<string>;
};

type Adr = { id: string; name: string };

/** "Kenji", "kenji watanabe" or "tm_12" -> Kenji Watanabe. "Unassigned" -> null. Unknown -> undefined. */
export function resolveAdr(inputs: AdrInputs, text: unknown, allowUnassigned = false): Adr | null | undefined {
  const t = String(text ?? "").trim().toLowerCase();
  if (allowUnassigned && (t === "unassigned" || t === "none" || t === "")) return null;
  const adrs = inputs.team.filter((m) => m.role === "ADR");
  const hit = adrs.find((a) => a.id.toLowerCase() === t || a.name.toLowerCase() === t) ?? adrs.find((a) => a.name.toLowerCase().split(" ")[0] === t);
  return hit ? { id: hit.id, name: hit.name } : undefined;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

class ToolInputError extends Error {}

/** Runs one read-only tool. Returns the JSON result, a chip label and a short summary. */
export function runReadTool(name: string, input: Record<string, unknown>, ctx: RunContext): { result: unknown; label: string; summary: string } {
  const { inputs, asOf } = ctx;
  const adrArg = (key: string, allowUnassigned: boolean) => {
    const a = resolveAdr(inputs, input[key], allowUnassigned);
    if (a === undefined) {
      const names = inputs.team.filter((m) => m.role === "ADR").map((m) => m.name).join(", ");
      throw new ToolInputError(`Unknown ADR "${String(input[key] ?? "")}". ADRs: ${names}${allowUnassigned ? ', or "Unassigned"' : ""}.`);
    }
    return a;
  };
  switch (name) {
    case "get_hygiene_summary": {
      const r = calcAgentHygieneSummary(inputs, asOf);
      return { result: r, label: name, summary: `${plural(r.total_issues, "issue")}` };
    }
    case "get_speed_to_lead": {
      const r = calcAgentSpeedToLead(inputs, asOf);
      return { result: r, label: name, summary: `${plural(r.this_week.team_assigned_adrs_only.mqls, "MQL")} this week` };
    }
    case "list_overdue_mqls": {
      const a = adrArg("adr", true);
      const r = calcAgentOverdueMqls(inputs, asOf, a?.id ?? null);
      r.leads.forEach((l) => ctx.seenLeads.add(l.lead_id));
      return { result: { adr: a?.name ?? "Unassigned", ...r }, label: `${name}(${a?.name ?? "Unassigned"})`, summary: plural(r.total, "lead") };
    }
    case "get_sequence_stats": {
      const r = calcAgentSequenceStats(inputs, asOf);
      r.sequences.forEach((s) => ctx.seenSequences.add(s.sequence_id));
      return { result: r, label: name, summary: `${plural(r.sequences.filter((s) => s.bounce_alert).length, "bounce alert")}` };
    }
    case "get_adr_capacity": {
      const r = calcAgentAdrCapacity(inputs, asOf);
      return { result: r, label: name, summary: plural(r.adrs.length, "ADR") };
    }
    case "list_stale_qualifying": {
      const a = adrArg("adr", false)!;
      const r = calcAgentStaleQualifying(inputs, asOf, a.id);
      return { result: { adr: a.name, ...r }, label: `${name}(${a.name})`, summary: plural(r.total, "deal") };
    }
    case "list_unassigned_leads": {
      const a = adrArg("territory", false)!;
      const r = calcAgentUnassignedLeads(inputs, asOf, a.id);
      r.leads.forEach((l) => ctx.seenLeads.add(l.lead_id));
      return { result: { territory: `${a.name}'s territory`, ...r }, label: `${name}(${a.name})`, summary: plural(r.total, "lead") };
    }
    default:
      throw new ToolInputError(`Unknown tool "${name}".`);
  }
}

const ENDED: readonly string[] = ["converted", "disqualified", "nurture"];

/** Checks a proposal against the data. Returns the details the card shows, or why it can't be recorded. */
export function checkProposal(raw: Record<string, unknown>, ctx: RunContext): { type: ActionType; details: ActionDetails; reason: string } | { error: string } {
  const { inputs, today } = ctx;
  const type = raw.type as ActionType;
  const d = (raw.details ?? {}) as Record<string, unknown>;
  const reason = String(raw.reason ?? "").trim();
  if (!reason) return { error: "Give a reason: the leak this fixes and the numbers behind it." };
  const accountName = (id: string) => inputs.accounts.find((a) => a.id === id)?.name ?? id;

  if (type === "reassign_leads") {
    const from = resolveAdr(inputs, d.from_adr, true);
    const to = resolveAdr(inputs, d.to_adr);
    if (from === undefined) return { error: `Unknown from_adr "${String(d.from_adr ?? "")}". Use an ADR's name or "Unassigned".` };
    if (!to) return { error: `Unknown to_adr "${String(d.to_adr ?? "")}". Use an ADR's name.` };
    if (from && from.id === to.id) return { error: "from_adr and to_adr are the same ADR." };
    const ids = Array.isArray(d.lead_ids) ? [...new Set(d.lead_ids.map(String))] : [];
    if (ids.length === 0) return { error: "List the lead_ids to reassign." };
    if (ids.length > LIMITS.maxLeadsPerReassign) return { error: `At most ${LIMITS.maxLeadsPerReassign} leads per proposal.` };
    const byId = new Map(inputs.leads.map((l) => [l.id, l]));
    const leads: ReassignDetails["leads"] = [];
    for (const id of ids) {
      const l = byId.get(id);
      if (!l) return { error: `There is no lead "${id}".` };
      if (!ctx.seenLeads.has(id)) return { error: `Lead ${id} didn't come from a list tool in this run. Use ids from list_overdue_mqls or list_unassigned_leads.` };
      if (l.assigned_adr_id !== (from?.id ?? null)) return { error: `Lead ${id} isn't ${from ? `owned by ${from.name}` : "unassigned"}.` };
      if (ENDED.includes(l.lead_stage)) return { error: `Lead ${id} has already ended (${l.lead_stage}).` };
      leads.push({ id, contact: l.contact_name, account: accountName(l.account_id) });
    }
    return { type, reason, details: { from_adr_id: from?.id ?? null, from_adr: from?.name ?? "Unassigned", to_adr_id: to.id, to_adr: to.name, leads } };
  }

  if (type === "pause_sequence") {
    const id = String(d.sequence_id ?? "");
    const s = inputs.sequences.find((q) => q.id === id);
    if (!s) return { error: `There is no sequence "${id}". Use a sequence_id from get_sequence_stats.` };
    if (!ctx.seenSequences.has(id)) return { error: "Call get_sequence_stats first, so the reason rests on its numbers." };
    if (s.status === "paused") return { error: `${s.name} is already paused.` };
    return { type, reason, details: { sequence_id: id, sequence: s.name } };
  }

  if (type === "create_hubspot_task") {
    const object = d.object === "deal" ? "deal" : d.object === "company" ? "company" : null;
    if (!object) return { error: 'object must be "company" or "deal".' };
    const recordId = String(d.record_id ?? "");
    const title = String(d.title ?? "").trim();
    const due = String(d.due_date ?? "");
    if (!title || title.length > 120) return { error: "Give a title of 120 characters or fewer." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: "due_date must be YYYY-MM-DD." };
    // Real calendar: the task lands on HubSpot's calendar, not the demo data's.
    const latest = plusDays(today, LIMITS.taskDueWithinDays);
    if (due < today || due > latest) return { error: `due_date must be between ${today} and ${latest} (today's real date plus ${LIMITS.taskDueWithinDays} days).` };
    let details: TaskDetails;
    if (object === "company") {
      const a = inputs.accounts.find((x) => x.id === recordId);
      if (!a) return { error: `There is no account "${recordId}". Use an account_id from a tool result.` };
      details = { object, record_id: a.id, record: a.name, account_id: a.id, title, due_date: due };
    } else {
      const deal = inputs.deals.find((x) => x.id === recordId);
      if (!deal) return { error: `There is no deal "${recordId}".` };
      // Every deal is in HubSpot, Qualifying deals included (their own stage in New business).
      const stage = deal.stage === "Stage 0.1" ? "Qualifying" : deal.stage;
      details = { object, record_id: deal.id, record: `${accountName(deal.account_id)}: ${stage} deal, $${Math.round(deal.amount_usd).toLocaleString("en-US")}`, account_id: deal.account_id, title, due_date: due };
    }
    return { type, reason, details };
  }

  return { error: 'type must be "reassign_leads", "pause_sequence" or "create_hubspot_task".' };
}

// --- The loop ------------------------------------------------------------------

/** A copy of the messages with a cache mark on the newest block, so each turn re-reads the run so far at the cached price. */
function withCacheMark(messages: Msg[]): Msg[] {
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...((last.content ?? []) as Anthropic.Beta.BetaContentBlockParam[])];
  const end = blocks.length - 1;
  blocks[end] = { ...blocks[end], cache_control: { type: "ephemeral" } } as Anthropic.Beta.BetaContentBlockParam;
  last.content = blocks;
  return out;
}

const textOf = (content: Block[]) => content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();

/** Why Claude gets one last turn with no tools. */
type FinalReason = "tool_limit" | "cost_limit" | "time_limit" | "turn_limit";
const FINAL_NOTE: Record<FinalReason, string> = {
  tool_limit: "You have used every investigation call.",
  cost_limit: "This run has reached its cost limit.",
  time_limit: "This run has reached its time limit.",
  turn_limit: "This run has reached its turn limit.",
};

export async function runPipelineAgent(deps: AgentDeps): Promise<AgentRunView> {
  const { inputs, asOf, store } = deps;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const emit = (e: AgentEvent) => deps.onEvent?.(e);
  const today = deps.today ?? new Date(clock()).toISOString().slice(0, 10);
  const system = pipelineAgentSystem(asOf, today, inputs.team);
  const ctx: RunContext = { inputs, asOf, today, seenLeads: new Set(), seenSequences: new Set() };

  const runId = await store.createRun({ goal: deps.goal, asOfDate: asOf, model: deps.model });
  emit({ type: "started", runId });

  const messages: Msg[] = [{ role: "user", content: pipelineAgentGoalMessage(deps.goal) }];
  const toolCalls: ToolCallRecord[] = [];
  const actions: AgentActionView[] = [];
  const results: unknown[] = [{ as_of: shortDate(asOf), this_week: { from: shortDate(agentWeek(asOf).from), to: shortDate(agentWeek(asOf).to) } }];
  let reads = 0;
  let overLimitAsks = 0;
  let costUsd = 0;
  let claudeCalls = 0;
  let model = deps.model;
  let final: FinalReason | null = null;
  let summary: string | null = null;

  const finish = async (status: RunStatus, stopReason: string | null): Promise<AgentRunView> => {
    const fields: Record<string, string> = {};
    if (summary) fields[groundingKey(null)] = summary;
    actions.forEach((a, i) => (fields[groundingKey(i)] = a.reason));
    const grounding = checkGrounding(fields, results);
    const finishedAt = new Date().toISOString();
    await store.updateRun(runId, { status, stop_reason: stopReason, tool_calls: toolCalls, summary, grounding, claude_calls: claudeCalls, cost_usd: costUsd, model, finished_at: finishedAt });
    const run: AgentRunView = {
      id: runId, createdAt: new Date(started).toISOString(), asOfDate: asOf, goal: deps.goal, status, stopReason, model,
      toolCalls, summary, grounding, claudeCalls, costUsd, actions,
    };
    emit({ type: "done", run });
    return run;
  };

  try {
    for (let turn = 0; ; turn++) {
      // Decide whether this is the last turn (no tools), or whether to stop without one.
      const est = estimateTimedOutCall({ model, system: system + JSON.stringify(AGENT_TOOLS), messages, maxTokens: LIMITS.maxTokensPerTurn }).costUsd;
      const elapsed = clock() - started;
      if (costUsd + est > LIMITS.maxRunCostUsd || elapsed > LIMITS.runTimeoutMs) {
        return await finish("stopped", costUsd + est > LIMITS.maxRunCostUsd ? "cost_limit" : "time_limit");
      }
      if (!final) {
        if (costUsd + 2 * est > LIMITS.maxRunCostUsd) final = "cost_limit";
        else if (elapsed > LIMITS.runTimeoutMs - LIMITS.turnTimeoutMs) final = "time_limit";
        else if (turn >= LIMITS.maxTurns - 1) final = "turn_limit";
        else if (overLimitAsks >= 2) final = "tool_limit";
        if (final) {
          const last = messages[messages.length - 1];
          const note = { type: "text" as const, text: `${FINAL_NOTE[final]} Stop investigating and write the summary now, from the tool results above.` };
          if (last.role === "user") last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, note] : [...((last.content ?? []) as Anthropic.Beta.BetaContentBlockParam[]), note];
          else messages.push({ role: "user", content: [note] });
        }
      }

      const reply = await deps.callModel({
        system,
        messages: withCacheMark(messages),
        tools: AGENT_TOOLS,
        toolChoice: final ? { type: "none" } : { type: "auto" },
        maxTokens: LIMITS.maxTokensPerTurn,
        timeoutMs: LIMITS.turnTimeoutMs,
      });
      claudeCalls++;
      costUsd += reply.costUsd;
      model = reply.model;
      messages.push({ role: "assistant", content: reply.content as unknown as Anthropic.Beta.BetaContentBlockParam[] });

      const uses = reply.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (final || reply.stopReason !== "tool_use" || uses.length === 0) {
        summary = textOf(reply.content) || null;
        return await finish(summary ? "finished" : "stopped", final ?? "finished");
      }

      const toolResults: ToolResult[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const answer = (content: string, isError = false) => toolResults.push({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });

        if (use.name === "propose_action") {
          const label = `propose_action(${String(input.type ?? "?")})`;
          if (actions.length >= LIMITS.maxProposals) {
            answer(`Not recorded: this run already has ${LIMITS.maxProposals} proposals, the most allowed. Write the summary.`, true);
            toolCalls.push({ name: use.name, input, label, summary: "Proposal limit reached", ok: false });
            continue;
          }
          const checked = checkProposal(input, ctx);
          if ("error" in checked) {
            answer(`Not recorded: ${checked.error}`, true);
            toolCalls.push({ name: use.name, input, label, summary: checked.error, ok: false });
            continue;
          }
          const action = await store.addProposal({ runId, ...checked });
          actions.push(action);
          answer(JSON.stringify({ recorded: true, proposal_id: action.id, note: "Recorded for approval. Nothing has been executed.", proposals_left: LIMITS.maxProposals - actions.length }));
          toolCalls.push({ name: use.name, input, label, summary: "Proposed", ok: true });
          emit({ type: "proposal", action });
          continue;
        }

        if (!READ_TOOLS.has(use.name)) {
          answer(`Unknown tool "${use.name}".`, true);
          toolCalls.push({ name: use.name, input, label: use.name, summary: "Unknown tool", ok: false });
          continue;
        }
        if (reads >= LIMITS.maxToolCalls) {
          overLimitAsks++;
          answer(`Not run: all ${LIMITS.maxToolCalls} investigation calls are used. Propose actions from what you have, or write the summary.`, true);
          toolCalls.push({ name: use.name, input, label: use.name, summary: "Not run: limit reached", ok: false });
          continue;
        }
        reads++;
        try {
          const r = runReadTool(use.name, input, ctx);
          results.push(r.result);
          const left = LIMITS.maxToolCalls - reads;
          answer(JSON.stringify(r.result) + (left === 0 ? `\n\nThat was investigation call ${LIMITS.maxToolCalls} of ${LIMITS.maxToolCalls}: no more. You may still propose actions, then write the summary.` : ""));
          const call = { name: use.name, input, label: r.label, summary: r.summary, ok: true };
          toolCalls.push(call);
          emit({ type: "tool", call });
        } catch (e) {
          if (!(e instanceof ToolInputError)) throw e;
          answer(e.message, true);
          const call = { name: use.name, input, label: use.name, summary: e.message, ok: false };
          toolCalls.push(call);
          emit({ type: "tool", call });
        }
      }
      messages.push({ role: "user", content: toolResults });
      await store.updateRun(runId, { tool_calls: toolCalls, claude_calls: claudeCalls, cost_usd: costUsd, model });
    }
  } catch (e) {
    const err = e as { name?: string; kind?: string; message?: string };
    if (err?.name === "ClaudeLimitError") {
      // A guardrail stopped it (daily budget, a turn that timed out): keep what the run found so far.
      return await finish("stopped", err.kind === "daily_budget" ? "daily_budget" : (err.message ?? String(e)));
    }
    await finish("failed", err?.message ?? String(e)).catch(() => undefined);
    throw e;
  }
}
