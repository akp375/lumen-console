// Status of Cockpit's data sources for the Integrations page. Server-side only.
import { createClient } from "@supabase/supabase-js";
import { DAILY_BUDGET_USD, getSpendToDate, getTodaySpend } from "./claude";
import { accountTypeLabel, getHubSpotAccount } from "./hubspot";

export type HubSpotStatus = { connected: boolean; portalId: number | null; accountType: string | null; checkedAt: string; error?: string };

/** Live check: asks HubSpot which account the token belongs to. checkedAt is the real time of this check. */
export async function getHubSpotStatus(): Promise<HubSpotStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const a = await getHubSpotAccount();
    return { connected: true, portalId: a.portalId, accountType: accountTypeLabel(a.accountType), checkedAt };
  } catch (e) {
    return { connected: false, portalId: null, accountType: null, checkedAt, error: e instanceof Error ? e.message : String(e) };
  }
}

export type HubSpotLastSync = { syncedAt: string; companies: number; deals: number; contacts: number };

/** Latest full HubSpot sync, from sync_runs (written by `npm run hubspot:sync`). Null if none is recorded,
 *  or the sync_runs migration hasn't been run yet. Operational figure: read here, not in metrics.ts. */
export async function getHubSpotLastSync(): Promise<HubSpotLastSync | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db
    .from("sync_runs")
    .select("synced_at, companies, deals, contacts")
    .eq("target", "hubspot")
    .eq("scope", "full")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return { syncedAt: String(data.synced_at), companies: Number(data.companies), deals: Number(data.deals), contacts: Number(data.contacts) };
}

export type SupabaseStatus = { connected: boolean; lastSeededAt: string | null; asOfDate: string | null; error?: string };
export type ClaudeStatus = { connected: boolean; spendTodayUsd: number; callsToday: number; spendToDateUsd: number; callsToDate: number; budgetUsd: number; error?: string };

export async function getSupabaseStatus(): Promise<SupabaseStatus> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { connected: false, lastSeededAt: null, asOfDate: null, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set." };
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Connected = we can read the demo data.
  const probe = await db.from("accounts").select("id", { count: "exact", head: true });
  if (probe.error) return { connected: false, lastSeededAt: null, asOfDate: null, error: probe.error.message };

  // Last seed: newest seed_runs row (the table exists once its migration has been run).
  const run = await db.from("seed_runs").select("seeded_at, as_of_date").order("seeded_at", { ascending: false }).limit(1).maybeSingle();
  if (run.error || !run.data) return { connected: true, lastSeededAt: null, asOfDate: null };
  return { connected: true, lastSeededAt: String(run.data.seeded_at), asOfDate: String(run.data.as_of_date) };
}

export async function getClaudeStatus(): Promise<ClaudeStatus> {
  const connected = Boolean(process.env.ANTHROPIC_API_KEY); // checks the key is set; never reads it out
  try {
    // Both use the real clock: llm_calls is real API spend, not demo data.
    const [spend, total] = await Promise.all([getTodaySpend(), getSpendToDate()]);
    return {
      connected,
      spendTodayUsd: spend.costUsd,
      callsToday: spend.calls,
      spendToDateUsd: total.costUsd,
      callsToDate: total.calls,
      budgetUsd: DAILY_BUDGET_USD,
    };
  } catch (e) {
    return { connected, spendTodayUsd: 0, callsToday: 0, spendToDateUsd: 0, callsToDate: 0, budgetUsd: DAILY_BUDGET_USD, error: e instanceof Error ? e.message : String(e) };
  }
}
