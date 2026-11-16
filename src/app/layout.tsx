import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AS_OF_DATE } from "@/lib/as-of-date";
import { longDate } from "@/lib/format";
import { NavBar } from "@/components/NavBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cockpit · Lumen AI",
  description: "Cockpit: the RevOps app built for Lumen AI. Revenue, pipeline, AI cost and account health.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-black">
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Demo data: Lumen AI is a fictional company. As of {longDate(AS_OF_DATE)}.
        </div>
        <NavBar />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
