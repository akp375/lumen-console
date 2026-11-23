/**
 * Builds the free text for Cockpit (built for Lumen AI): a short description on
 * every support ticket and a short note on every CSM call, meeting, QBR and exec
 * meeting (emails get no note).
 *
 * Used by `npm run text:backfill` (live rows) and by `npm run seed` (the rows it
 * has just generated), so both always produce the same text for the same data.
 *
 * Pure functions: no database, no real clock. Random numbers come from a fixed
 * seed per row, separate from every other seed stream, so nothing that already
 * exists can shift. This file only shapes demo data; the app never reads the
 * `intended` labels below (they exist for the reconciliation check and the eval).
 *
 * Writing rules (agreed with the owner, 22 Nov 2026):
 *   - Varied and realistic, not keyword-obvious: indirect phrasings, texts that
 *     mix two topics, and some genuinely ambiguous ones.
 *   - Risky topics are concentrated in declining accounts and rare in healthy ones.
 *   - Fictional competitor names only: Brontide AI, Veyra Labs, Kestrine.
 *   - Ionic Retail and Copperleaf Media carry a few clear examples.
 */
import { createHash } from "node:crypto";

export const COMPETITORS = ["Brontide AI", "Veyra Labs", "Kestrine"] as const;

export const TOPICS = ["competitor_mention", "switching_intent", "pricing_complaint", "implementation_issue", "reliability", "feature_gap"] as const;
export type Topic = (typeof TOPICS)[number];

/** What a text was written to say. Seeding and eval only; the tagger never sees it. */
export type Intended = { topics: Topic[]; ambiguous: boolean; competitor: string | null };

export type TextTicket = { id: string; account_id: string; opened_at: string; severity: string };
export type TextActivity = { id: string; account_id: string; activity_date: string; type: string; attendee_level: string };
export type TextTier = "healthy" | "middle" | "declining-quiet" | "declining-burst";

export type BuiltTexts = {
  descriptions: Map<string, string>; // ticket id -> description
  notes: Map<string, string>; // activity id -> note (emails left out)
  intended: Map<string, Intended>; // "ticket:<id>" or "activity:<id>"
};

// ---------------------------------------------------------------------------
// Random numbers: own seed stream, one generator per row
// ---------------------------------------------------------------------------

const SEED = "lumen-ai-text-v1";

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(label: string) {
  let state = hashString(`${SEED}:${label}`);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r < 0) return item;
      }
      return items[items.length - 1][0];
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

const DAY_MS = 86_400_000;
const daysBefore = (asOf: string, date: string) => Math.round((Date.parse(asOf.slice(0, 10)) - Date.parse(date.slice(0, 10))) / DAY_MS);

// ---------------------------------------------------------------------------
// What each text is about: weights by account tier and how recent it is
// ---------------------------------------------------------------------------

type Kind =
  | "neutral"
  | "positive"
  | "ambiguous"
  | "reliability"
  | "implementation"
  | "feature_gap"
  | "pricing"
  | "competitor"
  | "switching"
  | "mixed";

type Weights = readonly (readonly [Kind, number])[];

// Declining accounts in the last 180 days carry most of the risky text; healthy accounts rarely do.
const WEIGHTS: Record<"healthy" | "middle" | "declining", Weights> = {
  healthy: [["neutral", 58], ["positive", 28], ["ambiguous", 7], ["implementation", 2], ["feature_gap", 2.5], ["reliability", 1], ["pricing", 0.5]],
  middle: [["neutral", 46], ["positive", 15], ["ambiguous", 10], ["implementation", 8], ["feature_gap", 8], ["reliability", 6], ["pricing", 4], ["mixed", 2], ["competitor", 1]],
  declining: [["neutral", 22], ["positive", 3], ["ambiguous", 10], ["implementation", 10], ["feature_gap", 8], ["reliability", 13], ["pricing", 12], ["competitor", 8], ["switching", 5], ["mixed", 9]],
};
const RECENT_DAYS = 180;

