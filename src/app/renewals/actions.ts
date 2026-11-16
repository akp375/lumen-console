"use server";

import { getRenewalRisk, type RenewalRiskResult } from "@/lib/metrics";
import { callClaude } from "@/lib/claude";

export type AiNote = { reason: string; nextAction: string };

export async function flagRenewalRisk(): Promise<{ data?: RenewalRiskResult; error?: string }> {
  try {
    return { data: await getRenewalRisk() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string" }, next_action: { type: "string" } },
        required: ["id", "reason", "next_action"],
        additionalProperties: false,
      },
    },
  },
  required: ["accounts"],
  additionalProperties: false,
};

const SYSTEM = `You are a RevOps analyst for Lumen AI, a B2B AI software company.
You get a list of customer accounts flagged as renewal risks, with the facts behind each flag.
For every account, write:
- reason: one plain-English sentence on why this renewal is at risk, citing the specific numbers given.
- next_action: one concrete next step for the account owner, in under 20 words.
Use only the facts provided. Do not invent contacts, events or numbers. Return one entry per account id.`;

/** Recomputes the flagged list on the server and asks Claude for a reason and next action per account. */
export async function explainRenewalRisk(): Promise<{ notes?: Record<string, AiNote>; error?: string }> {
  try {
    const { rows } = await getRenewalRisk();
    if (rows.length === 0) return { notes: {} };
    const facts = rows.map((r) => ({
      id: r.accountId,
      name: r.name,
      segment: r.segment,
      arr_usd: r.arr,
      days_to_renewal: r.daysToRenewal,
      latest_nps: r.latestNps,
      nps_change: r.npsChange,
      usage_change_last_30d_vs_prior_30d: r.usageChange === null ? null : `${(r.usageChange * 100).toFixed(0)}%`,
      gross_margin: r.grossMargin === null ? null : `${(r.grossMargin * 100).toFixed(0)}%`,
      signals: r.signals,
    }));
    const result = await callClaude({
      feature: "renewal_risk",
      system: SYSTEM,
      prompt: `Flagged accounts (JSON):\n${JSON.stringify(facts, null, 2)}`,
      jsonSchema: SCHEMA,
    });
    const parsed = result.json as { accounts: { id: string; reason: string; next_action: string }[] };
    return { notes: Object.fromEntries(parsed.accounts.map((a) => [a.id, { reason: a.reason, nextAction: a.next_action }])) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
