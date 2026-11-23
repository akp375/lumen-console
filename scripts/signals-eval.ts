/**
 * Picks 20 tagged texts for the owner to mark right or wrong. Read-only on Supabase.
 *
 *   npm run signals:eval      write reconciliation/topic-eval.md (for marking) and topic-eval-key.json
 *
 * The sample is fixed (same seed, same 20 every run) and stratified so it says something about
 * the risky topics: 3 ambiguous texts (15%), 9 written with a risky topic, 8 written without one.
 * What each text was written to say comes from scripts/text-lib.ts and goes in the key file only,
 * so it doesn't sway the marking.
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { TOPIC_LABEL, type SignalTopic } from "../src/lib/signal-topics.ts";
import { loadTextInputs } from "./text-backfill.ts";
import { buildTexts } from "./text-lib.ts";

const PLAN = { ambiguous: 3, risky: 9, plain: 8 };
const SEED = "lumen-ai-topic-eval-v1";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const order = (s: string) => {
  let h = 0x811c9dc5;
  for (const c of `${SEED}:${s}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) >>> 0;
};

async function main() {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("text_signals").select("*").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const input = await loadTextInputs();
  const built = buildTexts({ ...input, asOf: AS_OF_DATE });
  const text = (r: Record<string, unknown>) =>
    r.source === "support_ticket" ? built.descriptions.get(String(r.source_id)) : built.notes.get(String(r.source_id));
  const intendedOf = (r: Record<string, unknown>) => built.intended.get(`${r.source === "support_ticket" ? "ticket" : "activity"}:${r.source_id}`)!;

  const shuffled = [...rows].sort((x, y) => order(String(x.id)) - order(String(y.id)));
  const pick = (want: number, ok: (r: Record<string, unknown>) => boolean) => shuffled.filter(ok).slice(0, want);
  const sample = [
    ...pick(PLAN.ambiguous, (r) => intendedOf(r).ambiguous),
    ...pick(PLAN.risky, (r) => !intendedOf(r).ambiguous && intendedOf(r).topics.length > 0),
    ...pick(PLAN.plain, (r) => !intendedOf(r).ambiguous && intendedOf(r).topics.length === 0),
  ].sort((x, y) => order(`final:${x.id}`) - order(`final:${y.id}`)); // mixed order, so the groups aren't obvious

  const label = (ts: unknown) => ((ts as SignalTopic[]) ?? []).map((t) => TOPIC_LABEL[t]).join(", ") || "none";
  const lines = [
    `# Topic tagging eval (${sample.length} texts, picked ${new Date().toISOString().slice(0, 10)})`,
    "",
    `From ${rows.length} tagged texts. Mark each one Right or Wrong: right means the topics, competitor and sentiment are all reasonable for the text.`,
    "",
  ];
  sample.forEach((r, i) => {
    lines.push(
      `## ${i + 1}. ${r.source === "support_ticket" ? "Support ticket" : "CSM note"}, ${r.date}`,
      "",
      `> ${text(r)}`,
      "",
      `- **Topics:** ${label(r.topics)}`,
      `- **Competitor:** ${r.competitor_name ?? "none"}`,
      `- **Sentiment:** ${r.sentiment}`,
      `- **Quote:** ${r.quote ? `"${r.quote}"` : "(none)"}`,
      `- **Mark:** Right / Wrong`,
      "",
    );
  });
  writeFileSync("reconciliation/topic-eval.md", lines.join("\n"));
  writeFileSync(
    "reconciliation/topic-eval-key.json",
    JSON.stringify(
      sample.map((r, i) => ({ n: i + 1, id: r.id, written_as: intendedOf(r).ambiguous ? "ambiguous" : intendedOf(r).topics.length ? "risky" : "no topic", intended_topics: intendedOf(r).topics, tagged_topics: r.topics })),
      null,
      2,
    ) + "\n",
  );
  console.log(`Wrote reconciliation/topic-eval.md (${sample.length} texts) and topic-eval-key.json.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
