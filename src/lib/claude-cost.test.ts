// Cost of Claude calls as logged to llm_calls, including the estimate for timed-out calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callCostUsd, estimateTimedOutCall } from "./claude-cost.ts";

test("finished call: input, cache read/write and output at Sonnet 5.5 prices", () => {
  // (1,000 + 10,000 x 0.1 + 2,000 x 1.25) x $2/M + 500 x $10/M = 4,500 x 2 / 1M + 5,000 / 1M = $0.009 + $0.005
  const cost = callCostUsd({ model: "claude-sonnet-5-5", inputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 2_000, outputTokens: 500 });
  assert.ok(Math.abs(cost - 0.014) < 1e-12);
});

test("unknown model falls back to the default model's prices", () => {
  const a = callCostUsd({ model: "claude-mystery", inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  assert.equal(a, 2);
});

test("timed-out call: worst case, full-price input from characters and a full-length reply", () => {
  // 3,000 system chars + 300 + 600 message chars = 3,900 chars / 3 = 1,300 tokens.
  // 1,300 x $2/M + 4,000 x $10/M = $0.0026 + $0.04 = $0.0426
  const e = estimateTimedOutCall({
    model: "claude-sonnet-5-5",
    system: "x".repeat(3_000),
    messages: [{ content: "q".repeat(300) }, { content: "a".repeat(600) }],
    maxTokens: 4_000,
  });
  assert.equal(e.inputTokens, 1_300);
  assert.equal(e.outputTokens, 4_000);
  assert.ok(Math.abs(e.costUsd - 0.0426) < 1e-12);
});

test("timed-out call rounds input tokens up", () => {
  const e = estimateTimedOutCall({ model: "claude-sonnet-5-5", system: "ab", messages: [{ content: "c" }, { content: "d" }], maxTokens: 10 });
  assert.equal(e.inputTokens, 2); // 4 chars / 3 = 1.33 -> 2
});

test("Claude Haiku 5.5: $0.10 input and $0.50 output per million tokens", () => {
  // 1,000 input + 200 output = 0.0001 + 0.0001 = $0.0002
  const cost = callCostUsd({ model: "claude-haiku-5-5", inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 });
  assert.ok(Math.abs(cost - 0.0002) < 1e-12, `got ${cost}`);
});
