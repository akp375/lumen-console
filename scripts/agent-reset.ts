// npm run agent:reset: undoes the Pipeline agent's approved actions so a demo can be rehearsed again.
//   - Reassigned leads go back to their previous ADR (and their sequence enrollments with them).
//   - Those leads' HubSpot contacts get their ADR owner and Unassigned / MQL past SLA flags back.
//   - Paused sequences go back to active.
//   - Those actions are marked "reverted" (the decision log stays: who approved, when).
// Left alone: rejected and waiting proposals, HubSpot tasks (they stay in HubSpot and stay "done"),
// and everything else. No reseed needed. Add --dry-run to list what would change without changing it.
import { revertApprovedActions, type ActionDb } from "../src/lib/agent-actions.ts";
import { supabaseActionDb } from "../src/lib/agent-db.ts";

const dryRun = process.argv.includes("--dry-run");

// In a dry run, every write is skipped and only the plan is printed.
const noWrites: ActionDb = {
  ...supabaseActionDb,
  setOutcome: async () => {},
  setLeadOwner: async () => {},
  setEnrollmentAdr: async () => {},
  setSequenceStatus: async () => {},
  updateLeadContacts: async (ids) => ({ updated: ids.length, notInHubSpot: [] }),
  createHubSpotTask: async () => {
    throw new Error("agent:reset never creates HubSpot tasks");
  },
};

const lines = await revertApprovedActions(dryRun ? noWrites : supabaseActionDb);
if (lines.length === 0) console.log("No approved agent actions to revert.");
for (const l of lines) console.log(`${l.status.padEnd(8)} ${l.type.padEnd(20)} ${l.id}  ${l.note}`);
const reverted = lines.filter((l) => l.status === "reverted").length;
console.log(dryRun ? `\nDry run: ${reverted} action(s) would be reverted. Nothing changed.` : `\n${reverted} action(s) reverted. HubSpot tasks left in place: ${lines.filter((l) => l.status === "kept").length}.`);
