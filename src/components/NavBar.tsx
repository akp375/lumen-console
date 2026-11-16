"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, PRODUCT_NAME } from "@/lib/pages";

export function NavBar() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-stretch gap-8 px-4 sm:px-6">
        <Link href="/" className="flex items-center font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {PRODUCT_NAME}
        </Link>
        <div className="flex items-stretch gap-1 overflow-x-auto">
          {NAV.map((p) => {
            const active = p.href === "/" ? path === "/" : path.startsWith(p.href);
            return (
              <Link
                key={p.href}
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px flex items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${
                  active
                    ? "border-zinc-900 font-medium text-zinc-900 dark:border-zinc-100 dark:text-zinc-50"
                    : "border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
                }`}
              >
                {p.title}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
