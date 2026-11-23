// Pipeline agent: types and labels shared by the server and the AI agent panel (no secrets, no database code).
import type { GroundingResult } from "./grounding.ts";

export const PIPELINE_AGENT_GOAL = "Find this week's biggest pipeline leaks for the ADR team, investigate the causes, and propose specific fixes.";

/** Limits for one run. Proposals don't count toward maxToolCalls. */
export const PIPELINE_AGENT_LIMITS = {
  /** Investigation (read-only) tool calls per run. */
  maxToolCalls: 8,
  /** propose_action calls that may be recorded per run, on top of maxToolCalls. */
  maxProposals: 3,
  /** The run stops before a turn that could take its cost past this. */
  maxRunCostUsd: 0.5,
  /** Reply limit per turn (thinking + text + tool calls). */
  maxTokensPerTurn: 2000,
  /** Each Claude call gives up after this long. */
  turnTimeoutMs: 60_000,
  /** No new turn starts after this long. */
  runTimeoutMs: 120_000,
  /** Hard stop on turns, in case Claude keeps asking for tools past the limits. */
  maxTurns: 14,
  /** At most this many leads in one reassignment. */
  maxLeadsPerReassign: 25,
  /**
   * A HubSpot task is due between today and this many days after it, by the REAL calendar: tasks are
   * work state on HubSpot's real calendar. (Analysis numbers keep using the as-of date.)
   */
  taskDueWithinDays: 7,
} as const;

/** The person every decision defaults to (the ADR manager). */
export const DEFAULT_DECIDER_ID = "tm_16";

export type ActionType = "reassign_leads" | "pause_sequence" | "create_hubspot_task";
export const ACTION_LABELS: Record<ActionType, string> = {
  reassign_leads: "Reassign leads",
  pause_sequence: "Pause sequence",
  create_hubspot_task: "Create HubSpot task",
};

/** What a proposal holds once checked: ids plus the names the card shows. */
export type ReassignDetails = {
  from_adr_id: string | null; // null = unassigned leads
  from_adr: string; // name, or "Unassigned"
  to_adr_id: string;
  to_adr: string;
  leads: { id: string; contact: string; account: string }[];
};
export type PauseDetails = { sequence_id: string; sequence: string };
export type TaskDetails = {
  object: "company" | "deal";
  record_id: string; // Cockpit account id or deal id
  record: string; // the account name or the deal as users read it
  account_id: string;
  title: string;
  due_date: string; // YYYY-MM-DD
};
export type ActionDetails = ReassignDetails | PauseDetails | TaskDetails;

export type ToolCallRecord = {
  /** Tool name, e.g. "list_overdue_mqls". */
  name: string;
  input: Record<string, unknown>;
  /** The chip text: list_overdue_mqls(Kenji Watanabe). */
  label: string;
  /** A short result: "12 leads", or the error. */
  summary: string;
  ok: boolean;
};

export type RunStatus = "running" | "finished" | "stopped" | "failed";
export type ActionStatus = "proposed" | "approved" | "rejected";
export type ActionOutcome = "done" | "failed" | "reverted";

export type AgentActionView = {
  id: string;
  runId: string;
  type: ActionType;
  details: ActionDetails;
  reason: string;
  status: ActionStatus;
  decidedBy: string | null; // team id
  decidedByName: string | null;
  decidedAt: string | null;
  outcome: ActionOutcome | null;
  result: Record<string, unknown> | null;
};

export type AgentRunView = {
  id: string;
  createdAt: string;
  asOfDate: string;
  goal: string;
  status: RunStatus;
  stopReason: string | null;
  model: string | null;
  toolCalls: ToolCallRecord[];
  summary: string | null;
  grounding: GroundingResult | null;
  claudeCalls: number;
  costUsd: number;
  actions: AgentActionView[];
};

/** Acceptance across every run: approved / (approved + rejected). */
export type AcceptanceStats = { approved: number; rejected: number; waiting: number; rate: number | null };

/** Streamed to the panel while a run is going. */
export type AgentEvent =
  | { type: "started"; runId: string }
  | { type: "tool"; call: ToolCallRecord }
  | { type: "proposal"; action: AgentActionView }
  | { type: "done"; run: AgentRunView }
  | { type: "error"; message: string; notice?: boolean };

/** Grounding field key for the summary and for each proposal's reason. */
export const groundingKey = (proposal: number | null) => (proposal === null ? "summary" : `proposal ${proposal + 1} · reason`);

/** Why a run stopped, as users read it. */
export const STOP_REASON_LABELS: Record<string, string> = {
  finished: "Finished",
  tool_limit: "Used all 8 investigation calls",
  cost_limit: "Stopped at the per-run cost limit",
  time_limit: "Stopped at the 2-minute limit",
  turn_limit: "Stopped at the turn limit",
  daily_budget: "Stopped: today's AI budget is used up",
};
