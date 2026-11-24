// Syncs Supabase -> HubSpot. The work is done by src/lib/hubspot-sync-run.ts, which the
// "Sync to HubSpot" button on the Integrations page also uses. Never deletes anything in HubSpot.
//
// Run with: npm run hubspot:sync                           (everything)
//           npm run hubspot:sync -- --one                  (the default test customer and its deals, plus one test lead)
//           npm run hubspot:sync -- --one --lead lead_0044 (the same, with this lead)
//           npm run hubspot:sync -- --account acc_0089     (one customer by Lumen account ID, and its deals)
//           npm run hubspot:sync -- --dry-run              (build everything, send nothing; combine with --one or --account)

import { runHubSpotSync } from "../src/lib/hubspot-sync-run.ts";

const args = process.argv.slice(2);
const accountAt = args.indexOf("--account");
const accountId = accountAt === -1 ? undefined : args[accountAt + 1];
const leadAt = args.indexOf("--lead");
const leadId = leadAt === -1 ? undefined : args[leadAt + 1];

try {
  if (leadAt !== -1 && (!leadId || leadId.startsWith("--"))) throw new Error("--lead needs a Lumen lead ID, e.g. --lead lead_0044");
  if (accountAt !== -1 && (!accountId || accountId.startsWith("--"))) throw new Error("--account needs a Lumen account ID, e.g. --account acc_0089");
  const r = await runHubSpotSync({
    dryRun: args.includes("--dry-run"),
    one: args.includes("--one"),
    accountId,
    leadId,
    onProgress: (line) => console.log(line),
  });
  if (r.samples) {
    if (r.samples.company) console.log("\nSample company:", JSON.stringify(r.samples.company, null, 2));
    if (r.samples.deal) console.log("\nSample deal:", JSON.stringify(r.samples.deal, null, 2));
    if (r.samples.contact) console.log("\nSample contact:", JSON.stringify(r.samples.contact, null, 2));
    if (r.samples.sponsorContact && r.samples.sponsorContact !== r.samples.contact)
      console.log("\nSample sponsor contact:", JSON.stringify(r.samples.sponsorContact, null, 2));
    if (r.samples.leadContact) console.log("\nSample lead contact:", JSON.stringify(r.samples.leadContact, null, 2));
    const perPipeline = Object.entries(r.samples.dealsPerPipeline);
    if (perPipeline.length) console.log(`\nDeals per pipeline: ${perPipeline.map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (!r.dryRun && r.scope.kind === "one") console.log(`\nSynced ${r.scope.name}. Open it in HubSpot (company id ${r.scope.hubspotId}).`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
