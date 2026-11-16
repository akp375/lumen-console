// One list of the app's pages: nav label, page title, tab title and one-line description.
// Titles use Title Case ("Deal Risk"); descriptions and buttons use sentence case.

export const PRODUCT_NAME = "Cockpit";

export const PAGES = {
  overview: { href: "/", title: "Overview", description: "Revenue, pipeline and AI cost across Lumen AI's customers." },
  renewals: { href: "/renewals", title: "Renewals", description: "Customers renewing this quarter and next. Flag the ones at risk to get Claude's next steps." },
  dealRisk: { href: "/deal-risk", title: "Deal Risk", description: "Open deals closing this quarter and next. Flag the ones at risk to get Claude's next steps." },
  workspace: { href: "/workspace", title: "Workspace", description: "Ask questions about Lumen AI's revenue, renewals, pipeline and margins." },
  integrations: { href: "/integrations", title: "Integrations", description: "Where Cockpit's data comes from, and the CRMs it will sync with." },
} as const;

export const NAV = [PAGES.overview, PAGES.renewals, PAGES.dealRisk, PAGES.workspace, PAGES.integrations];

/** Browser tab title, e.g. "Deal Risk · Cockpit". */
export const tabTitle = (title: string) => `${title} · ${PRODUCT_NAME}`;
