// Minimal HubSpot API helper for Lumen Console scripts. Uses Node's built-in fetch (no extra packages).
// The token comes from HUBSPOT_ACCESS_TOKEN in .env.local and is never printed.

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function token(): string {
  const t = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!t) {
    console.error("HUBSPOT_ACCESS_TOKEN is not set. Add it to .env.local (see hubspot/README.md, step 6).");
    process.exit(1);
  }
  return t;
}

/** Calls the HubSpot API and returns the parsed JSON, or throws a readable HubSpotError. */
export async function hubspot<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) detail = j.message;
    } catch {
      // not JSON; keep the raw text
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
