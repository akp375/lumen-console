import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  ADOPTION_DROP_BELOW,
  HEALTH_RULES,
  RENEWAL_RISK_RULES,
  getAccountPageData,
  type AccountPageData,
  type ContractLineMetrics,
  type HealthTrendRow,
} from "@/lib/metrics";
import { pct, pctChange, segmentLabel, shortDate, usd } from "@/lib/format";
import { PAGES, tabTitle } from "@/lib/pages";
import { PageHeader } from "@/components/PageHeader";
import { RiskBadge, RuleNote, SectionHeading, Stat } from "@/components/RiskUi";
import { SectionSkeleton } from "@/components/Skeleton";
import { RenewalDealsTable } from "@/components/RenewalDealsTable";
import { BAND_LABEL, BAND_TEXT, HealthCategoryRows, TrendArrow } from "@/components/HealthUi";
import { HealthChart } from "@/components/HealthChart";
import { BackLink } from "@/components/BackLink";

export const metadata: Metadata = { title: tabTitle("Account") };

type Params = { params: Promise<{ id: string }> };

export default function AccountPage({ params }: Params) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Loading />}>
        <AccountContent params={params} />
      </Suspense>
    </main>
  );
}

// Reads live data on each request (server-side only).
async function AccountContent({ params }: Params) {
  await connection();
  const { id } = await params;
  const data = await getAccountPageData(id);
  if (!data) notFound();
  const { account: a, renewalRiskLevel, products, renewalDeals, health } = data;
  const isCustomer = a.status === "customer";

  const description = [segmentLabel(a.segment), a.owner, a.status === "customer" ? "Customer" : a.status === "churned" ? "Churned" : "Prospect"].join(" · ");

  return (
    <>
      <div className="mb-3 text-sm">
        <BackLink fallbackHref={PAGES.overview.href} />
      </div>
      <PageHeader title={a.name} description={description} />

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="ARR" value={isCustomer ? usd(a.arr) : "n/a"} detail={isCustomer ? `MRR ${usd(a.mrr_usd)}` : "Not a current customer"} />
        <Stat label="Seats" value={a.seats === null ? "n/a" : String(a.seats)} detail="On the contract" />
        <Stat
          label={a.status === "churned" ? "Churned" : "Renewal date"}
          value={a.status === "churned" && a.churn_date ? shortDate(a.churn_date) : a.renewal_date ? shortDate(a.renewal_date) : "n/a"}
          detail={a.start_date ? `Customer since ${shortDate(a.start_date)}` : "No contract"}
        />
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">Renewal risk</div>
          <div className="mt-2">{isCustomer ? <RiskBadge level={renewalRiskLevel ?? "Low"} /> : <span className="text-2xl font-semibold text-zinc-400">n/a</span>}</div>
          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Same level the HubSpot sync sends</div>
        </div>
        <SponsorStat sponsor={a.executiveSponsor} segment={a.segment} isCustomer={isCustomer} />
      </div>

      <div className="space-y-8">
        {health && <HealthSection health={health} />}
        <ProductsSection products={products} />
        <section>
          <SectionHeading
            title="Renewal Deals"
            detail="Every renewal deal for this account at its full amount, latest close first. Expand a row to see the contract's active lines."
          />
          <RenewalDealsTable rows={renewalDeals} showAccount={false} empty="No renewal deals for this account yet." />
          <div className="mt-2">
            <RuleNote>
              Difference = deal amount minus the sum of the contract&apos;s active lines: uplift when the deal is higher, reduction when lower. Downsell
              risk = a line whose usage fell more than {Math.abs(ADOPTION_DROP_BELOW * 100)}% (last 30 days vs the 30 before). Won renewals are
              compared with today&apos;s lines, so seat changes since the renewal show as a difference.
            </RuleNote>
          </div>
        </section>
      </div>
    </>
  );
}

