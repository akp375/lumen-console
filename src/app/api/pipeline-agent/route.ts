// POST /api/pipeline-agent: runs the Pipeline agent once and streams what it does. Server-side only.
// Running only reads data and records proposals (nothing executes), so it works anywhere, like the
// memo's Generate button; approving a proposal is local-only (see adr-insights/actions.ts).
// One run at a time per server process.
//
// Responses:
//   200  a stream of JSON lines: AgentEvent ({ type: "started" | "tool" | "proposal" | "done" | "error" })
//   403 / 409 { error }   not from Cockpit's page, or a run is already going
import { startPipelineAgentRun } from "@/lib/pipeline-agent-run";
import type { AgentEvent } from "@/lib/pipeline-agent-shared";
import { isMissingAgentTables } from "@/lib/agent-db";

let running = false;

export async function POST(request: Request) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (request.headers.get("x-cockpit-agent") !== "1" || (origin && new URL(origin).host !== host)) {
    return Response.json({ error: "Start the agent from the ADR Insights page." }, { status: 403 });
  }
  if (running) return Response.json({ error: "The agent is already running. Wait for it to finish." }, { status: 409 });

  running = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
      try {
        await startPipelineAgentRun(send);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        send({
          type: "error",
          message: isMissingAgentTables(message) ? "Saving runs needs supabase/migrations/20261130000000_pipeline_agent.sql to be run in Supabase." : message,
        });
      } finally {
        running = false;
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
