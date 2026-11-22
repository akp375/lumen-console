// Cockpit has no login yet. Actions that write to outside systems (the "Sync to HubSpot" button)
// only run when Cockpit is running on this Mac with `npm run dev`, never on a deployed copy.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True only on the local dev server (npm run dev, which listens on 127.0.0.1), opened at a local address. */
export function isLocalDev(host: string | null): boolean {
  if (process.env.VERCEL || process.env.NODE_ENV !== "development") return false;
  return LOCAL_HOSTS.has((host ?? "").replace(/:\d+$/, "").toLowerCase());
}

export const LOCAL_ONLY_NOTE = "Available locally until login is added";
