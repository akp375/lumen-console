// Scope test: creates one note and one task on the --one test company, to confirm the app may write them.
// Each run adds one more note and task (labelled "Lumen Console scope test"); delete them in HubSpot if you like.
// Run with: npm run hubspot:test-activity   (after npm run hubspot:sync -- --one)

import { getCrmSyncData } from "../src/lib/metrics.ts";
import { hubspot } from "../src/lib/hubspot.ts";
import { pickTestAccount } from "../src/lib/hubspot-sync.ts";

// HubSpot's default association types (read from GET /crm/v4/associations/{from}/companies/labels on 20 Nov 2026).
const NOTE_TO_COMPANY = 190;
const TASK_TO_COMPANY = 192;
const DAY_MS = 86_400_000;

type Created = { id: string };

try {
  const account = pickTestAccount(await getCrmSyncData()) ?? fail("No test account found.");
  const found = await hubspot<{ results: { id: string; properties: { name: string } }[] }>("POST", "/crm/v3/objects/companies/search", {
    filterGroups: [{ filters: [{ propertyName: "lumen_account_id", operator: "EQ", value: account.accountId }] }],
    properties: ["name"],
    limit: 1,
  });
  const company = found.results[0] ?? fail(`${account.name} is not in HubSpot yet. Run npm run hubspot:sync -- --one first.`);
  console.log(`Test company: ${company.properties.name} (HubSpot id ${company.id})`);

  // Real clock here on purpose: these are real records with real timestamps, not metrics.
  const now = Date.now();
  const note = await hubspot<Created>("POST", "/crm/v3/objects/notes", {
    properties: {
      hs_timestamp: new Date(now).toISOString(),
      hs_note_body: "Lumen Console scope test: this note was created by the app to confirm it may write notes. Safe to delete.",
    },
    associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_COMPANY }] }],
  });
  console.log(`Note created (id ${note.id}).`);

  const task = await hubspot<Created>("POST", "/crm/v3/objects/tasks", {
    properties: {
      hs_timestamp: new Date(now + 7 * DAY_MS).toISOString(), // due in 7 days
      hs_task_subject: "Lumen Console scope test",
      hs_task_body: "Created by the app to confirm it may write tasks. Safe to delete.",
      hs_task_status: "NOT_STARTED",
      hs_task_priority: "LOW",
      hs_task_type: "TODO",
    },
    associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: TASK_TO_COMPANY }] }],
  });
  console.log(`Task created (id ${task.id}), due in 7 days.`);
  console.log("\nScopes confirmed: the app can write notes and tasks on companies.");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

function fail(msg: string): never {
  throw new Error(msg);
}
