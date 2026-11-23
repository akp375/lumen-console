// Types and field labels for the ADR memo, shared by the server (adr-memo.ts) and the page.
// No server code here, so the browser can import it.
import type { GroundingResult } from "./grounding";

export const REC_FIELDS = ["finding", "why_it_matters", "action", "owner", "expected_impact"] as const;
export type RecField = (typeof REC_FIELDS)[number];

export const FIELD_LABELS: Record<RecField, string> = {
  finding: "Finding",
  why_it_matters: "Why it matters",
  action: "Action",
  owner: "Owner",
  expected_impact: "Expected impact",
};

export type AdrRecommendation = Record<RecField, string>;
export type AdrMemoContent = { headline: string; recommendations: AdrRecommendation[] };
export type AdrMemo = {
  id: string | null; // null when it couldn't be saved
  createdAt: string; // real time it was generated
  asOfDate: string;
  model: string;
  costUsd: number;
  content: AdrMemoContent;
  grounding: GroundingResult;
  /** Set when Claude returned fewer or more recommendations than asked for. */
  note: string | null;
};

/** The label the grounding check uses for each field, so the page can mark flagged numbers in place. */
export const memoFieldKey = (rec: number | null, field: RecField | "headline") =>
  rec === null || field === "headline" ? "Headline" : `Recommendation ${rec + 1} · ${FIELD_LABELS[field]}`;
