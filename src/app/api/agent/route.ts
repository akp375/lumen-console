// POST /api/agent: the Workspace analyst. Server-side only.
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...] } ending with the user's question.
// Sends the conversation plus a compact data snapshot from lib/metrics.ts to Claude via callClaude().
import { callClaude } from "@/lib/claude";
import { getWorkspaceSnapshot } from "@/lib/metrics";

const SYSTEM = `You are Lumen AI's RevOps analyst. Answer only from the data provided. If it can't answer, say what data is missing. Show the numbers you used.

Keep answers short and scannable: lead with the answer, then the supporting numbers. Use **bold**, bullet lists and simple markdown tables where they help. Format money like $12,345 and rates as percentages.`;

// Limits that keep one request's cost bounded.
const MAX_MESSAGES = 30;
const MAX_CHARS_PER_MESSAGE = 4000;

type ChatMessage = { role: "user" | "assistant"; content: string };

function parseMessages(body: unknown): ChatMessage[] | string {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "Send at least one message.";
  if (messages.length > MAX_MESSAGES) return `This chat is too long (over ${MAX_MESSAGES} messages). Start a new chat.`;
  for (const [i, m] of messages.entries()) {
    const { role, content } = (m ?? {}) as Partial<ChatMessage>;
    if (role !== (i % 2 === 0 ? "user" : "assistant")) return "Messages must alternate user, assistant, user...";
    if (typeof content !== "string" || content.trim() === "") return "Every message needs text.";
    if (content.length > MAX_CHARS_PER_MESSAGE) return `Keep each message under ${MAX_CHARS_PER_MESSAGE} characters.`;
  }
  if (messages.length % 2 === 0) return "The last message must be the user's question.";
  return messages as ChatMessage[];
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const messages = parseMessages(body);
  if (typeof messages === "string") return Response.json({ error: messages }, { status: 400 });

  try {
    const snapshot = await getWorkspaceSnapshot();
    const result = await callClaude({
      feature: "workspace",
      system: `${SYSTEM}\n\nDATA (JSON, as of ${snapshot.as_of_date}):\n${JSON.stringify(snapshot)}`,
      cacheSystem: true, // the snapshot is identical across turns, so follow-ups read it from cache
      messages,
    });
    return Response.json({ text: result.text, costUsd: result.costUsd, latencyMs: result.latencyMs });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
