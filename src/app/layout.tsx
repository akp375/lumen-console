import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
// Banner date is display text only, set by the owner. The app's calculations use AS_OF_DATE (src/lib/as-of-date.ts).
import { NavBar } from "@/components/NavBar";
import { PAGES, PRODUCT_NAME, tabTitle } from "@/lib/pages";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Pages set their own title ("Deal Risk · Cockpit"); this is the Overview page and the fallback.
  title: tabTitle(PAGES.overview.title),
  description: `${PRODUCT_NAME}: the RevOps app built for Lumen AI. Revenue, pipeline, AI cost and account health.`,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black">
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Demo data: Lumen AI is a fictional company with seeded synthetic data. As of 15 September 2026.
        </div>
        <NavBar />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
