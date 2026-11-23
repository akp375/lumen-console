// What a Claude call costs, for logging to llm_calls. Pure math, no network, so it can be tested.

export const DEFAULT_MODEL = "claude-sonnet-5-5";

// $ per million tokens (Anthropic list prices). Used only to log cost_usd.
export const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  // Confirmed by the owner against Anthropic's pricing page, 22 Nov 2026 (prompts up to 100K tokens).
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

/** Claude Haiku 5.5: used for high-volume classification (topic tagging). */
export const HAIKU_MODEL = "claude-haiku-5-5";

function price(model: string) {
  return PRICE_PER_MILLION[model] ?? PRICE_PER_MILLION[DEFAULT_MODEL];
}

/** Cost of a finished call. Cached input is billed at 0.1x when read and 1.25x when first written. */
export function callCostUsd(u: { model: string; inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }): number {
  const p = price(u.model);
  return ((u.inputTokens + u.cacheReadTokens * 0.1 + u.cacheWriteTokens * 1.25) * p.input + u.outputTokens * p.output) / 1_000_000;
}

/** Rough characters per token. Kept low (JSON data runs about 3), so estimates err on the high side. */
export const CHARS_PER_TOKEN = 3;

/**
 * Estimated cost of a call we stopped at its timeout. Anthropic may still bill it, but we never see
 * its usage, so we assume the worst: all input at full price (no cache discount) and a full-length reply.
 */
export function estimateTimedOutCall(c: { model: string; system: string; messages: { content?: unknown }[]; maxTokens: number }): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const chars = c.system.length + c.messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length), 0);
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const outputTokens = c.maxTokens;
  return { inputTokens, outputTokens, costUsd: callCostUsd({ model: c.model, inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens }) };
}
