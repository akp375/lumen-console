// POST /api/hubspot-sync: runs the full HubSpot sync (the same code as `npm run hubspot:sync`). Server-side only.
// Local dev only until Cockpit has a login (see lib/local-only.ts). One run at a time.
//
// Responses:
//   200  a stream of JSON lines: { type: "progress", line } ... then { type: "done", result } or { type: "error", message }
//   403 / 409 { error }   not allowed here, or a sync is already running
import { runHubSpotSync } from "@/lib/hubspot-sync-run";
import { isLocalDev, LOCAL_ONLY_NOTE } from "@/lib/local-only";

let running = false; // per server process; the dev server is a single process

export async function POST(request: Request) {
  const host = request.headers.get("host");
  if (!isLocalDev(host)) return Response.json({ error: `${LOCAL_ONLY_NOTE}.` }, { status: 403 });
  // Only Cockpit's own page may start a sync: the custom header can't be sent by another website without permission,
  // and the origin, when present, must be this server.
  const origin = request.headers.get("origin");
  if (request.headers.get("x-cockpit-sync") !== "1" || (origin && new URL(origin).host !== host)) {
    return Response.json({ error: "Start the sync from the Integrations page." }, { status: 403 });
  }
  if (running) return Response.json({ error: "A sync is already running. Wait for it to finish." }, { status: 409 });

  running = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg: unknown) => controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
      try {
        const result = await runHubSpotSync({ source: "button", onProgress: (line) => send({ type: "progress", line }) });
        send({ type: "done", result });
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        running = false;
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
