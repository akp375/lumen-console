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
  type CustomerVoice,
  type HealthTrendRow,
  type RenewalDealCoverage,
  type RenewalRiskReason,
  type RenewalRiskRow,
} from "@/lib/metrics";
import { pct, pctChange, segmentLabel, shortDate, usd } from "@/lib/format";
import { PAGES, tabTitle } from "@/lib/pages";
import { PageHeader } from "@/components/PageHeader";
import { RiskBadge, RuleNote, SectionHeading, SignalChips, Stat } from "@/components/RiskUi";
import { SectionSkeleton } from "@/components/Skeleton";
import { RenewalDealsTable } from "@/components/RenewalDealsTable";
import { BAND_LABEL, BAND_TEXT, HealthCategoryRows, TrendArrow } from "@/components/HealthUi";
import { HealthChart } from "@/components/HealthChart";
import { BackLink } from "@/components/BackLink";
import { TOPIC_LABEL, type Sentiment } from "@/lib/signal-topics";
import { getFeatureSpend } from "@/lib/claude";
import { TAGGING_FEATURE } from "@/lib/topic-tagging";
import { AS_OF_DATE } from "@/lib/as-of-date";
import { AiBadge } from "@/components/AiBadge";

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
  const [data, tagging] = await Promise.all([getAccountPageData(id), getFeatureSpend(TAGGING_FEATURE).catch(() => null)]);
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
        <CustomerVoiceSection voice={data.voice} tagging={tagging} />
        <ProductsSection products={products} />
        <section>
          <SectionHeading
            title="Renewal Deals"
            detail="Every renewal deal for this account at its full amount, latest close first. Expand a row to see the contract's active lines."
          />
          {data.renewalDealCoverage?.missing && renewalDeals.length > 0 && (
            <div className="mb-3">
              <RenewalDealGap coverage={data.renewalDealCoverage} />
            </div>
          )}
          {renewalDeals.length === 0 && data.renewalDealCoverage ? (
            <RenewalDealGap coverage={data.renewalDealCoverage} />
          ) : (
            <RenewalDealsTable rows={renewalDeals} showAccount={false} empty="No renewal deals for this account yet." />
          )}
          <div className="mt-2">
            <RuleNote>
              Difference = deal amount minus the sum of the contract&apos;s active lines: uplift when the deal is higher, reduction when lower. Downsell
              risk = a line whose usage fell more than {Math.abs(ADOPTION_DROP_BELOW * 100)}% (last 30 days vs the 30 before). Won renewals are
              compared with today&apos;s lines, so seat changes since the renewal show as a difference.
            </RuleNote>
          </div>
        </section>
        {isCustomer && data.renewalRisk && <RenewalRiskSection r={data.renewalRisk} missingDeal={data.renewalDealCoverage?.missing ?? false} />}
      </div>
    </>
  );
}

function MissingDealChip() {
  return <span className="inline-block whitespace-nowrap rounded-md bg-red-600 px-2 py-0.5 text-xs font-semibold text-white dark:bg-red-500">Missing renewal deal</span>;
}

/** No open renewal deal: flagged when the contract renews inside its window, neutral before that. */
function RenewalDealGap({ coverage: c }: { coverage: RenewalDealCoverage }) {
  const box = "rounded-lg border bg-white p-4 text-sm dark:bg-zinc-900";
  if (c.missing) {
    return (
      <div className={`${box} flex flex-wrap items-center gap-3 border-red-200 dark:border-red-900`}>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          Contract renews {shortDate(c.renewalDate)} ({c.daysToRenewal} days) · No renewal deal opened yet
        </span>
        <MissingDealChip />
      </div>
    );
  }
  return (
    <p className={`${box} border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400`}>
      {c.hasOpenRenewalDeal ? `Contract renews ${shortDate(c.renewalDate)}.` : `Contract renews ${shortDate(c.renewalDate)}; no renewal deal needed yet.`}
    </p>
  );
}

type ConditionStatus = "counts" | "present" | "ok" | "off";

