// House-style formatting: compact money in cards, full money in tables,
// one-decimal percentages, dates like "16 Dec 2026".
import { test } from "node:test";
import assert from "node:assert/strict";
import { QUALIFYING_DESCRIPTION, pct, pctChange, shortDate, signedInt, stageLabel, usd, usdCompact } from "./format.ts";

test("usdCompact: $1.2M, $387K, $950", () => {
  assert.equal(usdCompact(1_234_567), "$1.2M");
  assert.equal(usdCompact(3_069_960), "$3.1M");
  assert.equal(usdCompact(387_400), "$387K");
  assert.equal(usdCompact(999_499), "$999K");
  assert.equal(usdCompact(999_500), "$1.0M"); // never "$1000K"
  assert.equal(usdCompact(950), "$950");
  assert.equal(usdCompact(0), "$0");
  assert.equal(usdCompact(-45_200), "-$45K");
});

test("usd: full figures for tables", () => {
  assert.equal(usd(13_500), "$13,500");
  assert.equal(usd(426_360.4), "$426,360");
});

test("pct and pctChange: one decimal", () => {
  assert.equal(pct(0.6234), "62.3%");
  assert.equal(pct(1), "100.0%");
  assert.equal(pct(null), "n/a");
  assert.equal(pctChange(-0.352), "-35.2%");
  assert.equal(pctChange(0.05), "+5.0%");
  assert.equal(signedInt(-3), "-3");
  assert.equal(signedInt(2), "+2");
});

test("shortDate: 16 Dec 2026", () => {
  assert.equal(shortDate("2026-12-16"), "16 Dec 2026");
  assert.equal(shortDate("2026-09-05T10:00:00Z"), "5 Sep 2026");
});

test("stageLabel: Stage 0.1 shows as Qualifying; other stages unchanged", () => {
  assert.equal(stageLabel("Stage 0.1"), "Qualifying");
  assert.equal(stageLabel("Discovery"), "Discovery");
  assert.equal(QUALIFYING_DESCRIPTION, "meeting held, not yet qualified as an opportunity");
});
