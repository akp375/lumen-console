import type { Metadata } from "next";
import { RENEWAL_RISK_RULES } from "@/lib/metrics";
import { RenewalRiskPanel } from "@/components/RenewalRiskPanel";

export const metadata: Metadata = { title: "Renewals · Cockpit · Lumen AI" };

export default function RenewalsPage() {
  const R = RENEWAL_RISK_RULES;
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Renewals</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500 dark:text-zinc-400">
          Flags customers renewing within {R.renewalWithinDays} days that show at least one warning sign: latest NPS below {R.npsBelow}, NPS down{" "}
          {Math.abs(R.npsDropOf)} or more since the previous response, usage down more than {Math.abs(R.usageDropBelow * 100)}% (last 30 days vs the 30
          before), or an underwater margin (below 30%). Claude then writes a reason and next action for each account.
        </p>
      </header>
      <RenewalRiskPanel windowDays={R.renewalWithinDays} />
    </main>
  );
}
