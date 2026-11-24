// Test for the Pipeline agent's HubSpot task: creates ONE task on ONE company with the exact code an
// approved create_hubspot_task uses (createHubSpotTask in src/lib/agent-db.ts), so the first real
// approval isn't also the first test. Uses the same test company as `npm run hubspot:sync -- --one`.
// Each run adds one more task (labelled "Cockpit agent test"); delete it in HubSpot if you like.
// Run with: npm run hubspot:test-task
import { getCrmSyncData } from "../src/lib/metrics.ts";
import { pickTestAccount } from "../src/lib/hubspot-sync.ts";
import { createHubSpotTask } from "../src/lib/agent-db.ts";

const account = pickTestAccount(await getCrmSyncData());
if (!account) throw new Error("No test account found.");
// Real calendar, like an approved task: due 7 days from today's real date.
const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
console.log(`Test company: ${account.name} (${account.accountId}); due ${due}`);
const t = await createHubSpotTask({
  object: "company",
  recordId: account.accountId,
  accountId: account.accountId,
  title: "Cockpit agent test: check this task is on the right company",
  body: "Cockpit agent test: created by npm run hubspot:test-task. Safe to delete.",
  dueDate: due,
});
console.log(`Created HubSpot task ${t.taskId} on HubSpot company ${t.hubspotRecordId}.`);
