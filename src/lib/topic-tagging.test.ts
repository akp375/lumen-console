// Topic tagging: cleaning Claude's answer before it is stored. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTagResult } from "./topic-tagging.ts";

const TEXT = "After the recent outages, the COO said they're \"seriously looking\" at Kestrine.";

test("Tag result: known topics only, competitor must appear in the text, quote must be word for word", () => {
  const r = parseTagResult({ topics: ["reliability", "switching_intent", "made_up", "reliability"], competitor_name: "Kestrine", sentiment: "negative", quote: "seriously looking" }, TEXT);
  assert.deepEqual(r.topics, ["switching_intent", "reliability"]); // known topics, in topic order, no duplicates
  assert.equal(r.competitorName, "Kestrine");
  assert.equal(r.sentiment, "negative");
  assert.equal(r.quote, "seriously looking");
  assert.equal(r.quoteRejected, false);
});

test("Tag result: an invented competitor name or paraphrased quote is dropped", () => {
  const r = parseTagResult({ topics: [], competitor_name: "Veyra Labs", sentiment: "angry", quote: "they are seriously considering Kestrine" }, TEXT);
  assert.equal(r.competitorName, null); // not in the text
  assert.equal(r.sentiment, "neutral"); // unknown sentiment falls back to neutral
  assert.equal(r.quote, null);
  assert.equal(r.quoteRejected, true);
});

test("Tag result: surrounding quote marks are ignored when checking the quote", () => {
  assert.equal(parseTagResult({ topics: [], competitor_name: null, sentiment: "neutral", quote: "\u201cseriously looking\u201d" }, TEXT).quote, "seriously looking");
});
