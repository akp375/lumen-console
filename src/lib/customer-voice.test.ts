// "What customers are saying" on the account page: topic counts, sentiment and quotes. Run with `npm test`.
// Today (asOf) = 2026-11-13, so the 90-day window is 2026-08-16 .. 2026-11-13.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcCustomerVoice, type TextSignalRow } from "./metrics.ts";

const AS_OF = "2026-11-13";
let n = 0;
const sig = (date: string, topics: TextSignalRow["topics"], o: Partial<TextSignalRow> = {}): TextSignalRow => ({
  id: `s${String(++n).padStart(2, "0")}`,
  source: "support_ticket",
  source_id: `t${n}`,
  account_id: "A1",
  date,
  topics,
  competitor_name: null,
  sentiment: topics.length ? "negative" : "neutral",
  quote: `quote ${n}`,
  ...o,
});

const SIGNALS = [
  sig("2026-11-12", ["reliability"]), // s01
  sig("2026-11-10", ["pricing_complaint", "competitor_mention"], { competitor_name: "Kestrine", source: "cs_activity" }), // s02
  sig("2026-10-01", ["pricing_complaint"]), // s03
  sig("2026-09-01", [], { sentiment: "positive" }), // s04
  sig("2026-08-16", ["reliability"], { quote: null }), // s05: first day of the window; no quote
  sig("2026-08-15", ["switching_intent"], { competitor_name: "Veyra Labs" }), // s06: day 91, outside the window
  sig("2026-11-20", ["feature_gap"]), // s07: after today, ignored
];

test("Customer voice: counts topics and sentiment over the last 90 days only", () => {
  const v = calcCustomerVoice(SIGNALS, AS_OF);
  assert.equal(v.since, "2026-08-16");
  assert.equal(v.texts, 5); // s01-s05
  assert.deepEqual(v.topics.slice(0, 3), [
    { topic: "pricing_complaint", count: 2 },
    { topic: "reliability", count: 2 },
    { topic: "competitor_mention", count: 1 },
  ]); // most mentioned first; ties in topic order
  assert.equal(v.topics.find((t) => t.topic === "switching_intent")!.count, 0); // s06 is outside the window
  assert.equal(v.topics.length, 6); // every topic is listed
  assert.deepEqual(v.sentiment, { positive: 1, neutral: 0, negative: 4 });
  assert.deepEqual(v.competitors, ["Kestrine"]); // Veyra Labs was outside the window
  assert.equal(v.taggedTotal, 6); // everything up to today
});

test("Customer voice: the 5 most recent quotes, newest first, skipping texts without a quote", () => {
  const v = calcCustomerVoice(SIGNALS, AS_OF);
  assert.deepEqual(v.quotes.map((q) => q.quote), ["quote 1", "quote 2", "quote 3", "quote 4", "quote 6"]); // s05 has no quote; s07 is after today
  assert.equal(v.quotes[1].source, "cs_activity");
});

test("Customer voice: an account with no tagged texts", () => {
  const v = calcCustomerVoice([], AS_OF);
  assert.equal(v.texts, 0);
  assert.equal(v.quotes.length, 0);
  assert.ok(v.topics.every((t) => t.count === 0));
});
