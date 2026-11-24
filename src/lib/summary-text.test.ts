// Splitting the agent's summary for display: intro, numbered points with a bold first phrase, outro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstPhrase, splitSummary } from "./summary-text.ts";

test("Summary: intro, numbered points and outro", () => {
  const s = splitSummary("Nadia, three leaks.\n\n1. Kenji has 9 open MQLs, all overdue.\n\n2. The bought-list sequence bounces 15.6%.\n\nSeparately, 3 MQLs are unassigned.");
  assert.equal(s.intro, "Nadia, three leaks.");
  assert.deepEqual(s.points, ["Kenji has 9 open MQLs, all overdue.", "The bought-list sequence bounces 15.6%."]);
  assert.deepEqual(s.outro, ["Separately, 3 MQLs are unassigned."]);
  assert.deepEqual(splitSummary("Just one paragraph."), { intro: "Just one paragraph.", points: [], outro: [] });
});

test("First phrase: up to the first comma or sentence end, never a decimal point", () => {
  assert.deepEqual(firstPhrase("Kenji has 9 open MQLs, all overdue."), ["Kenji has 9 open MQLs,", " all overdue."]);
  assert.deepEqual(firstPhrase("The sequence bounces 15.6% against a 10% line."), ["The sequence bounces 15.6% against a 10% line.", ""]);
  assert.deepEqual(firstPhrase("Short."), ["Short.", ""]);
});

test("First phrase: Claude's own **bold** lead is used, without the asterisks", () => {
  const { points } = splitSummary("Intro.\n1. **Overdue MQLs:** Kenji has 9, the oldest **97 days**.");
  assert.deepEqual(firstPhrase(points[0]), ["Overdue MQLs: ", "Kenji has 9, the oldest 97 days."]);
});
