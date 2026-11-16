// The one wrapper for every Claude API call in Cockpit. Server-side only.
// Each call is logged to the llm_calls table: feature, model, tokens, cost, latency.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

// $ per million tokens (Anthropic list prices). Used only to log cost_usd.
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic(); // reads ANTHROPIC_API_KEY from the server environment
  return anthropic;
}

async function logCall(row: { feature: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to log Claude calls");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await db.from("llm_calls").insert(row);
  if (error) console.error(`Logging to llm_calls failed: ${error.message}`);
}

export type CallClaudeInput = {
  feature: string; // e.g. "renewal_risk"; stored in llm_calls.feature
  system: string;
  prompt: string;
  /** Optional JSON Schema: Claude's reply is constrained to it and returned parsed. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
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
  const started = performance.now();
  const response = await client().beta.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: input.maxTokens ?? 16000,
    // If Claude declines on safety grounds, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: input.system,
    messages: [{ role: "user", content: input.prompt }],
    output_config: {
      effort: input.effort ?? "low",
      ...(input.jsonSchema ? { format: { type: "json_schema" as const, schema: input.jsonSchema } } : {}),
    },
  });
  const latencyMs = Math.round(performance.now() - started);

  const inputTokens = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
  const outputTokens = response.usage.output_tokens;
  const price = PRICE_PER_MILLION[response.model] ?? PRICE_PER_MILLION[DEFAULT_MODEL];
  const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;

  await logCall({ feature: input.feature, model: response.model, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, latency_ms: latencyMs });

  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("Claude's reply was cut off (max_tokens).");

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
