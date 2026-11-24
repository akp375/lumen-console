// POST /api/agent: the Workspace analyst. Server-side only.
// Body: { messages: [{ role: "user" | "assistant", content: string }, ...] } ending with the user's question.
// Sends recent conversation plus a compact data snapshot from lib/metrics.ts to Claude via callClaude().
//
// Responses:
//   200 { text, model, costUsd, latencyMs }   an answer
//   429 { notice, kind }               a guardrail stopped it (show as a notice, not an error)
//   400 / 500 { error }                bad request or something broke
import { callClaude, ClaudeLimitError } from "@/lib/claude";
import { getWorkspaceSnapshot } from "@/lib/metrics";
import { HISTORY_MESSAGES, MAX_QUESTION_CHARS, QUESTIONS_PER_HOUR, TIMEOUT_MS } from "@/lib/workspace-limits";

const SYSTEM = `You are Lumen AI's RevOps analyst. Answer only from the data provided. If it can't answer, say what data is missing. Show the numbers you used.

Keep answers short and scannable: lead with the answer, then the supporting numbers. Use **bold**, bullet lists and simple markdown tables where they help. Format money in full like $12,345 (or $1.2M / $387K in a one-line summary), percentages to one decimal like 62.3%, and dates like 16 Dec 2026.`;

// Guardrails (shared numbers live in workspace-limits.ts).
const MAX_ANSWER_CHARS = 20_000; // earlier answers sent back as history
const HOUR_MS = 3_600_000;

// Questions per browser, kept in this server's memory. It resets when the server
// restarts; the daily budget in callClaude() is the hard backstop.
const BROWSER_COOKIE = "cockpit_browser";
const asked = new Map<string, number[]>();

function browserId(request: Request): { id: string; isNew: boolean } {
  const match = /(?:^|;\s*)cockpit_browser=([a-f0-9-]{36})/.exec(request.headers.get("cookie") ?? "");
  return match ? { id: match[1], isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

/** Records a question; returns minutes until the next one is allowed, or 0 if allowed now. */
function takeQuestionSlot(id: string): number {
  const now = Date.now();
  const recent = (asked.get(id) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= QUESTIONS_PER_HOUR) {
    asked.set(id, recent);
    return Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 60_000));
  }
  recent.push(now);
  asked.set(id, recent);
  return 0;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

function parseMessages(body: unknown): ChatMessage[] | string {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return "Send at least one message.";
  for (const [i, m] of messages.entries()) {
    const { role, content } = (m ?? {}) as Partial<ChatMessage>;
    if (role !== (i % 2 === 0 ? "user" : "assistant")) return "Messages must alternate user, assistant, user...";
    if (typeof content !== "string" || content.trim() === "") return "Every message needs text.";
    if (content.length > (role === "user" ? MAX_QUESTION_CHARS : MAX_ANSWER_CHARS)) return "A message in this chat is too long.";
  }
  if (messages.length % 2 === 0) return "The last message must be the user's question.";
  // Keep only the last HISTORY_MESSAGES before the question (still starts with a user turn).
  return (messages as ChatMessage[]).slice(-(HISTORY_MESSAGES + 1));
}

export async function POST(request: Request) {
  const browser = browserId(request);
  const respond = (body: object, status: number) => {
    const res = Response.json(body, { status });
    if (browser.isNew) res.headers.append("Set-Cookie", `${BROWSER_COOKIE}=${browser.id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    return res;
  };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Request body must be JSON." }, 400);
  }
  const question = ((body as { messages?: { content?: unknown }[] })?.messages ?? []).at(-1)?.content;
  if (typeof question === "string" && question.length > MAX_QUESTION_CHARS) {
    return respond({ kind: "too_long", notice: `Questions are limited to ${MAX_QUESTION_CHARS.toLocaleString("en-US")} characters. Please shorten yours.` }, 429);
  }
  const messages = parseMessages(body);
  if (typeof messages === "string") return respond({ error: messages }, 400);

  const waitMinutes = takeQuestionSlot(browser.id);
  if (waitMinutes > 0) {
    return respond(
      { kind: "rate_limit", notice: `You've reached ${QUESTIONS_PER_HOUR} questions this hour. You can ask again in about ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"}.` },
      429,
    );
  }

  try {
    const snapshot = await getWorkspaceSnapshot();
    const result = await callClaude({
      feature: "workspace",
      system: `${SYSTEM}\n\nDATA (JSON, as of ${snapshot.as_of_date}):\n${JSON.stringify(snapshot)}`,
      cacheSystem: true, // the snapshot is identical across turns, so follow-ups read it from cache
      messages,
      timeoutMs: TIMEOUT_MS,
    });
    return respond({ text: result.text, model: result.model, costUsd: result.costUsd, latencyMs: result.latencyMs }, 200);
  } catch (e) {
    if (e instanceof ClaudeLimitError) return respond({ kind: e.kind, notice: e.message }, 429);
    return respond({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
