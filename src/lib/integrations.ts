// Status of Cockpit's data sources for the Integrations page. Server-side only.
import { createClient } from "@supabase/supabase-js";
import { DAILY_BUDGET_USD, getTodaySpend } from "./claude";

export type SupabaseStatus = { connected: boolean; lastSeededAt: string | null; asOfDate: string | null; error?: string };
export type ClaudeStatus = { connected: boolean; spendTodayUsd: number; callsToday: number; budgetUsd: number; error?: string };

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
    const spend = await getTodaySpend();
    return { connected, spendTodayUsd: spend.costUsd, callsToday: spend.calls, budgetUsd: DAILY_BUDGET_USD };
  } catch (e) {
    return { connected, spendTodayUsd: 0, callsToday: 0, budgetUsd: DAILY_BUDGET_USD, error: e instanceof Error ? e.message : String(e) };
  }
}
