/**
 * Fills the free text for Cockpit (built for Lumen AI) from the data already in
 * Supabase, without a reseed: a description on every support ticket and a note on
 * every CSM call, meeting, QBR and exec meeting (emails get none).
 *
 *   npm run text:backfill -- --dry-run   build everything and print a summary and samples; writes nothing
 *   npm run text:backfill                write it
 *
 * Writes only support_tickets.description and cs_activities.note. No other column.
 * Run `npm run text:check -- --save-before` first and `npm run text:check` after.
 * Needs supabase/migrations/20261124000000_add_text_and_signals.sql.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import type { AccountRow } from "../src/lib/metrics.ts";
import { buildHealthInputs } from "./health-inputs-lib.ts";
import { buildTexts, textsFingerprint, TOPICS, type BuiltTexts, type TextActivity, type TextTicket, type TextTier } from "./text-lib.ts";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local. Nothing was written.");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

type Row = Record<string, unknown>;
async function readAll(table: string, columns: string, orderBy: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns);
    for (const c of orderBy) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}. Nothing was written.`);
    out.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

/** Everything the text builder needs, read from the live tables. The tiers come from the same code as the health inputs. */
export async function loadTextInputs(): Promise<{ tickets: TextTicket[]; activities: TextActivity[]; tiers: Map<string, TextTier>; accounts: AccountRow[] }> {
  const [accRows, oppRows, ticketRows, usageRows, npsRows, actRows] = await Promise.all([
    readAll("accounts", "id, name, status, segment, mrr_usd, included_tokens_monthly, start_date, renewal_date, churn_date, owner", ["id"]),
    readAll("opportunities", "id, account_id, type, source", ["id"]),
    readAll("support_tickets", "id, account_id, opened_at, closed_at, severity, status", ["id"]),
    readAll("usage_daily", "account_id, date, model, input_tokens, output_tokens", ["account_id", "date", "feature", "model"]),
    readAll("nps_responses", "account_id, responded_at, score", ["id"]),
    readAll("cs_activities", "id, account_id, activity_date, type, attendee_level", ["id"]),
  ]);
  const accounts: AccountRow[] = accRows.map((a) => ({
    id: String(a.id),
    name: String(a.name),
    status: a.status as AccountRow["status"],
    segment: String(a.segment),
    mrr_usd: Number(a.mrr_usd),
    included_tokens_monthly: Number(a.included_tokens_monthly),
    start_date: (a.start_date as string | null) ?? null,
    renewal_date: (a.renewal_date as string | null) ?? null,
    churn_date: (a.churn_date as string | null) ?? null,
    owner: String(a.owner),
  }));
  const tickets = ticketRows.map((t) => ({
    id: String(t.id),
    account_id: String(t.account_id),
    opened_at: String(t.opened_at),
    closed_at: (t.closed_at as string | null) ?? null,
    severity: String(t.severity),
    status: String(t.status),
  }));
  const h = buildHealthInputs({
    accounts,
    opportunities: oppRows.map((o) => ({ id: String(o.id), account_id: String(o.account_id), type: String(o.type), source: String(o.source) })),
    tickets,
    usage: usageRows.map((u) => ({
      account_id: String(u.account_id),
      date: String(u.date).slice(0, 10),
      model: String(u.model),
      input_tokens: Number(u.input_tokens),
      output_tokens: Number(u.output_tokens),
    })),
    nps: npsRows.map((n) => ({ account_id: String(n.account_id), responded_at: String(n.responded_at), score: Number(n.score) })),
    asOf: AS_OF_DATE,
  });
  const activities = actRows.map((a) => ({
    id: String(a.id),
    account_id: String(a.account_id),
    activity_date: String(a.activity_date),
    type: String(a.type),
    attendee_level: String(a.attendee_level),
  }));
  return { tickets, activities, tiers: h.tiers, accounts };
}

