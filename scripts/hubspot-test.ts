// Connection test: reads 5 companies from HubSpot and prints their names.
// Run with: npm run hubspot:test

import { hubspot } from "../src/lib/hubspot.ts";

type CompaniesPage = { results: { id: string; properties: { name?: string | null } }[] };

try {
  const page = await hubspot<CompaniesPage>("GET", "/crm/v3/objects/companies?limit=5&properties=name");
  if (page.results.length === 0) {
    console.log("Connected to HubSpot, but the account has no companies yet.");
  } else {
    console.log(`Connected to HubSpot. First ${page.results.length} companies:`);
    for (const c of page.results) console.log(`- ${c.properties.name || "(no name)"} (id ${c.id})`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
