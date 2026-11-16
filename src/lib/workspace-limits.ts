// Workspace guardrails, shared by the chat page and the /api/agent route.
export const HISTORY_MESSAGES = 6; // earlier messages sent with each question (3 questions + 3 answers)
export const MAX_QUESTION_CHARS = 1000;
export const QUESTIONS_PER_HOUR = 20; // per browser
export const TIMEOUT_MS = 30_000;
