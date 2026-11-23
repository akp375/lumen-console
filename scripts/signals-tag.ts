/**
 * Tags ticket descriptions and CSM notes from the last 180 days (from AS_OF_DATE) with
 * Claude Haiku 5.5 (src/lib/topic-tagging.ts, through callClaude(), feature "topic_tagging")
 * and stores one row per text in text_signals.
 *
 *   npm run signals:tag -- --dry-run       count what's left and estimate the cost; calls nothing
 *   npm run signals:tag -- --limit 20      tag at most 20 texts (a pilot)
 *   npm run signals:tag                    tag everything that's left
 *   npm run signals:tag -- --retag-eval    re-tag the 20 eval texts (reconciliation/topic-eval-key.json), replacing their results
 *   npm run signals:tag -- --retag-all     re-tag every text in the window, replacing their results (after a prompt change)
 *
 * Never re-tags a text: anything already in text_signals is skipped, and the table allows one
 * row per text. Stops before today's Claude spend (all features, real calendar day UTC) would
 * pass STOP_AT_USD, leaving the rest of the $2 daily budget for the app. Run it again tomorrow
 * to continue.
 */
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { getTodaySpend, ClaudeLimitError, DAILY_BUDGET_USD } from "../src/lib/claude.ts";
import { readFileSync } from "node:fs";
import { tagText, TAGGING_PROMPT_VERSION, TAGGING_SYSTEM, type TagInput } from "../src/lib/topic-tagging.ts";
import { callCostUsd, HAIKU_MODEL } from "../src/lib/claude-cost.ts";

