// Minimal HubSpot API helper, shared by the app (Integrations page) and the hubspot:* scripts. Server-side only.
// Uses the built-in fetch (no extra packages). The token comes from HUBSPOT_ACCESS_TOKEN in .env.local
// and is never printed or sent anywhere except HubSpot.

const BASE = "https://api.hubapi.com";
const TIMEOUT_MS = 10_000;

export class HubSpotError extends Error {
  status: number; // HTTP status, or 0 when the request never got an answer
  constructor(status: number, message: string) {
    super(message);
    this.name = "HubSpotError";
    this.status = status;
  }
}

const MAX_RETRIES = 5; // for HubSpot's "too many requests" (429) answers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls the HubSpot API and returns the parsed JSON, or throws a readable HubSpotError.
 *  On a rate limit (429) it waits as long as HubSpot asks (Retry-After), or 1, 2, 4, 8, 16 seconds, and retries. */
export async function hubspot<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(method, path, body);
    } catch (e) {
      if (!(e instanceof RateLimited) || attempt >= MAX_RETRIES) throw e instanceof RateLimited ? e.error : e;
      await sleep(e.retryAfterMs ?? 1000 * 2 ** attempt);
    }
  }
}

class RateLimited extends Error {
  retryAfterMs: number | null;
  error: HubSpotError;
  constructor(retryAfterMs: number | null, error: HubSpotError) {
    super(error.message);
    this.retryAfterMs = retryAfterMs;
    this.error = error;
  }
}

async function request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new HubSpotError(0, "HUBSPOT_ACCESS_TOKEN is not set. Add it to .env.local (see hubspot/README.md, step 6).");

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} seconds` : e instanceof Error ? e.message : String(e);
    throw new HubSpotError(0, `Couldn't reach HubSpot: ${why}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) detail = j.message;
    } catch {
      // not JSON; keep the raw text
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"));
      throw new RateLimited(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null, new HubSpotError(429, `HubSpot rate limit: ${detail}`));
    }
    const hint =
      res.status === 401
        ? " (the token is wrong or expired: copy it again from the app's Distribution tab)"
        : res.status === 403
          ? " (the app is missing a scope: add it in hubspot/app/src/app/app-hsmeta.json, upload and reinstall)"
          : "";
    throw new HubSpotError(res.status, `HubSpot ${method} ${path} failed with ${res.status}: ${detail}${hint}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type HubSpotAccount = { portalId: number; accountType: string };

/** Which HubSpot account the token belongs to. */
export function getHubSpotAccount(): Promise<HubSpotAccount> {
  return hubspot<HubSpotAccount>("GET", "/account-info/v3/details");
}

const ACCOUNT_TYPES: Record<string, string> = {
  DEVELOPER_TEST: "Developer test account",
  APP_DEVELOPER: "Developer account",
  SANDBOX: "Sandbox",
  STANDARD: "Standard account",
};

/** DEVELOPER_TEST -> "Developer test account" */
export function accountTypeLabel(type: string): string {
  return ACCOUNT_TYPES[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
}