/** Mix of what the texts were written to say, by tier, for the last 180 days. Seeding check only. */
export function textMix(b: BuiltTexts, input: { tickets: TextTicket[]; activities: TextActivity[]; tiers: Map<string, TextTier> }, asOf: string) {
  const since = new Date(Date.parse(asOf) - 180 * 86_400_000).toISOString().slice(0, 10);
  const recent = [
    ...input.tickets.filter((t) => t.opened_at.slice(0, 10) >= since && t.opened_at.slice(0, 10) <= asOf).map((t) => ({ key: `ticket:${t.id}`, account: t.account_id })),
    ...input.activities
      .filter((a) => a.type !== "email" && a.activity_date >= since && a.activity_date <= asOf)
      .map((a) => ({ key: `activity:${a.id}`, account: a.account_id })),
  ];
  const tiers = ["healthy", "middle", "declining-quiet", "declining-burst"] as const;
  return {
    recentCount: recent.length,
    byTier: tiers.map((tier) => {
      const rows = recent.filter((r) => input.tiers.get(r.account) === tier).map((r) => b.intended.get(r.key)!);
      const risky = rows.filter((x) => x.topics.length > 0).length;
      const perTopic = Object.fromEntries(TOPICS.map((t) => [t, rows.filter((x) => x.topics.includes(t)).length]));
      return { tier, texts: rows.length, risky, riskyShare: rows.length ? risky / rows.length : 0, ambiguous: rows.filter((x) => x.ambiguous).length, mixed: rows.filter((x) => x.topics.length > 1).length, perTopic };
    }),
  };
}

async function main() {
  console.log(`Text backfill (as of ${AS_OF_DATE})${dryRun ? ": DRY RUN, nothing is written" : ""}\n`);
  if (!dryRun && !existsSync("reconciliation/text-before.json")) {
    throw new Error("No before snapshot. Run `npm run text:check -- --save-before` first. Nothing was written.");
  }
  const input = await loadTextInputs();
  const b = buildTexts({ ...input, asOf: AS_OF_DATE });

  console.log(`Ticket descriptions: ${b.descriptions.size} of ${input.tickets.length} tickets`);
  console.log(`Activity notes: ${b.notes.size} (calls, meetings, QBRs, exec meetings); emails left empty: ${input.activities.filter((a) => a.type === "email").length}`);
  const mix = textMix(b, input, AS_OF_DATE);
  console.log(`\nLast 180 days: ${mix.recentCount} texts. What they were written to say, by account tier:`);
  for (const t of mix.byTier) {
    console.log(
      `  ${t.tier.padEnd(16)} ${String(t.texts).padStart(5)} texts, risky ${String(Math.round(t.riskyShare * 100)).padStart(2)}% (${t.risky}), ` +
        `two+ topics ${t.mixed}, ambiguous ${t.ambiguous} | ${Object.entries(t.perTopic).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    );
  }
  const name = new Map(input.accounts.map((a) => [a.id, a.name]));
  for (const id of ["acc_0089", "acc_0013"]) {
    console.log(`\n${name.get(id)} (newest first):`);
    const rows = [
      ...input.activities.filter((a) => a.account_id === id && b.notes.has(a.id)).map((a) => ({ d: a.activity_date, s: `note ${a.type}`, t: b.notes.get(a.id)! })),
      ...input.tickets.filter((t) => t.account_id === id).map((t) => ({ d: t.opened_at.slice(0, 10), s: "ticket", t: b.descriptions.get(t.id)! })),
    ]
      .filter((r) => r.d <= AS_OF_DATE)
      .sort((x, y) => y.d.localeCompare(x.d))
      .slice(0, 8);
    for (const r of rows) console.log(`  ${r.d}  ${r.s.padEnd(18)} ${r.t}`);
  }
  console.log("\nSample notes and descriptions (every 150th):");
  [...b.notes.values(), ...b.descriptions.values()].filter((_, i) => i % 150 === 0).forEach((t) => console.log(`  - ${t}`));
  console.log(`\nText fingerprint: ${textsFingerprint(b)} (npm run seed -- --dry-run prints the same code for the same data)`);

  if (dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  console.log("\nWriting...");
  const jobs: (() => Promise<void>)[] = [
    ...[...b.descriptions].map(([id, text]) => async () => {
      const { error } = await db.from("support_tickets").update({ description: text }).eq("id", id);
      if (error) throw new Error(`Updating ticket ${id} failed: ${error.message}`);
    }),
    ...[...b.notes].map(([id, text]) => async () => {
      const { error } = await db.from("cs_activities").update({ note: text }).eq("id", id);
      if (error) throw new Error(`Updating activity ${id} failed: ${error.message}`);
    }),
  ];
  let done = 0;
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      await job();
      if (++done % 500 === 0) console.log(`  ${done} written`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`  support_tickets.description: ${b.descriptions.size}; cs_activities.note: ${b.notes.size}`);
  console.log("Done. Now run: npm run text:check");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
