"use server";

import { getDealRisk, type DealRiskResult } from "@/lib/metrics";
import { callClaude, ClaudeLimitError } from "@/lib/claude";

export type AiNote = { reason: string; nextAction: string };

export async function flagDealRisk(): Promise<{ data?: DealRiskResult; error?: string }> {
  try {
    return { data: await getDealRisk() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    deals: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" }, next_step: { type: "string" } },
        required: ["id", "reason", "next_step"],
        additionalProperties: false,
      },
    },
  },
  required: ["deals"],
  additionalProperties: false,
};

const SYSTEM = `You are a RevOps analyst for Lumen AI, a B2B AI software company.
You get a list of open sales deals flagged as at risk, with the facts behind each flag.
For every deal, write:
- reason: one plain-English line on why this deal is at risk, citing the specific facts given.
- next_step: one concrete next step for the deal owner, in under 20 words.
Use only the facts provided. Do not invent contacts, events or numbers. Return one entry per deal id.`;

/** Recomputes the flagged deals on the server and asks Claude for a reason and next step per deal. */
export async function explainDealRisk(): Promise<{ notes?: Record<string, AiNote>; error?: string; notice?: string }> {
  try {
    const { rows } = await getDealRisk();
    if (rows.length === 0) return { notes: {} };
    const facts = rows.map((r) => ({
      id: r.opportunityId,
      account: r.accountName,
      deal_type: r.type,
      stage: r.stage,
      amount_usd: r.amount,
      close_date: r.closeDate,
      days_in_stage: r.daysInStage,
      max_days_for_stage: r.maxDaysInStage,
      days_since_last_activity: r.daysSinceActivity,
      executive_sponsor: r.executiveSponsor,
      current_next_step: r.nextStep,
      signals: r.signals,
    }));
    const result = await callClaude({
      feature: "deal_risk",
      system: SYSTEM,
      prompt: `Flagged deals (JSON):\n${JSON.stringify(facts, null, 2)}`,
      jsonSchema: SCHEMA,
    });
    const parsed = result.json as { deals: { id: string; reason: string; next_step: string }[] };
    return { notes: Object.fromEntries(parsed.deals.map((d) => [d.id, { reason: d.reason, nextAction: d.next_step }])) };
  } catch (e) {
    if (e instanceof ClaudeLimitError) return { notice: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
