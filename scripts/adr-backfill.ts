/**
 * Fills the ADR (account development) data for Cockpit (built for Lumen AI) from the data already in
 * Supabase, without a reseed: territories, ADR-AE pairings, account tags, leads, sequences,
 * enrollments and new Stage 0.1 deals.
 *
 *   npm run adr:backfill -- --dry-run   build everything and print a summary; writes nothing
 *   npm run adr:backfill                write it
 *
 * Writes only: team.territory; adr_ae_pairings; accounts.icp_tier, target_account, territory;
 * leads; sequences; sequence_enrollments; and new opportunities with stage "Stage 0.1"
 * (ids opp_s01_...). No existing opportunity or other column changes.
 *
 * Run `npm run adr:check -- --save-before` first and `npm run adr:check` after.
 * Needs supabase/migrations/20261125000000_add_adr_data.sql.
 */
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { AS_OF_DATE } from "../src/lib/as-of-date.ts";
import { adrFingerprint, buildAdrData, SLA_HOURS, STALE_DAYS, type AdrAccount, type AdrData, type AdrDeal, type AdrTeamMember } from "./adr-lib.ts";

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

/** The inputs from the live tables. Existing deals only (Stage 0.1 deals this script made are left out, so a re-run builds the same thing). */
export async function loadAdrInputs(): Promise<{ accounts: AdrAccount[]; deals: AdrDeal[]; team: AdrTeamMember[] }> {
  const [acc, opp, team] = await Promise.all([
    readAll("accounts", "id, name, status, segment, owner", ["id"]),
    readAll("opportunities", "id, account_id, type, source, stage, created_date, adr_id", ["id"]),
    readAll("team", "id, name, role", ["id"]),
  ]);
  return {
    accounts: acc.map((a) => ({ id: String(a.id), name: String(a.name), status: a.status as AdrAccount["status"], segment: String(a.segment), owner: String(a.owner) })),
    deals: opp
      .filter((o) => o.stage !== "Stage 0.1")
      .map((o) => ({ id: String(o.id), account_id: String(o.account_id), type: String(o.type), source: String(o.source), stage: String(o.stage), created_date: String(o.created_date), adr_id: (o.adr_id as string | null) ?? null })),
    team: team.map((t) => ({ id: String(t.id), name: String(t.name), role: String(t.role) })),
  };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");

/** Plain counts of what was built, for the dry run and the reconciliation check. Seeding check only, not app metrics. */
export function adrSummary(d: AdrData, team: AdrTeamMember[]): string[] {
  const name = new Map(team.map((t) => [t.id, t.name]));
  const out: string[] = [];
  const L = d.leads;
  out.push(`Leads: ${L.length}; unassigned ${L.filter((l) => !l.assigned_adr_id).length} (${pct(L.filter((l) => !l.assigned_adr_id).length, L.length)})`);
  const by = <T>(xs: T[], f: (x: T) => string) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map<string, number>());
  out.push(`  Stages: ${[...by(L, (l) => l.lifecycle_stage)].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  out.push("  By source (lead -> MQL -> SQL):");
  for (const src of ["inbound demo request", "partner", "event", "webinar", "outbound", "content download"]) {
    const ls = L.filter((l) => l.lead_source === src);
    const mql = ls.filter((l) => l.mql_at).length;
    const sql = ls.filter((l) => l.sql_at).length;
    out.push(`    ${src.padEnd(21)} ${String(ls.length).padStart(4)} leads, MQL ${String(mql).padStart(3)}, SQL ${String(sql).padStart(3)}  (lead->SQL ${pct(sql, ls.length)}, MQL->SQL ${pct(sql, mql)})`);
  }
  const mqls = L.filter((l) => l.mql_at);
  const late = mqls.filter((l) => l.first_touch_at && Date.parse(l.first_touch_at) - Date.parse(l.mql_at!) > SLA_HOURS * 3_600_000).length;
  const never = mqls.filter((l) => !l.first_touch_at).length;
  out.push(`  MQL first touch vs the ${SLA_HOURS}h SLA: ${mqls.length} MQLs, late ${late} (${pct(late, mqls.length)}), never ${never} (${pct(never, mqls.length)})`);
  for (const adr of [...new Set(mqls.map((l) => l.assigned_adr_id))].sort()) {
    const m = mqls.filter((l) => l.assigned_adr_id === adr);
    const onTime = m.filter((l) => l.first_touch_at && Date.parse(l.first_touch_at) - Date.parse(l.mql_at!) <= SLA_HOURS * 3_600_000).length;
    out.push(`    ${(adr ? name.get(adr)! : "(unassigned)").padEnd(16)} ${String(m.length).padStart(3)} MQLs, on time ${pct(onTime, m.length)}, SQL ${pct(m.filter((l) => l.sql_at).length, m.length)}`);
  }
  out.push(`  Linked to existing deals: ${d.planted.linkedExistingDeals.length}; SQLs with no deal: ${L.filter((l) => l.lifecycle_stage === "SQL" && !l.opportunity_id).length}`);
  out.push(`Sequences: ${d.sequences.length}; enrollments: ${d.enrollments.length}`);
  for (const s of d.sequences) {
    const e = d.enrollments.filter((x) => x.sequence_id === s.id);
    const sent = e.reduce((t, x) => t + x.emails_sent, 0);
    out.push(
      `    ${s.name.padEnd(40)} ${String(e.length).padStart(4)} enrolled, owner ${name.get(s.owner_id)}, open ${pct(e.reduce((t, x) => t + x.opens, 0), sent)} of emails, ` +
        `reply ${pct(e.filter((x) => x.replies > 0).length, e.length)}, bounce ${pct(e.filter((x) => x.bounces > 0).length, e.length)}, meetings ${pct(e.filter((x) => x.meeting_booked).length, e.length)}`,
    );
  }
  for (const adr of [...new Set(d.enrollments.map((e) => e.adr_id))].sort()) {
    const e = d.enrollments.filter((x) => x.adr_id === adr);
    out.push(`    ${(adr ? name.get(adr)! : "(unassigned)").padEnd(16)} reply ${pct(e.filter((x) => x.replies > 0).length, e.length)}, meetings ${pct(e.filter((x) => x.meeting_booked).length, e.length)} of ${e.length} enrollments`);
  }
  out.push(`Stage 0.1 deals: ${d.stage01Deals.length}; stale (no update in ${STALE_DAYS}+ days) ${d.planted.staleDeals.length}; ADR not paired with the AE ${d.planted.mismatchedDeals.length}`);
  const tags = [...d.accountTags.values()];
  out.push(
    `Account tags: tier 1 ${tags.filter((t) => t.icp_tier === 1).length}, tier 2 ${tags.filter((t) => t.icp_tier === 2).length}, tier 3 ${tags.filter((t) => t.icp_tier === 3).length}, ` +
      `no tier ${tags.filter((t) => t.icp_tier === null).length}; target accounts ${tags.filter((t) => t.target_account).length}; ` +
      `planted: tier-3 targets ${d.planted.tierThreeTargets.length}, missing tier ${d.planted.missingTier.length}, missing territory ${d.planted.missingTerritory.length}, wrong territory ${d.planted.wrongTerritory.length}`,
  );
  return out;
}

async function main() {
  console.log(`ADR backfill (as of ${AS_OF_DATE})${dryRun ? ": DRY RUN, nothing is written" : ""}\n`);
  if (!dryRun && !existsSync("reconciliation/adr-before.json")) {
    throw new Error("No before snapshot. Run `npm run adr:check -- --save-before` first. Nothing was written.");
  }
  const input = await loadAdrInputs();
  const d = buildAdrData({ ...input, asOf: AS_OF_DATE });
  for (const line of adrSummary(d, input.team)) console.log(line);
  console.log("\nSample leads:");
  for (const l of d.leads.filter((_, i) => i % 120 === 7)) console.log(`  ${l.id} ${l.contact_name}, ${l.contact_title} <${l.contact_email}> | ${l.lead_source} | ${l.lifecycle_stage}${l.disqualify_reason ? ` (${l.disqualify_reason})` : ""}`);
  console.log("Sample Stage 0.1 deals:");
  for (const o of d.stage01Deals.slice(0, 3)) console.log(`  ${o.id} ${o.account_id} $${o.amount_usd} created ${o.created_date}, last activity ${o.last_activity_date}, ${o.next_step}`);
  console.log(`\nADR fingerprint: ${adrFingerprint(d)} (npm run seed -- --dry-run prints the same code for the same data)`);
  if (dryRun) {
    console.log("\nDry run: nothing was written.");
    return;
  }

  console.log("\nWriting...");
  for (const [id, territory] of d.teamTerritory) {
    const { error } = await db.from("team").update({ territory }).eq("id", id);
    if (error) throw new Error(`Updating team ${id} failed: ${error.message}`);
  }
  console.log(`  team.territory: ${d.teamTerritory.size} people`);
  const up = async (table: string, rows: object[], onConflict: string) => {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(table).upsert(rows.slice(i, i + 500), { onConflict });
      if (error) throw new Error(`Writing ${table} failed: ${error.message}`);
    }
    console.log(`  ${table}: ${rows.length} rows`);
  };
  await up("adr_ae_pairings", d.pairings, "adr_id,ae_id");
  for (const [id, tags] of d.accountTags) {
    const { error } = await db.from("accounts").update(tags).eq("id", id);
    if (error) throw new Error(`Updating account ${id} failed: ${error.message}`);
  }
  console.log(`  accounts.icp_tier / target_account / territory: ${d.accountTags.size} accounts`);
  await up("opportunities", d.stage01Deals, "id"); // new Stage 0.1 deals only; leads reference them
  await up("leads", d.leads, "id");
  await up("sequences", d.sequences, "id");
  await up("sequence_enrollments", d.enrollments, "id");
  console.log("Done. Now run: npm run adr:check");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