const STOP_AT_USD = 1.5; // leaves at least $0.50 of the daily budget for Workspace and briefings
const WINDOW_DAYS = 180;
const CONCURRENCY = 4;
const EST_OUTPUT_TOKENS = 250; // low effort: short thinking plus the JSON answer (the pilot measures the real figure)
const CHARS_PER_TOKEN = 3; // errs high

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitAt = args.indexOf("--limit");
const limit = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);
const retagEval = args.includes("--retag-eval");
const retagAll = args.includes("--retag-all");
if (limitAt !== -1 && !(limit > 0)) throw new Error("--limit needs a number, e.g. --limit 20");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;
async function readAll(table: string, columns: string, filter: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(db.from(table).select(columns)).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

type Text = TagInput & { id: string; sourceId: string; accountId: string; date: string };

/** A stable shuffle (by id) so a pilot is a spread of texts, not just the oldest ones. */
const order = (s: string) => {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return h >>> 0;
};

async function main() {
  const since = new Date(Date.parse(AS_OF_DATE) - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [tickets, acts, done] = await Promise.all([
    readAll("support_tickets", "id, account_id, opened_at, description", (q) => q.gte("opened_at", since).lte("opened_at", `${AS_OF_DATE}T23:59:59Z`).not("description", "is", null)),
    readAll("cs_activities", "id, account_id, activity_date, type, note", (q) => q.gte("activity_date", since).lte("activity_date", AS_OF_DATE).neq("type", "email").not("note", "is", null)),
    readAll("text_signals", "id, source, source_id", (q) => q),
  ]);
  const tagged = new Set(done.map((d) => `${d.source}:${d.source_id}`));
  const all: Text[] = [
    ...tickets.map((t) => ({ id: `sig_support_ticket_${t.id}`, source: "support_ticket" as const, sourceId: String(t.id), accountId: String(t.account_id), date: String(t.opened_at).slice(0, 10), kind: "ticket", text: String(t.description) })),
    ...acts.map((a) => ({ id: `sig_cs_activity_${a.id}`, source: "cs_activity" as const, sourceId: String(a.id), accountId: String(a.account_id), date: String(a.activity_date), kind: String(a.type), text: String(a.note) })),
  ];
  // Normally a text is never tagged twice. --retag-eval / --retag-all replace results on purpose, after a prompt change.
  const evalIds = retagEval ? new Set((JSON.parse(readFileSync("reconciliation/topic-eval-key.json", "utf8")) as { id: string }[]).map((x) => x.id)) : null;
  const todo = all
    .filter((t) => (evalIds ? evalIds.has(t.id) : retagAll ? true : !tagged.has(`${t.source}:${t.sourceId}`)))
    .sort((x, y) => order(x.id) - order(y.id) || x.id.localeCompare(y.id));
  if (evalIds && todo.length !== evalIds.size) throw new Error(`Found ${todo.length} of the ${evalIds.size} eval texts.`);
  const batch = todo.slice(0, limit);

  const systemTokens = TAGGING_SYSTEM.length / CHARS_PER_TOKEN + 150; // + schema and framing
  const estimate = (ts: Text[]) =>
    ts.reduce((s, t) => s + callCostUsd({ model: HAIKU_MODEL, inputTokens: systemTokens + t.text.length / CHARS_PER_TOKEN + 20, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: EST_OUTPUT_TOKENS }), 0);
  const today = await getTodaySpend();
  console.log(
    retagEval || retagAll
      ? `Re-tagging ${todo.length} texts with prompt v${TAGGING_PROMPT_VERSION} (their results are replaced).`
      : `Texts from the last ${WINDOW_DAYS} days (${since} to ${AS_OF_DATE}): ${all.length}; already tagged ${all.length - todo.length}; left ${todo.length}.`,
  );
  console.log(`Estimated cost: this run (${batch.length} texts) $${estimate(batch).toFixed(4)}; everything left $${estimate(todo).toFixed(4)}.`);
  console.log(`Claude spend today so far: $${today.costUsd.toFixed(4)} of the $${DAILY_BUDGET_USD} budget; this script stops at $${STOP_AT_USD.toFixed(2)}.`);
  if (dryRun || batch.length === 0) {
    console.log(dryRun ? "\nDry run: nothing was sent to Claude." : "\nNothing to tag.");
    return;
  }

  let spent = 0, ok = 0, failed = 0, rejectedQuotes = 0, inTok = 0, outTok = 0, stopped = "";
  const perCall = estimate(batch) / batch.length;
  const queue = [...batch];
  const worker = async () => {
    for (let t = queue.shift(); t && !stopped; t = queue.shift()) {
      if (today.costUsd + spent + perCall * CONCURRENCY > STOP_AT_USD) {
        stopped = `today's spend is close to $${STOP_AT_USD.toFixed(2)}`;
        return;
      }
      try {
        const r = await tagText(t);
        spent += r.costUsd;
        inTok += r.inputTokens;
        outTok += r.outputTokens;
        if (r.quoteRejected) rejectedQuotes++;
        const { error } = await db.from("text_signals").upsert(
          {
            id: t.id,
            source: t.source,
            source_id: t.sourceId,
            account_id: t.accountId,
            date: t.date,
            topics: r.topics,
            competitor_name: r.competitorName,
            sentiment: r.sentiment,
            quote: r.quote,
            model: r.model,
            tagged_at: new Date().toISOString(),
          },
          { onConflict: "source,source_id", ignoreDuplicates: !(retagEval || retagAll) },
        );
        if (error) throw new Error(`Saving ${t.id} failed: ${error.message}`);
        ok++;
        if (ok % 100 === 0) console.log(`  ${ok} tagged, $${spent.toFixed(4)} so far`);
      } catch (e) {
        if (e instanceof ClaudeLimitError && e.kind === "daily_budget") {
          stopped = "the daily budget is used up";
          return;
        }
        failed++;
        console.error(`  ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
        if (failed >= 5) stopped = "5 calls failed";
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nTagged ${ok} of ${batch.length}${failed ? `, ${failed} failed` : ""}${stopped ? `; stopped because ${stopped}` : ""}.`);
  if (ok) {
    console.log(`Real cost: $${spent.toFixed(5)} (average $${(spent / ok).toFixed(6)} per text; ${Math.round(inTok / ok)} input and ${Math.round(outTok / ok)} output tokens per text).`);
    console.log(`At that rate, the ${todo.length - ok} texts left would cost about $${((spent / ok) * (todo.length - ok)).toFixed(4)}.`);
    console.log(`Quotes not copied word for word (stored empty): ${rejectedQuotes}.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
