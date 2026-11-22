"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

// "← Back" that returns to the page you came from inside Cockpit (Health, Renewals, Overview...).
// When there is no earlier Cockpit page in this tab (a link opened in a new tab, say), it goes to `fallbackHref`.

const LAST = "cockpit:last-page";
const PREVIOUS = "cockpit:previous-page";

/** Called by the nav bar on every page change: remembers the page before this one, for this browser tab only. */
export function rememberPage(path: string) {
  try {
    const last = sessionStorage.getItem(LAST);
    if (last && last !== path) sessionStorage.setItem(PREVIOUS, last);
    sessionStorage.setItem(LAST, path);
  } catch {
    // Storage blocked (private mode): the link just falls back to fallbackHref.
  }
}

function hasPreviousPage(): boolean {
  try {
    return sessionStorage.getItem(PREVIOUS) !== null;
  } catch {
    return false;
  }
}

export function BackLink({ fallbackHref }: { fallbackHref: string }) {
  const router = useRouter();
  return (
    <Link
      href={fallbackHref}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || !hasPreviousPage()) return; // new tab, or nowhere to go back to
        e.preventDefault();
        router.back();
      }}
      className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
    >
      ← Back
    </Link>
  );
}