const STATUS_PILL: Record<ConditionStatus, { label: string; className: string }> = {
  counts: { label: "Counts", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  present: { label: "Present, not counted", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  ok: { label: "OK", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
  off: { label: "Not checked yet", className: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
};

/** Renewal risk for this account: the level, the reasons behind it, and every condition the rule checks. */
function RenewalRiskSection({ r, missingDeal }: { r: RenewalRiskRow; missingDeal: boolean }) {
  const R = RENEWAL_RISK_RULES;
  const c = r.conditions;
  const counts = (...reasons: RenewalRiskReason[]) => reasons.some((x) => r.reasons.includes(x));
  const status = (counted: boolean, present: boolean): ConditionStatus => (!r.inWindow ? "off" : counted ? "counts" : present ? "present" : "ok");

  const health = r.healthScore === null ? null : Math.round(r.healthScore);
  const rows: { label: string; value: string; rule: string; status: ConditionStatus }[] = [
    {
      label: "Health score",
      value: health === null ? "No score" : `${health} of 100`,
      rule: `Below ${R.highHealthBelow} = High. ${R.highHealthBelow}–${R.mediumHealthBelow - 1} = Medium, or High with a red flag below.`,
      status: status(counts("Health below 50", "Health 50–69"), health !== null && health < R.mediumHealthBelow),
    },
    {
      label: "Health trend",
      value: r.healthChange === null ? "No snapshot last week" : `${r.healthChange > 0 ? "+" : ""}${Math.round(r.healthChange)} points on last week`,
      rule: `Down ${R.healthDropOf}+ points makes health ${R.highHealthBelow}–${R.mediumHealthBelow - 1} High.`,
      status: status(counts("Health down 10+"), c.healthDown10),
    },
    {
      label: "Gross margin",
      value: r.grossMargin === null ? "n/a" : `${pct(r.grossMargin)} (last 30 days)`,
      rule: `Underwater below ${R.underwaterMarginBelow * 100}%: High with health ${R.highHealthBelow}–${R.mediumHealthBelow - 1}, Medium at ${R.mediumHealthBelow}+.`,
      status: status(counts("Underwater margin"), c.underwater),
    },
    {
      label: "Downsell risk",
      value: c.anyDownsell ? `${usd(r.downsellArr)} of contract ARR (${pct(r.downsellShare)})` : "None",
      rule: `Lines with usage down more than ${Math.abs(ADOPTION_DROP_BELOW * 100)}% (last 30 days vs prior 30). ${R.downsellShareFrom * 100}%+ of ARR makes health ${R.highHealthBelow}–${R.mediumHealthBelow - 1} High; any line makes health ${R.mediumHealthBelow}+ Medium.`,
      status: status(counts("25%+ ARR at downsell risk", "Downsell risk"), c.anyDownsell),
    },
    {
      label: "NPS change",
      value: r.npsChange === null ? "Only one survey" : `${r.npsChange > 0 ? "+" : ""}${r.npsChange} since the previous survey`,
      rule: `Down ${R.npsDropOf}+ points = Medium on its own.`,
      status: status(counts("NPS down 3+"), c.npsDown3),
    },
    {
      label: "Executive sponsor",
      value: !c.sponsorTracked
        ? `Not tracked for ${segmentLabel(r.segment)}`
        : r.sponsorStatus === "left"
          ? "Left"
          : r.sponsorStatus === "none"
            ? "None"
            : "Active",
      rule: `Enterprise and mid-market only. None or left = Medium on its own, High when health is below ${R.mediumHealthBelow}.`,
      status: status(counts("No exec sponsor", "Exec sponsor left"), c.sponsorGap !== null),
    },
  ];

  const window = r.inWindow
    ? `Renews ${shortDate(r.renewalDate)}, in ${r.daysToRenewal} days: inside the ${r.windowDays}-day ${segmentLabel(r.segment)} window, so the rules below apply.`
    : r.daysToRenewal < 0
      ? `Renewal date ${shortDate(r.renewalDate)} has passed.`
      : `Renews ${shortDate(r.renewalDate)}, in ${r.daysToRenewal} days: outside the ${r.windowDays}-day ${segmentLabel(r.segment)} window, so it is Low until ${shortDate(r.windowOpensOn)}. The values below show where it stands today.`;

  return (
    <section>
      <SectionHeading title="Renewal Risk" detail="The level the Renewals page and HubSpot use, what set it, and every condition the rule checks." />
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <RiskBadge level={r.level} />
          {r.reasons.length > 0 ? <SignalChips signals={r.reasons} /> : <span className="text-sm text-zinc-500">No condition met</span>}
          {missingDeal && (
            <span className="flex items-center gap-2">
              <MissingDealChip />
              <span className="text-xs text-zinc-500">Inside the window with no open renewal deal (doesn&apos;t change the level)</span>
            </span>
          )}
          <p className="w-full text-sm text-zinc-600 dark:text-zinc-400">{window}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2">Condition</th>
                <th className="px-4 py-2">This account</th>
                <th className="px-4 py-2">Rule</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((row) => (
                <tr key={row.label} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{row.label}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{row.value}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-500 dark:text-zinc-400">{row.rule}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[row.status].className}`}>
                      {STATUS_PILL[row.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
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
        detail={`Score out of 100 as of ${shortDate(AS_OF_DATE)} and the last 6 weekly snapshots. Hover a category to see each metric's value and points.`}
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

const SENTIMENT_DOT: Record<Sentiment, string> = {
  positive: "bg-emerald-500",
  neutral: "bg-zinc-400",
  negative: "bg-red-500",
};

function CustomerVoiceSection({ voice: v, tagging }: { voice: CustomerVoice; tagging: { model: string | null; calls: number; costUsd: number } | null }) {
  const mentioned = v.topics.filter((t) => t.count > 0);
  return (
    <section>
      <SectionHeading
        title="What Customers Are Saying"
        badge={tagging && tagging.calls > 0 && <AiBadge model={tagging.model} costUsd={tagging.costUsd} costNote={`· all ${tagging.calls.toLocaleString("en-US")} texts tagged`} />}
        detail={`Topics Claude found in support tickets and CSM notes, counted over the last ${v.windowDays} days (since ${shortDate(v.since)}), and the latest quotes.`}
      />
      {v.taggedTotal === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No tagged tickets or CSM notes for this account yet.
        </p>
      ) : (
        <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2">
            {mentioned.length === 0 ? (
              <span className="text-sm text-zinc-500 dark:text-zinc-400">No risk topics in the last {v.windowDays} days.</span>
            ) : (
              mentioned.map((t) => (
                <span
                  key={t.topic}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-800 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900"
                >
                  {TOPIC_LABEL[t.topic]}
                  <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white dark:bg-red-500">{t.count}</span>
                </span>
              ))
            )}
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              {v.texts} {v.texts === 1 ? "text" : "texts"} in the last {v.windowDays} days
            </span>
            <span className="inline-flex items-center gap-3">
              {(["negative", "neutral", "positive"] as const).map((s) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${SENTIMENT_DOT[s]}`} />
                  {v.sentiment[s]} {s}
                </span>
              ))}
            </span>
            {v.competitors.length > 0 && <span>Competitors named: {v.competitors.join(", ")}</span>}
          </div>
          {v.quotes.length > 0 && (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {v.quotes.map((q, i) => (
                <li key={i} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-4">
                  <div className="w-36 shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                    <div>{shortDate(q.date)}</div>
                    <div>{q.source === "support_ticket" ? "Support ticket" : "CSM note"}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-800 dark:text-zinc-200">
                      <span aria-hidden className={`mr-2 inline-block h-2 w-2 rounded-full align-middle ${SENTIMENT_DOT[q.sentiment]}`} />
                      &ldquo;{q.quote}&rdquo;
                    </p>
                    {q.topics.length > 0 && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{q.topics.map((t) => TOPIC_LABEL[t]).join(" · ")}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <RuleNote>Claude Haiku 5.5 tagged every ticket and note from the last 180 days; this section counts the last {v.windowDays}. Each quote is copied word for word from its text.</RuleNote>
        </div>
      )}
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
