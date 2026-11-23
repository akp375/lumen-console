// Topic tagging: Claude Haiku 5.5 reads one ticket description or CSM note and returns its
// risk topics, sentiment and one short quote. Server-side only. Every call goes through
// callClaude() (feature "topic_tagging"), so it is logged to llm_calls and counts toward the
// $2 daily budget. Used by `npm run signals:tag`; results are stored in text_signals.
import { callClaude, HAIKU_MODEL } from "./claude.ts";
import { SENTIMENTS, SIGNAL_TOPICS, type Sentiment, type SignalTopic } from "./signal-topics.ts";

export { SENTIMENTS, SIGNAL_TOPICS, type Sentiment, type SignalTopic };

export const TAGGING_FEATURE = "topic_tagging";
/** Bumped whenever TAGGING_SYSTEM changes. v2 (23 Nov 2026): unnamed vendor comparisons, spend scrutiny, and questions vs feature gaps. */
export const TAGGING_PROMPT_VERSION = 2;

export const TAGGING_SYSTEM = `You tag short texts written about customers of a B2B AI software vendor: support tickets (the customer's words) and customer success notes (the account manager's words about the customer).

Tag only what the text actually says about this customer. A text can have several topics, or none. When it's unclear or only hinted at, leave the topic out.

Topics:
- competitor_mention: a specific rival product or vendor is named; or the customer compares us with what other vendors offer or do, even unnamed (for example "as some other vendors do"); or they are clearly using, trialling or being pitched by another vendor. A remark that every vendor is being reviewed, with no comparison, is not enough.
- switching_intent: signs the customer may leave or replace us: evaluating replacements, planning a migration or a full data export to leave, budgeting the renewal at zero, saying the renewal decision is open against alternatives, or threatening to move the work elsewhere. Routine procurement reviews or curiosity are not switching intent.
- pricing_complaint: unhappiness about price, cost, invoices, overages, or paying for seats or products they don't use; pressure for a lower price; or scrutiny of what they're paying for (wanting to understand, justify or break down their spend before a decision). A neutral request for pricing information, such as a price sheet, is not a complaint.
- implementation_issue: setup, integration, onboarding, configuration, permissions or rollout problems that block or slow their use.
- reliability: outages, errors, failed jobs, timeouts, slowness or instability they experienced.
- feature_gap: a capability they need that the product doesn't have: the text says it's missing, unsupported or not on the roadmap, or they point to another vendor that offers it. A question about whether or how something works is not a feature gap unless the text says it's unsupported, with one exception: asking whether we offer something that other vendors offer (for example "do you offer X, as some other vendors do?") is a feature gap and a competitor_mention.

competitor_name: the competitor's name exactly as written if one is named, otherwise null.
sentiment: the customer's overall attitude towards us in this text (positive, neutral or negative). A problem that blocks or slows their use of the product is negative, even when the cause is on their side (for example their IT hasn't set up SSO).
quote: copy, word for word from the text, the shortest phrase (at most 20 words) that best shows the most important topic; if there is no topic, the most informative phrase.`;

export const TAGGING_SCHEMA = {
  type: "object",
  properties: {
    topics: { type: "array", items: { type: "string", enum: [...SIGNAL_TOPICS] } },
    competitor_name: { anyOf: [{ type: "string" }, { type: "null" }] },
    sentiment: { type: "string", enum: [...SENTIMENTS] },
    quote: { type: "string" },
  },
  required: ["topics", "competitor_name", "sentiment", "quote"],
  additionalProperties: false,
} as const;

export type TagResult = { topics: SignalTopic[]; competitorName: string | null; sentiment: Sentiment; quote: string | null; quoteRejected: boolean };

/** Cleans Claude's answer: known topics only, no duplicates, a competitor name only if it appears in the text,
 *  and a quote only if it is copied word for word from the text (otherwise null, and quoteRejected is true). */
export function parseTagResult(raw: unknown, text: string): TagResult {
  const r = (raw ?? {}) as { topics?: unknown; competitor_name?: unknown; sentiment?: unknown; quote?: unknown };
  const topics = SIGNAL_TOPICS.filter((t) => Array.isArray(r.topics) && r.topics.includes(t));
  const name = typeof r.competitor_name === "string" ? r.competitor_name.trim() : "";
  const competitorName = name && text.toLowerCase().includes(name.toLowerCase()) ? name : null;
  const sentiment = (SENTIMENTS as readonly string[]).includes(r.sentiment as string) ? (r.sentiment as Sentiment) : "neutral";
  const quote = typeof r.quote === "string" ? r.quote.trim().replace(/^["“]|["”]$/g, "") : "";
  const verbatim = quote.length > 0 && text.includes(quote);
  return { topics, competitorName, sentiment, quote: verbatim ? quote : null, quoteRejected: quote.length > 0 && !verbatim };
}

export type TagInput = { source: "support_ticket" | "cs_activity"; kind: string; text: string };

/** One text, one call. Throws ClaudeLimitError when the daily budget is used up. */
export async function tagText(input: TagInput): Promise<TagResult & { costUsd: number; model: string; inputTokens: number; outputTokens: number }> {
  const label = input.source === "support_ticket" ? "Support ticket (customer's words)" : `Customer success note, ${input.kind} (account manager's words)`;
  const res = await callClaude({
    feature: TAGGING_FEATURE,
    model: HAIKU_MODEL,
    system: TAGGING_SYSTEM,
    prompt: `${label}:\n${input.text}`,
    jsonSchema: TAGGING_SCHEMA as unknown as Record<string, unknown>,
    effort: "low",
    maxTokens: 1500,
    timeoutMs: 30_000,
  });
  return { ...parseTagResult(res.json, input.text), costUsd: res.costUsd, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
}
