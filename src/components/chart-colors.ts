// Chart colours. Each colour follows a thing (a model, a stage, a measure),
// never its rank, so the same thing is the same colour everywhere.
// Red and amber are kept for the Underwater and Overage status flags only.

export const MEASURE_COLORS = {
  revenue: "#2563eb", // blue
  tokenCost: "#ea580c", // orange
  pipelineValue: "#93c5fd", // light blue
  pipelineWeighted: "#1d4ed8", // dark blue (same hue, darker = the stronger number)
};

export const MODEL_COLORS: Record<string, string> = {
  "claude-opus-5-5": "#7c3aed", // violet
  "claude-sonnet-5-5": "#0d9488", // teal
  "claude-haiku-5-5": "#0ea5e9", // sky
};
export const OTHER_COLOR = "#64748b"; // slate

export const LIFECYCLE_COLORS: Record<string, string> = {
  Onboarding: "#0ea5e9", // sky
  "First year": "#7c3aed", // violet
  Established: "#0d9488", // teal
  "Renewal due": "#db2777", // pink
};
