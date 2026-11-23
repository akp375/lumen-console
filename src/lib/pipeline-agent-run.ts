// Runs the Pipeline agent for real: Claude through callClaude() (feature "pipeline_agent", logged to
// llm_calls, daily budget applies), ADR data from lib/metrics.ts, runs saved to Supabase. Server-side only.
import { AS_OF_DATE } from "./as-of-date";
import { callClaude, DEFAULT_MODEL } from "./claude";
import { loadAdrInputs } from "./metrics";
import { runPipelineAgent } from "./pipeline-agent";
import { supabaseRunStore } from "./agent-db";
import { PIPELINE_AGENT_GOAL, type AgentEvent, type AgentRunView } from "./pipeline-agent-shared";

export async function startPipelineAgentRun(onEvent: (e: AgentEvent) => void): Promise<AgentRunView> {
  const inputs = await loadAdrInputs();
  return runPipelineAgent({
    inputs,
    asOf: AS_OF_DATE,
    model: DEFAULT_MODEL,
    goal: PIPELINE_AGENT_GOAL,
    store: supabaseRunStore,
    onEvent,
    callModel: async (req) => {
      const r = await callClaude({
        feature: "pipeline_agent",
        model: DEFAULT_MODEL,
        system: req.system,
        cacheSystem: true,
        messages: req.messages,
        tools: req.tools,
        toolChoice: req.toolChoice,
        maxTokens: req.maxTokens,
        timeoutMs: req.timeoutMs,
      });
      return { content: r.content, stopReason: r.stopReason, costUsd: r.costUsd, model: r.model };
    },
  });
}
