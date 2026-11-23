// The topics the tagger can find in ticket descriptions and CSM notes, with their display labels.
// Shared by the tagger (topic-tagging.ts), metrics.ts and the account page. No other imports.

export const SIGNAL_TOPICS = ["competitor_mention", "switching_intent", "pricing_complaint", "implementation_issue", "reliability", "feature_gap"] as const;
export type SignalTopic = (typeof SIGNAL_TOPICS)[number];

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const TOPIC_LABEL: Record<SignalTopic, string> = {
  competitor_mention: "Competitor mention",
  switching_intent: "Switching intent",
  pricing_complaint: "Pricing complaint",
  implementation_issue: "Implementation issue",
  reliability: "Reliability",
  feature_gap: "Feature gap",
};
