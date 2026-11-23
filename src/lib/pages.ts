// One list of the app's pages: nav label, page title, tab title and one-line description.
// Titles use Title Case ("Deal Risk"); descriptions and buttons use sentence case.

export const PRODUCT_NAME = "Cockpit";

export const PAGES = {
  overview: { href: "/", title: "Overview", description: "Revenue, pipeline and AI cost across Lumen AI's customers." },
  renewals: { href: "/customer-success/renewals", title: "Renewals", description: "Customers renewing this quarter and next. Flag the ones at risk to get Claude's next steps." },
  health: { href: "/customer-success/health", title: "Health", description: "Every customer's health score this week, its trend and the products losing adoption. Worst first." },
  dealRisk: { href: "/pipeline/deal-risk", title: "Deal Risk", description: "Open deals closing this quarter and next. Flag the ones at risk to get Claude's next steps." },
  workspace: { href: "/workspace", title: "Workspace", description: "Ask questions about Lumen AI's revenue, renewals, pipeline and margins." },
  integrations: { href: "/integrations", title: "Integrations", description: "Where Cockpit's data comes from, and the CRMs it will sync with." },
} as const;

export type NavPage = { href: string; title: string };
export type NavSection = {
  title: string;
  /** Where the top-level item links to: the section's first page. */
  href: string;
  /** Every address in this section starts with this (null for Overview, which is only "/"). */
  prefix: string | null;
  /** Sub-tabs; empty for single-page sections. */
  pages: readonly NavPage[];
};

/**
 * The four nav sections. Pipeline is for anything top of funnel (ADR hygiene and ADR insights
 * will join Deal Risk); Customer Success will also hold Consumption. Workspace isn't in the nav,
 * but its page still works at /workspace.
 */
export const NAV: readonly NavSection[] = [
  { title: PAGES.overview.title, href: PAGES.overview.href, prefix: null, pages: [] },
  { title: "Pipeline", href: PAGES.dealRisk.href, prefix: "/pipeline", pages: [PAGES.dealRisk] },
  { title: "Customer Success", href: PAGES.health.href, prefix: "/customer-success", pages: [PAGES.health, PAGES.renewals] },
  { title: PAGES.integrations.title, href: PAGES.integrations.href, prefix: PAGES.integrations.href, pages: [] },
];

/** Old addresses (before the sections) and section roots, redirected by next.config.ts. */
export const NAV_REDIRECTS: readonly { source: string; destination: string }[] = [
  { source: "/deal-risk", destination: PAGES.dealRisk.href },
  { source: "/health", destination: PAGES.health.href },
  { source: "/renewals", destination: PAGES.renewals.href },
  { source: "/pipeline", destination: PAGES.dealRisk.href },
  { source: "/customer-success", destination: PAGES.health.href },
];

/** The nav section a path belongs to, or null (account pages, Workspace). */
export function sectionFor(path: string): NavSection | null {
  return NAV.find((s) => (s.prefix === null ? path === "/" : path === s.prefix || path.startsWith(`${s.prefix}/`))) ?? null;
}

/** Browser tab title, e.g. "Deal Risk · Cockpit". */
export const tabTitle = (title: string) => `${title} · ${PRODUCT_NAME}`;