function chooseKind(r: Rng, tier: TextTier, recentDays: number, source: "ticket" | "activity", severity?: string): Kind {
  const base: "healthy" | "middle" | "declining" =
    tier === "healthy" ? "healthy" : tier === "middle" ? "middle" : recentDays <= RECENT_DAYS ? "declining" : "middle";
  let w: Weights = WEIGHTS[base];
  if (source === "ticket") {
    // Tickets are problems or questions: rarely praise, rarely talk about rivals or leaving.
    // Urgent and high tickets lean to reliability and implementation.
    const sev = severity === "urgent" || severity === "high";
    w = w.map(([k, n]) => {
      if (k === "positive") return [k, n * 0.15] as const;
      if (k === "competitor" || k === "switching") return [k, n * 0.25] as const;
      if (sev && (k === "reliability" || k === "implementation")) return [k, n * 2.2] as const;
      if (sev && k === "neutral") return [k, n * 0.5] as const;
      return [k, n] as const;
    });
  }
  return r.weighted(w);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

const ROLES: Record<string, readonly string[]> = {
  executive: ["their CFO", "the COO", "their CTO", "the VP Operations", "their Chief Data Officer", "the Head of Legal Ops"],
  manager: ["the ops manager", "their data team lead", "the engineering manager", "their IT admin", "the support lead", "the analytics manager"],
  user: ["one of their analysts", "a power user on the claims team", "the team lead on the floor", "two of their reviewers", "a new user from finance"],
};
const FEATURES = ["document summaries", "the chat assistant", "data extraction", "code review", "the Extract add-on", "summaries on long contracts"];
const MONTHS = ["January", "February", "March", "April", "May", "June"];

type Slots = { r: string; c: string; f: string; n: string; m: string };

function fill(t: string, s: Slots): string {
  const out = t.replace(/\{(r|c|f|n|m)\}/g, (_, k: keyof Slots) => s[k]);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// ---------------------------------------------------------------------------
// Ticket descriptions (customer's voice). [template, topics]
// ---------------------------------------------------------------------------

type T = readonly [string, readonly Topic[]];

const TICKET: Record<Exclude<Kind, "mixed" | "ambiguous" | "neutral" | "positive"> | "mixed" | "ambiguous" | "neutral" | "positive", readonly T[]> = {
  reliability: [
    ["Summaries have been timing out since this morning for most of our team. We retried a few times with no luck.", ["reliability"]],
    ["Extraction jobs keep failing halfway through larger PDFs. Third time this week.", ["reliability"]],
    ["Answers from the chat assistant are taking 40+ seconds today, which is blocking our support queue.", ["reliability"]],
    ["Every code review run returned a 502 between 9 and 11am. Was there an incident?", ["reliability"]],
    ["The status page said all systems normal, but half of last night's batch never processed.", ["reliability"]],
    ["Same problem as last week is back: summaries come back empty for anything over 30 pages.", ["reliability"]],
    ["Our ops team has started keeping a manual backup process \"just in case\" after last month's outages.", ["reliability"]],
    ["We lost about two hours of work when the session dropped mid-review. Can you check what happened on your side?", ["reliability"]],
    ["Users are getting logged out every few minutes since the update on Tuesday.", ["reliability"]],
  ],
  implementation: [
    ["SSO with Okta fails at the SAML step. We've followed the setup guide twice.", ["implementation_issue"]],
    ["We can't get the Salesforce connector to map our custom fields, and the rollout is on hold until it does.", ["implementation_issue"]],
    ["Webhook payloads don't match the docs, so our integration breaks on every update.", ["implementation_issue"]],
    ["We're three weeks past our planned go-live and the team still can't use it day to day.", ["implementation_issue"]],
    ["Our nightly sync gets throttled by the API rate limits and never finishes. Need help sizing this.", ["implementation_issue"]],
    ["Setting up permissions for the second business unit keeps locking people out of their own workspaces.", ["implementation_issue"]],
    ["The Slack app installs fine but never posts anything to the channel we picked.", ["implementation_issue"]],
  ],
  feature_gap: [
    ["Is there any way to export extraction results to Excel? Our analysts are copying them over by hand.", ["feature_gap"]],
    ["We need audit logs for compliance. Legal won't sign off on a wider rollout without them.", ["feature_gap"]],
    ["Code review doesn't understand our monorepo layout. Is that planned?", ["feature_gap"]],
    ["Our team keeps asking for things the product doesn't do yet; summaries in Portuguese are the big one.", ["feature_gap"]],
    ["There's no way to set role-based access per workspace, which our security team calls a must-have.", ["feature_gap"]],
    ["Can summaries keep the original document's headings? Right now we reformat every one.", ["feature_gap"]],
  ],
  pricing: [
    ["Our latest invoice is much higher than expected. Can someone explain the overage charges?", ["pricing_complaint"]],
    ["We're billed for 40 seats but only about 26 people ever log in. Can we bring this down?", ["pricing_complaint"]],
    ["Finance flagged the token overage line again and wants to know why it keeps growing every month.", ["pricing_complaint"]],
    ["The per-seat price went up at renewal and nobody warned us beforehand.", ["pricing_complaint"]],
    ["We're paying for Code Review seats that nobody on the team uses. How do we drop them mid-term?", ["pricing_complaint"]],
  ],
  competitor: [
    ["Does your extraction handle handwritten forms? {c} told us theirs does.", ["competitor_mention"]],
    ["A colleague says {c} lets you bring your own model keys. Is that something you support?", ["competitor_mention"]],
  ],
  switching: [
    ["If these outages carry on we'll have no choice but to move this workload somewhere else.", ["switching_intent", "reliability"]],
    ["Please send instructions for a full export of our historical data and what happens to it if we close the account.", ["switching_intent"]],
  ],
  mixed: [
    ["Extraction failed again on our quarter-end batch, and we're still being charged for the full run. Not acceptable.", ["reliability", "pricing_complaint"]],
    ["We still can't connect Salesforce, and that integration was the main reason we bought the Extract add-on.", ["implementation_issue", "feature_gap"]],
    ["{c} offers an Excel export out of the box. Any chance you'll add one soon?", ["competitor_mention", "feature_gap"]],
  ],
  ambiguous: [
    ["Our procurement team is doing its annual review of all AI tools and asked for your current pricing sheet.", []],
    ["Is there a discount if we add another department? Budget is tight this year.", []],
    ["We noticed some slowness yesterday afternoon, but it seems fine now.", []],
    ["A colleague asked whether you offer an on-prem version, as some other vendors do.", []],
    ["Can you confirm how long you keep our data after a contract ends? Our records team asked.", []],
  ],
  neutral: [
    ["How do I add a new user to our workspace?", []],
    ["Can you reset the API key for our staging environment?", []],
    ["Where can I find last month's usage report?", []],
    ["Please update our billing contact; Sam has moved to another team.", []],
    ["Is there a way to change the default summary length?", []],
    ["Requesting a copy of your SOC 2 report for our annual vendor review.", []],
    ["Exports show dates in US format; could we switch to ISO dates?", []],
    ["One user reports a typo in the welcome email.", []],
    ["How do we move a project from one workspace to another?", []],
    ["Could you add two more admins to our account? Names are in the attached list.", []],
    ["What file types does extraction accept? We have some older .tif scans.", []],
  ],
  positive: [
    ["Thanks for the quick fix yesterday. Confirming everything's working again.", []],
    ["Not an issue, just a thank-you: the new summary layout has saved our reviewers a lot of time.", []],
  ],
};

// ---------------------------------------------------------------------------
// CSM activity notes (CSM's voice). [template, topics]
// ---------------------------------------------------------------------------

const NOTE: Record<Kind, readonly T[]> = {
  switching: [
    ["{r} said they've started scoping a replacement and want a migration plan in place before the renewal.", ["switching_intent"]],
    ["{r} asked how long a full export of their data would take and what happens to it after cancellation.", ["switching_intent"]],
    ["{r} said their CFO wants them to benchmark other vendors before renewal, and the decision is \"genuinely open\".", ["switching_intent"]],
    ["{r} hinted the team is consolidating tools next quarter and we may not make the cut.", ["switching_intent"]],
    ["They've budgeted the renewal at zero for now while they \"look at options\".", ["switching_intent"]],
    ["{r} was blunt: unless usage picks up, they don't see a case for renewing in {m}.", ["switching_intent"]],
  ],
  competitor: [
    ["{r} mentioned a demo from {c} last week and liked their extraction accuracy.", ["competitor_mention"]],
    ["A few of their users are trialling {c} for {f} alongside us.", ["competitor_mention"]],
    ["{r} forwarded a proposal from {c} and asked whether we can match it.", ["competitor_mention"]],
    ["{c} came up twice; they think its Slack integration is ahead of ours.", ["competitor_mention"]],
    ["{r} said a {c} rep has been reaching out to people across their team.", ["competitor_mention"]],
  ],
  pricing: [
    ["{r} pushed back hard on the overage charges and called the token pricing unpredictable.", ["pricing_complaint"]],
    ["Cost came up again: they feel we're expensive for how much the team actually uses it.", ["pricing_complaint"]],
    ["Finance wants a lower per-seat price before they'll approve the renewal.", ["pricing_complaint"]],
    ["{r} asked for spend broken down by team because \"the number keeps surprising people\".", ["pricing_complaint"]],
    ["{r} questioned why they pay for {n} seats when half the team barely logs in.", ["pricing_complaint"]],
  ],
  implementation: [
    ["Rollout to the second team is stuck on SSO; their IT hasn't prioritised it.", ["implementation_issue"]],
    ["{r} said adoption stalled because the Salesforce integration still isn't configured.", ["implementation_issue"]],
    ["Only the pilot group is using it three months in; the wider launch keeps getting pushed back.", ["implementation_issue"]],
    ["Data mapping for the extraction templates is taking far longer than planned; they're short on people to finish it.", ["implementation_issue"]],
  ],
  reliability: [
    ["{r} raised last week's outage: their support team lost half a day.", ["reliability"]],
    ["Complaints about slow responses at peak hours; they've started warning users to expect delays.", ["reliability"]],
    ["Their reviewers now double-check every summary by hand because it's \"been flaky lately\".", ["reliability"]],
    ["{r} listed three incidents this month and asked what we're doing about stability.", ["reliability"]],
  ],
  feature_gap: [
    ["Asked again for audit logs and per-workspace permissions; security won't widen use without them.", ["feature_gap"]],
    ["{r} wants multi-language summaries for the São Paulo office; told them it's not on the near-term roadmap.", ["feature_gap"]],
    ["They keep building little spreadsheet workarounds for things they expected the product to do.", ["feature_gap"]],
    ["{r} asked for an Excel export from extraction; the analysts are retyping results today.", ["feature_gap"]],
  ],
  mixed: [
    ["{r} said {c} quoted them about 30% less and already has the audit logs we're missing.", ["competitor_mention", "pricing_complaint", "feature_gap"]],
    ["After the recent outages, {r} said they're \"seriously looking\" at {c}.", ["reliability", "competitor_mention", "switching_intent"]],
    ["Integration still isn't live and the bill keeps going up; {r} questioned whether it's worth it.", ["implementation_issue", "pricing_complaint"]],
    ["{r} asked about moving the extraction workload to a cheaper vendor if prices don't come down.", ["pricing_complaint", "switching_intent"]],
    ["The missing Excel export is the main reason their analysts reach for {c} for ad hoc work.", ["feature_gap", "competitor_mention"]],
    ["Slow responses during month-end close, and {r} pointed out they pay a premium for exactly that period.", ["reliability", "pricing_complaint"]],
  ],
  ambiguous: [
    ["{r} mentioned they \"looked at a few tools\" before signing with us last year; no sign that's live now.", []],
    ["Budget season: {r} said every vendor is being reviewed, us included, but sounded relaxed about it.", []],
    ["Asked how our pricing compares with the market. Mostly curiosity, I think.", []],
    ["Some users said it \"felt slower\" this week; nothing showed up in our monitoring.", []],
    ["{r} said a sister company uses a different AI tool and they're \"comparing notes\".", []],
    ["New contact on the account ({r}) wants to understand what they're paying for before the next planning cycle.", []],
    ["They asked whether we'd ever offer on-prem; probably for a project next year.", []],
  ],
  neutral: [
    ["Monthly check-in with {r}. Walked through usage; nothing new raised.", []],
    ["Helped {r} add two new users and shared the admin guide.", []],
    ["High-level roadmap walk-through; they're interested in the next Extract release.", []],
    ["Confirmed the next QBR date and agenda.", []],
    ["Training session for the analyst team on {f}; about {n} people attended.", []],
    ["{r} asked for usage by department for an internal report; sent it over.", []],
    ["Agreed a shared success plan for the next quarter with {r}.", []],
    ["Introduced {r} to our support process and escalation contacts.", []],
  ],
  positive: [
    ["{r} shared that their support team cut handling time by about a third using {f}.", []],
    ["Very positive call; they'd like to present their results at our customer webinar.", []],
    ["{r} said code review is now part of every pull request on their main repo.", []],
    ["Usage up {n}% on last quarter; {r} wants to bring another department on board.", []],
    ["{r} called {f} \"the one tool the team actually asks for\".", []],
  ],
};

/** QBRs and exec meetings get their own routine notes, so a QBR never reads like a quick call. */
const NOTE_BY_TYPE: Partial<Record<string, Partial<Record<Kind, readonly T[]>>>> = {
  QBR: {
    neutral: [
      ["Reviewed usage by team and agreed goals for next quarter around Extract adoption.", []],
      ["Walked {r} through the quarter's numbers; no concerns raised, follow-ups are mostly admin.", []],
      ["Covered adoption, open tickets and the roadmap; {r} asked for the deck to share internally.", []],
      ["Agreed to revisit seat counts at the next review once the new hires start.", []],
    ],
    positive: [
      ["Usage up {n}% quarter over quarter; {r} wants to bring another department on board.", []],
      ["Reviewed ROI together; {r} credited {f} with cutting contract review time noticeably.", []],
    ],
  },
  "exec meeting": {
    neutral: [
      ["Strategic check-in with {r}; they confirmed priorities for next year and asked for a roadmap preview.", []],
      ["Introduced our VP Customer Success to {r}; agreed to meet again after their planning cycle.", []],
      ["{r} wanted a view of how other customers in their industry use {f}.", []],
    ],
    positive: [
      ["{r} said the rollout is one of the smoother vendor launches they've had this year.", []],
      ["{r} is keen to expand to the Code Review add-on next quarter and asked for a proposal.", []],
    ],
  },
};

const PREFIX: Record<string, readonly string[]> = {
  call: ["", "", "Call: "],
  meeting: ["", "Meeting: ", "On-site visit. "],
  QBR: ["QBR: ", "QBR with {r}. "],
  "exec meeting": ["Exec meeting: ", "Exec sync with {r}. "],
};

// ---------------------------------------------------------------------------
// Clear examples for two named accounts (owner's request)
// ---------------------------------------------------------------------------

const IONIC_RETAIL = "acc_0089";
const COPPERLEAF_MEDIA = "acc_0013";

/** Fixed texts for an account's most recent rows, newest first. */
const NAMED: Record<string, { activities: readonly T[]; tickets: readonly T[] }> = {
  [IONIC_RETAIL]: {
    activities: [
      [
        "Their Chief Data Officer joined and told us they're running a pilot with Veyra Labs on contract extraction and will decide well before the April renewal. She was candid that this spring's outages hurt our case.",
        ["switching_intent", "competitor_mention", "reliability"],
      ],
      ["Data team lead asked how to export all historical extraction results \"in case we need them somewhere else\".", ["switching_intent"]],
    ],
    tickets: [
      ["Extraction failed on our weekly batch again. Third failure this month; our team is losing confidence in it.", ["reliability"]],
      ["We're paying for Code Review seats that nobody here uses. Can we remove them before the next invoice?", ["pricing_complaint"]],
      ["Summaries timed out for most of the morning. We had to fall back to doing them by hand.", ["reliability"]],
    ],
  },
  [COPPERLEAF_MEDIA]: {
    activities: [
      ["The VP Operations said finance still thinks the per-seat price is too high for how many people actually use it.", ["pricing_complaint"]],
      [
        "The VP Operations asked for a side-by-side cost comparison with Brontide AI before they commit to another year.",
        ["competitor_mention", "pricing_complaint"],
      ],
    ],
    tickets: [["Our invoice went up again this month and we can't see why. Please explain the overage.", ["pricing_complaint"]]],
  },
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function slots(r: Rng, level: string): Slots {
  return {
    r: r.pick(ROLES[level] ?? ROLES.manager),
    c: r.pick(COMPETITORS),
    f: r.pick(FEATURES),
    n: String(r.int(6, 40)),
    m: r.pick(MONTHS),
  };
}

function intendedOf(kind: Kind, topics: readonly Topic[], text: string): Intended {
  return {
    topics: [...topics],
    ambiguous: kind === "ambiguous",
    competitor: topics.includes("competitor_mention") ? (COMPETITORS.find((c) => text.includes(c)) ?? null) : null,
  };
}

export function buildTexts(input: { tickets: TextTicket[]; activities: TextActivity[]; tiers: Map<string, TextTier>; asOf: string }): BuiltTexts {
  const { asOf } = input;
  const descriptions = new Map<string, string>();
  const notes = new Map<string, string>();
  const intended = new Map<string, Intended>();

  // Newest rows of the two named accounts get the fixed texts.
  const forced = new Map<string, T>();
  for (const [accountId, named] of Object.entries(NAMED)) {
    const acts = input.activities
      .filter((a) => a.account_id === accountId && a.type !== "email" && daysBefore(asOf, a.activity_date) >= 0)
      .sort((x, y) => y.activity_date.localeCompare(x.activity_date) || x.id.localeCompare(y.id));
    named.activities.forEach((t, i) => acts[i] && forced.set(`activity:${acts[i].id}`, t));
    const tix = input.tickets
      .filter((t) => t.account_id === accountId && daysBefore(asOf, t.opened_at) >= 0)
      .sort((x, y) => y.opened_at.localeCompare(x.opened_at) || x.id.localeCompare(y.id));
    named.tickets.forEach((t, i) => tix[i] && forced.set(`ticket:${tix[i].id}`, t));
  }

  for (const t of [...input.tickets].sort((x, y) => x.id.localeCompare(y.id))) {
    const key = `ticket:${t.id}`;
    const f = forced.get(key);
    if (f) {
      descriptions.set(t.id, f[0]);
      intended.set(key, intendedOf("mixed", f[1], f[0]));
      continue;
    }
    const r = makeRng(key);
    const kind = chooseKind(r, input.tiers.get(t.account_id) ?? "middle", daysBefore(asOf, t.opened_at), "ticket", t.severity);
    const [template, topics] = r.pick(TICKET[kind]);
    const text = fill(template, slots(r, "user"));
    descriptions.set(t.id, text);
    intended.set(key, intendedOf(kind, topics, text));
  }

  for (const a of [...input.activities].sort((x, y) => x.id.localeCompare(y.id))) {
    if (a.type === "email") continue;
    const key = `activity:${a.id}`;
    const f = forced.get(key);
    if (f) {
      notes.set(a.id, f[0]);
      intended.set(key, intendedOf("mixed", f[1], f[0]));
      continue;
    }
    const r = makeRng(key);
    const kind = chooseKind(r, input.tiers.get(a.account_id) ?? "middle", daysBefore(asOf, a.activity_date), "activity");
    const s = slots(r, a.attendee_level);
    const [template, topics] = r.pick(NOTE_BY_TYPE[a.type]?.[kind] ?? NOTE[kind]);
    const prefix = r.pick(PREFIX[a.type] ?? [""]);
    // A prefix that already names the person reads oddly before a note that starts with them too.
    const body = prefix.includes("{r}") && template.startsWith("{r}") ? template.replace("{r}", "they") : template;
    const text = fill(prefix + body, s).replace(/([.:]) ([a-z])/g, (_, p: string, ch: string) => `${p} ${ch.toUpperCase()}`);
    notes.set(a.id, text);
    intended.set(key, intendedOf(kind, topics, text));
  }

  return { descriptions, notes, intended };
}

/** Short code that changes whenever any built text changes. */
export function textsFingerprint(b: BuiltTexts): string {
  const lines = [
    ...[...b.descriptions].sort(([x], [y]) => x.localeCompare(y)).map(([id, t]) => `ticket|${id}|${t}`),
    ...[...b.notes].sort(([x], [y]) => x.localeCompare(y)).map(([id, t]) => `activity|${id}|${t}`),
  ];
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
}
