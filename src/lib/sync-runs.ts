// HubSpot sync runs: recorded after each real sync (not dry runs), read by the Integrations page.
// Operational records about running the app (like llm_calls), not business numbers. Server-side only.
// Uses the real clock: a run's time is when it actually happened.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SyncRunRow = {
  scope: "full" | "one";
  account_id: string | null;
  source: "button" | "cli";
  status: "success" | "failed";
  started_at: string;
  finished_at: string;
  companies_synced: number;
  companies_created: number;
  deals_synced: number;
  deals_created: number;
  contacts_synced: number;
  contacts_created: number;
  deals_left_out: number;
  error: string | null;
};

let supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server-side)");
  supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return supabase;
}

const MISSING = "Sync runs aren't recorded yet: run supabase/migrations/20261129000000_sync_runs.sql in Supabase.";
const isMissingTable = (e: { code?: string; message: string }) => e.code === "PGRST205" || e.code === "42P01" || /Could not find the table|does not exist/i.test(e.message);

/** Saves one run. Returns an error message instead of throwing, so a sync never fails because of its log. */
export async function recordSyncRun(row: SyncRunRow): Promise<string | null> {
  try {
    const { error } = await db().from("sync_runs").insert({ target: "hubspot", ...row });
    if (!error) return null;
    return isMissingTable(error) ? MISSING : `Couldn't record this sync run: ${error.message}`;
  } catch (e) {
    return `Couldn't record this sync run: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export type LastSyncRuns = {
  /** The most recent run of any kind (full or one account, success or failed). */
  last: (SyncRunRow & { id: string }) | null;
  /** The most recent successful full sync. */
  lastFull: (SyncRunRow & { id: string }) | null;
  /** Set when the table doesn't exist yet. */
  notice: string | null;
};

export async function getLastSyncRuns(): Promise<LastSyncRuns> {
  const cols = "id, scope, account_id, source, status, started_at, finished_at, companies_synced, companies_created, deals_synced, deals_created, contacts_synced, contacts_created, deals_left_out, error";
  const [last, full] = await Promise.all([
    db().from("sync_runs").select(cols).eq("target", "hubspot").order("finished_at", { ascending: false }).limit(1).maybeSingle(),
    db().from("sync_runs").select(cols).eq("target", "hubspot").eq("scope", "full").eq("status", "success").order("finished_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const err = last.error ?? full.error;
  if (err) {
    if (isMissingTable(err)) return { last: null, lastFull: null, notice: MISSING };
    throw new Error(`Reading sync_runs failed: ${err.message}`);
  }
  return { last: (last.data as LastSyncRuns["last"]) ?? null, lastFull: (full.data as LastSyncRuns["lastFull"]) ?? null, notice: null };
}
