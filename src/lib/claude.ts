// The one wrapper for every Claude API call in Cockpit. Server-side only.
// Each call is logged to the llm_calls table: feature, model, tokens, cost, latency.
//
// Cost guardrails (apply to every call):
//   - Daily budget: once today's llm_calls cost reaches DAILY_BUDGET_USD, every
//     call is refused with a ClaudeLimitError until midnight UTC.
//   - Output cap: no call may ask for more than MAX_OUTPUT_TOKENS.
//   - Timeouts: a call stopped at its timeout is still logged, at a worst-case estimated cost.
//   - Tool loops: any future agent loop must stop after MAX_TOOL_CALLS_PER_QUESTION.
//
// Note: "today" here is the real calendar day (UTC), because it is real money.
// Business metrics use AS_OF_DATE instead (see src/lib/as-of-date.ts).
import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { callCostUsd, DEFAULT_MODEL, estimateTimedOutCall } from "./claude-cost";

export { DEFAULT_MODEL };
export const DAILY_BUDGET_USD = 2;
/** Hard ceiling on each reply (thinking + answer): at most 4,000 x $10/M = $0.04 of output per call. */
export const MAX_OUTPUT_TOKENS = 4000;
/** No route runs a tool loop today. Any future agent loop must stop after this many tool calls. */
export const MAX_TOOL_CALLS_PER_QUESTION = 6;


/** A guardrail stopped the call. The message is safe to show to users as a notice. */
export class ClaudeLimitError extends Error {
  constructor(
    public readonly kind: "daily_budget" | "timeout" | "rate_limit" | "too_long",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeLimitError";
  }
}

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the server environment
  return anthropic;
}

let supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use Claude");
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabase;
}

/** Midnight UTC at the start of the real current day. */
function startOfTodayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Real Claude spend so far today (UTC), from llm_calls. */
export async function getTodaySpend(): Promise<{ costUsd: number; calls: number }> {
  return sumCalls(startOfTodayUtc());
}

/** All-time spend and call count across every llm_calls row (real API spend, not the demo date). */
export async function getSpendToDate(): Promise<{ costUsd: number; calls: number }> {
  return sumCalls();
}

/** Adds up llm_calls cost and count, optionally from a moment onwards. */
async function sumCalls(sinceIso?: string): Promise<{ costUsd: number; calls: number }> {
  const PAGE = 1000; // Supabase returns at most 1,000 rows per request, so read in pages
  let costUsd = 0;
  let calls = 0;
  for (let from = 0; ; from += PAGE) {
    let query = db().from("llm_calls").select("cost_usd");
    if (sinceIso) query = query.gte("created_at", sinceIso);
    const { data, error } = await query.order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`Reading llm_calls failed: ${error.message}`);
    const rows = data ?? [];
    costUsd += rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);
    calls += rows.length;
    if (rows.length < PAGE) break;
  }
  return { costUsd, calls };
}

async function logCall(row: { feature: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number }) {
  const { error } = await db().from("llm_calls").insert(row);
  if (error) console.error(`Logging to llm_calls failed: ${error.message}`);
}

export type CallClaudeInput = {
  feature: string; // e.g. "renewal_risk"; stored in llm_calls.feature
  system: string;
  /** A single question. Use either prompt or messages. */
  prompt?: string;
  /** A whole conversation (user/assistant turns, ending with the user), for chat. */
  messages?: Anthropic.Beta.BetaMessageParam[];
  /** Cache the system prompt (worth it when a large, unchanging prompt is resent, e.g. chat). */
  cacheSystem?: boolean;
  /** Optional JSON Schema: Claude's reply is constrained to it and returned parsed. */
  jsonSchema?: Record<string, unknown>;
  /** Reply length limit; never above MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  /** Give up after this long (no retries) and throw a ClaudeLimitError("timeout"). */
  timeoutMs?: number;
};

export type CallClaudeResult = {
  text: string;
  json: unknown; // parsed reply when jsonSchema was given, else null
  model: string; // the model that actually answered
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

export async function callClaude(input: CallClaudeInput): Promise<CallClaudeResult> {
  const spent = await getTodaySpend();
  if (spent.costUsd >= DAILY_BUDGET_USD) {
    throw new ClaudeLimitError(
      "daily_budget",
      `Today's AI budget of $${DAILY_BUDGET_USD.toFixed(2)} has been used ($${spent.costUsd.toFixed(2)} so far). AI features are paused until midnight UTC.`,
    );
  }

  const maxTokens = Math.min(input.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  const messages = input.messages ?? [{ role: "user" as const, content: input.prompt ?? "" }];
  const started = performance.now();
  let response;
  try {
    response = await client().beta.messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: maxTokens,
        // If Claude declines on safety grounds, the API retries on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: input.cacheSystem ? [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }] : input.system,
        messages,
        output_config: {
          effort: input.effort ?? "low",
          ...(input.jsonSchema ? { format: { type: "json_schema" as const, schema: input.jsonSchema } } : {}),
        },
      },
      input.timeoutMs ? { timeout: input.timeoutMs, maxRetries: 0 } : undefined,
    );
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      // Anthropic may still bill a call we stopped, so it counts toward the budget at a worst-case
      // estimate. Logged as "<feature>:timeout" so estimated rows are easy to tell apart.
      const est = estimateTimedOutCall({ model: DEFAULT_MODEL, system: input.system, messages, maxTokens });
      await logCall({
        feature: `${input.feature}:timeout`,
        model: DEFAULT_MODEL,
        input_tokens: est.inputTokens,
        output_tokens: est.outputTokens,
        cost_usd: est.costUsd,
        latency_ms: Math.round(performance.now() - started),
      });
      throw new ClaudeLimitError("timeout", "That took too long, so it was stopped. Try a shorter or more specific question.");
    }
    throw e;
  }
  const latencyMs = Math.round(performance.now() - started);

  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  const inputTokens = response.usage.input_tokens + cacheRead + cacheWrite;
  const outputTokens = response.usage.output_tokens;
  const costUsd = callCostUsd({
    model: response.model,
    inputTokens: response.usage.input_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens,
  });

  await logCall({ feature: input.feature, model: response.model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, latency_ms: latencyMs });

  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's reply hit the length limit. Try a narrower question.");

  const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return {
    text,
    json: input.jsonSchema ? JSON.parse(text) : null,
    model: response.model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
  };
}
