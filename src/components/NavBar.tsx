"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, PRODUCT_NAME, sectionFor } from "@/lib/pages";
import { rememberPage } from "./BackLink";

export function NavBar() {
  const path = usePathname();
  useEffect(() => rememberPage(path), [path]);
  return <NavBarView path={path} />;
}

/** The same bar with no tab highlighted: shown for a moment while a page with an ID in its address loads. */
export function NavBarPlaceholder() {
  return <NavBarView path={null} />;
}

const TAB =
  "-mb-px flex items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors";
const ACTIVE = "border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-50";
const IDLE =
  "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100";

function NavBarView({ path }: { path: string | null }) {
  const section = path === null ? null : sectionFor(path);
  return (
    <nav aria-label="Main" className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-stretch gap-8 px-4 sm:px-6">
        <Link href="/" className="flex items-center font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {PRODUCT_NAME}
        </Link>
        <div className="flex items-stretch gap-1 overflow-x-auto">
          {NAV.map((s) => {
            const active = section === s;
            return (
              <Link key={s.title} href={s.href} aria-current={active && s.pages.length === 0 ? "page" : undefined} className={`${TAB} ${active ? ACTIVE : IDLE}`}>
                {s.title}
              </Link>
            );
          })}
        </div>
      </div>
      {section && section.pages.length > 0 && (
        <div className="border-t border-zinc-100 bg-zinc-50/60 dark:border-zinc-900 dark:bg-zinc-900/40">
          <div aria-label={`${section.title} pages`} role="navigation" className="mx-auto flex h-10 w-full max-w-6xl items-stretch gap-1 overflow-x-auto px-4 sm:px-6">
            {section.pages.map((p) => {
              const active = path === p.href || (path?.startsWith(`${p.href}/`) ?? false);
              return (
                <Link key={p.href} href={p.href} aria-current={active ? "page" : undefined} className={`${TAB} ${active ? ACTIVE : IDLE}`}>
                  {p.title}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
