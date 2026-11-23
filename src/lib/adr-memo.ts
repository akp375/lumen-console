// The AI memo for the ADR manager. Server-side only.
// Every number comes from metrics.ts (getAdrMemoInput); Claude only writes the recommendations.
// Each memo is saved to briefings (kind "adr_memo") with the exact summary sent, its cost and the
// grounding check, so any number in it can be traced back.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "./as-of-date";
import { callClaude } from "./claude";
import { shortDate } from "./format";
import { REC_FIELDS, memoFieldKey, type AdrMemo, type AdrMemoContent } from "./adr-memo-shared";
import { checkGrounding, type GroundingResult } from "./grounding";
import { ADR_RULES, getAdrMemoInput } from "./metrics";

export const ADR_MEMO_SYSTEM = `You are a RevOps analyst writing a short memo for the ADR manager at Lumen AI, a B2B AI software
company. The ADR manager leads the ADR (account development) team; their name is in the summary.
You get one JSON summary of the team's work, computed by Cockpit as of the date it states: lead
hygiene, speed to lead, the funnel by lead source, sequence performance and results per ADR.

Write:
- headline: one sentence with the single most important takeaway, using numbers from the summary.
- recommendations: 3 to 5, most important first. Choose the findings that would most change
  meetings booked or pipeline created, not the largest number of findings. Each has:
  - finding: what the data shows, with the specific numbers from the summary.
  - why_it_matters: the business consequence, in one or two sentences.
  - action: one concrete thing to do in the next two weeks.
  - owner: one person or role from the summary: an ADR or AE by name, the ADR manager, the sales
    manager, or RevOps.
  - expected_impact: which metric in the summary should move, and in which direction.

Rules:
- Use only numbers that appear in the summary, written as they appear there: percentages as given
  (for example 64.0%), dollars as whole dollars with commas (for example $34,800), counts as plain
  numbers. Do not calculate new numbers, totals, differences or projections, and do not round or
  abbreviate (no "$35K", no "about 2x"). If an impact can't be stated with a number from the
  summary, describe it in words.
- Write dates only as they appear in the summary.
- Recommend; don't restate the data. Every finding must lead to an action.
- Name only people in the summary. Don't invent contacts, events, tools or causes. If a cause is a
  reasonable guess rather than shown by the data, say "likely".
- Leads move through New, Engaged, MQL, Sales accepted, Sales qualified and Meeting booked, then
  end as Converted, Disqualified or Nurture; the summary explains each. A lead reaches Meeting booked
  only when a Qualifying deal is created. A sequence's "calls booked" include ADR qualifying calls,
  so don't treat them as meetings booked.
- Plain English. Use only the stage names and terms the summary uses (for example MQL, Sales
  qualified, Meeting booked, Qualifying, SLA). No markdown.`;

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: Object.fromEntries(REC_FIELDS.map((f) => [f, { type: "string" }])),
        required: [...REC_FIELDS],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "recommendations"],
  additionalProperties: false,
};

let supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side)");
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabase;
}

const MIGRATION = "supabase/migrations/20261126000000_adr_manager_and_memos.sql";
const isMissingColumn = (e: { code?: string; message: string }) => e.code === "42703" || e.code === "PGRST204" || /column .* does not exist|Could not find/i.test(e.message);

/** Asks Claude for the memo, checks its numbers against the summary, and saves it. */
export async function generateAdrMemo(): Promise<{ memo: AdrMemo; saveError: string | null }> {
  const input = await getAdrMemoInput(shortDate);
  const result = await callClaude({
    feature: "adr_memo",
    system: ADR_MEMO_SYSTEM,
    prompt: `ADR team summary (JSON):\n${JSON.stringify(input)}`,
    jsonSchema: SCHEMA,
    maxTokens: ADR_RULES.memoMaxTokens,
    timeoutMs: 90_000,
  });
  const parsed = result.json as AdrMemoContent;
  const { min, max } = ADR_RULES.memoRecommendations;
  const content: AdrMemoContent = { headline: parsed.headline, recommendations: parsed.recommendations.slice(0, max) };
  const note =
    parsed.recommendations.length < min
      ? `Claude returned ${parsed.recommendations.length} recommendations (asked for ${min} to ${max}).`
      : parsed.recommendations.length > max
        ? `Claude returned ${parsed.recommendations.length} recommendations; the first ${max} are kept.`
        : null;

  const fields: Record<string, string> = { [memoFieldKey(null, "headline")]: content.headline };
  content.recommendations.forEach((r, i) => REC_FIELDS.forEach((f) => (fields[memoFieldKey(i, f)] = r[f])));
  const grounding = checkGrounding(fields, input);

  const memo: AdrMemo = { id: null, createdAt: new Date().toISOString(), asOfDate: AS_OF_DATE, model: result.model, costUsd: result.costUsd, content, grounding, note };
  const { data, error } = await db()
    .from("briefings")
    .insert({ kind: "adr_memo", content: JSON.stringify({ ...content, note }), as_of_date: AS_OF_DATE, model: result.model, cost_usd: result.costUsd, input, grounding, accounts_flagged: [] })
    .select("id, created_at")
    .single();
  if (error) {
    const saveError = isMissingColumn(error) ? `The memo wasn't saved: run ${MIGRATION} in Supabase first.` : `The memo wasn't saved: ${error.message}`;
    return { memo, saveError };
  }
  return { memo: { ...memo, id: String(data.id), createdAt: String(data.created_at) }, saveError: null };
}

/** The most recent saved memo, or null. `missingMigration` when briefings doesn't have the memo columns yet. */
export async function getLatestAdrMemo(): Promise<{ memo: AdrMemo | null; missingMigration: boolean }> {
  const { data, error } = await db()
    .from("briefings")
    .select("id, created_at, content, as_of_date, model, cost_usd, grounding")
    .eq("kind", "adr_memo")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingColumn(error)) return { memo: null, missingMigration: true };
    throw new Error(`Reading briefings failed: ${error.message}`);
  }
  const row = data?.[0];
  if (!row) return { memo: null, missingMigration: false };
  const stored = JSON.parse(String(row.content)) as AdrMemoContent & { note?: string | null };
  return {
    memo: {
      id: String(row.id),
      createdAt: String(row.created_at),
      asOfDate: String(row.as_of_date),
      model: String(row.model),
      costUsd: Number(row.cost_usd),
      content: { headline: stored.headline, recommendations: stored.recommendations },
      grounding: row.grounding as GroundingResult,
      note: stored.note ?? null,
    },
    missingMigration: false,
  };
}
