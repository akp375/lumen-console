// Grounding check for AI write-ups: every number Claude writes must appear in the data it was given.
// Pure text matching, no network, so it can be tested. It flags; it never blocks or edits.
//
// Rules:
//   - Every number in the input counts: numeric values, and numbers inside text ("24-hour", "Tier 3").
//   - A number in the write-up is grounded when its value equals one of those, after removing "$",
//     "," and "%": "$34,800" matches 34800, "64.0%" matches 64.
//   - Dates ("13 Nov 2026") are checked whole against the dates written in the input, not digit by digit.
//   - Abbreviations aren't expanded: "$35K" is flagged, because the input never says 35.
//   - Signs are ignored ("4.9 points below" matches -4.9); numbers written as words ("three") aren't checked.

// Whole month names only, so a name such as "Marin" is never read as "Mar".
const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
/** "13 Nov 2026", "1 Oct", "Nov 13, 2026", "2026-11-13" */
const DATE_RE = new RegExp(`\\b\\d{1,2} (?:${MONTHS})\\b(?: \\d{4})?|\\b(?:${MONTHS}) \\d{1,2}\\b(?:, \\d{4})?|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "g");
/** $34,800 / 64.3% / 0.1 / 1,205 / 24 (a leading minus or plus is ignored) */
const NUMBER_RE = /\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\$?\d+(?:\.\d+)?%?/g;

/** "13 November 2026" and "13 Nov 2026" compare equal; "Nov 13, 2026" too. */
const normDate = (s: string) => {
  const t = s.toLowerCase().replace(/,/g, "").replace(/\s+/g, " ").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const parts = t.split(" ");
  const month = parts.find((p) => /^[a-z]/.test(p))!.slice(0, 3);
  const nums = parts.filter((p) => /^\d/.test(p));
  return [nums.find((n) => n.length <= 2), month, nums.find((n) => n.length === 4)].filter(Boolean).join(" ");
};
const toValue = (token: string) => Number(token.replace(/[$,%]/g, ""));

/** Every number and date the input contains. */
export function collectGrounding(input: unknown): { numbers: Set<number>; dates: Set<string> } {
  const numbers = new Set<number>();
  const dates = new Set<string>();
  const fromText = (s: string) => {
    for (const d of s.match(DATE_RE) ?? []) dates.add(normDate(d));
    for (const n of s.replace(DATE_RE, " ").match(NUMBER_RE) ?? []) numbers.add(toValue(n));
    // A date's parts also count as numbers ("2026", "13"), so "in 2026" is grounded too.
    for (const d of s.match(DATE_RE) ?? []) for (const n of d.match(/\d+/g) ?? []) numbers.add(Number(n));
  };
  const walk = (v: unknown, key?: string) => {
    if (key) fromText(key);
    if (typeof v === "number" && Number.isFinite(v)) numbers.add(v);
    else if (typeof v === "string") fromText(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(input);
  return { numbers, dates };
}

export type UngroundedNumber = { field: string; text: string };
export type GroundingResult = { checked: number; ungrounded: UngroundedNumber[] };

/** Signs are ignored: "4.9 points below the team" restates -4.9. */
const close = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) < 1e-9;

/**
 * Checks every text field of a write-up against the input.
 * `fields` maps a label (for example "Recommendation 2 · finding") to its text.
 */
export function checkGrounding(fields: Record<string, string>, input: unknown): GroundingResult {
  const { numbers, dates } = collectGrounding(input);
  const known = [...numbers];
  let checked = 0;
  const ungrounded: UngroundedNumber[] = [];
  for (const [field, text] of Object.entries(fields)) {
    for (const d of text.match(DATE_RE) ?? []) {
      checked++;
      const n = normDate(d);
      // A date written without its year ("1 Oct") is grounded if the input has that day and month.
      if (!dates.has(n) && ![...dates].some((x) => x.startsWith(`${n} `))) ungrounded.push({ field, text: d });
    }
    for (const token of text.replace(DATE_RE, " ").match(NUMBER_RE) ?? []) {
      checked++;
      const v = toValue(token);
      if (!known.some((k) => close(k, v))) ungrounded.push({ field, text: token });
    }
  }
  return { checked, ungrounded };
}