function SponsorStat({ sponsor, segment, isCustomer }: { sponsor: AccountPageData["account"]["executiveSponsor"]; segment: string; isCustomer: boolean }) {
  const tracked = isCustomer && RENEWAL_RISK_RULES.sponsorRequiredSegments.includes(segment);
  let value = "Not tracked";
  let detail = isCustomer ? `Not tracked for ${segmentLabel(segment)}` : "Customers only";
  let tone = "text-zinc-400";
  if (tracked && sponsor) {
    if (sponsor.status === "active") {
      value = sponsor.name ?? "Active";
      detail = sponsor.title ?? "Active";
      tone = "text-zinc-900 dark:text-zinc-50";
    } else if (sponsor.status === "left") {
      value = "Sponsor left";
      detail = `${sponsor.name}, ${sponsor.title}${sponsor.leftDate ? `, left ${shortDate(sponsor.leftDate)}` : ""}`;
      tone = "text-red-600 dark:text-red-400";
    } else {
      value = "None";
      detail = "No executive sponsor identified";
      tone = "text-red-600 dark:text-red-400";
    }
  }
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500 dark:text-zinc-400">Executive sponsor</div>
      <div className={`mt-1 truncate text-lg font-semibold ${tone}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>
    </div>
  );
}

function HealthSection({ health: h }: { health: HealthTrendRow }) {
  return (
    <section>
      <SectionHeading
        title="Health"
        detail="Score out of 100 as of the app's date and the last 6 weekly snapshots. Hover a category to see each metric's value and points."
      />
      <div className="grid gap-4 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 lg:grid-cols-[180px_1fr]">
        <div>
          <div className={`text-6xl font-semibold tabular-nums ${BAND_TEXT[h.band]}`}>{Math.round(h.score)}</div>
          <div className={`mt-1 text-sm font-medium ${BAND_TEXT[h.band]}`}>{BAND_LABEL[h.band]}</div>
          <div className="mt-2 text-sm">
            <TrendArrow change={h.change} declining={h.declining} /> <span className="text-xs text-zinc-500">vs last week</span>
          </div>
          {h.declining && (
            <span className="mt-2 inline-block rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500">Declining</span>
          )}
        </div>
        <HealthChart history={h.history} greenFrom={HEALTH_RULES.greenFrom} amberFrom={HEALTH_RULES.amberFrom} />
        <div className="lg:col-span-2">
          <HealthCategoryRows row={h} />
        </div>
      </div>
    </section>
  );
}

function ProductsSection({ products }: { products: ContractLineMetrics[] }) {
  return (
    <section>
      <SectionHeading
        title="Products"
        detail={`Each line on the contract. Adoption = tokens in the last 30 days as a share of the line's monthly allowance; red when usage fell more than ${Math.abs(ADOPTION_DROP_BELOW * 100)}% against the 30 days before, amber when over the allowance.`}
      />
      {products.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No contract lines. Prospects have none until they sign.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Purchased</th>
                <th className="px-4 py-2 text-right">ARR</th>
                <th className="px-4 py-2">Renews</th>
                <th className="px-4 py-2">Adoption</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {products.map((p) => (
                <tr key={p.lineId} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{p.product}</div>
                    {p.status !== "active" && <div className="text-xs capitalize text-zinc-500">{p.status}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">{shortDate(p.purchaseDate)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{usd(p.arr)}</td>
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">{shortDate(p.renewalDate)}</td>
                  <td className="px-4 py-3">
                    <AdoptionBar line={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdoptionBar({ line: p }: { line: ContractLineMetrics }) {
  if (p.notAdopted) {
    return (
      <div className="w-80">
        <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800" />
        <div className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">Not adopted: no usage in the last 60 days</div>
      </div>
    );
  }
  const width = Math.min(1, p.capacityUsed ?? 0) * 100;
  const fill = p.adoptionDrop ? "bg-red-500" : (p.capacityUsed ?? 0) > 1 ? "bg-amber-500" : "bg-zinc-700 dark:bg-zinc-300";
  return (
    <div className="w-80">
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" title={`${pct(p.capacityUsed)} of monthly allowance, last 30 days`}>
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="tabular-nums">{pct(p.capacityUsed)} of monthly allowance (last 30 days)</span>
        <span className="tabular-nums">· Usage {pctChange(p.usageChange)} (last 30 days vs prior 30)</span>
        <span className="tabular-nums">
          · {p.avgUsersLast30d.toFixed(1)} active users a day, last 30 days ({pctChange(p.usersChange)} vs prior 30)
        </span>
      </div>
      {p.adoptionDrop && (
        <span className="mt-1 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
          Adoption drop: usage down {Math.abs(ADOPTION_DROP_BELOW * 100)}%+
        </span>
      )}
    </div>
  );
}

function Loading() {
  return (
    <>
      <PageHeader title="Account" description="Loading…" />
      <SectionSkeleton columns={5} rows={3} />
    </>
  );
}
