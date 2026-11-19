// Creates the Lumen Console custom properties listed in hubspot/properties.json.
// - Creates the "Lumen Console" property group on each object if it is missing.
// - Skips properties that already exist. Never deletes or changes an existing property.
// - Properties made by hand in HubSpot are matched by label; their internal names are saved back to properties.json.
// Run with: npm run hubspot:setup             (makes changes)
//           npm run hubspot:setup -- --dry-run (only shows what it would do)

import { readFileSync, writeFileSync } from "node:fs";
import { hubspot } from "./hubspot-client.ts";

const FILE = new URL("../hubspot/properties.json", import.meta.url);
const DRY_RUN = process.argv.includes("--dry-run");

type Spec = {
  object: "companies" | "deals";
  label: string;
  name: string | null;
  madeByHand?: boolean;
  /** A HubSpot built-in property we reuse instead of creating our own (e.g. hs_next_renewal_date). */
  builtIn?: boolean;
  type: string;
  fieldType: string;
  numberDisplayHint?: string;
  options?: string[];
};
type SpecFile = { group: { name: string; label: string }; properties: Spec[] };
type HsOption = { label: string; value: string };
type HsProperty = {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  hubspotDefined?: boolean;
  numberDisplayHint?: string;
  options?: HsOption[];
};

const spec = JSON.parse(readFileSync(FILE, "utf8")) as SpecFile;
let namesChanged = false;
const counts = { created: 0, skipped: 0, warnings: 0 };

const slug = (label: string) => "lumen_" + label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const warn = (msg: string) => {
  counts.warnings++;
  console.log(`  ! ${msg}`);
};

/** Reports (never fixes) differences between what we planned and what exists in HubSpot. */
function compare(want: Spec, have: HsProperty) {
  if (have.type !== want.type || have.fieldType !== want.fieldType)
    warn(`"${have.label}" is ${have.type}/${have.fieldType} in HubSpot, planned ${want.type}/${want.fieldType}. Left as is.`);
  if (want.numberDisplayHint && have.numberDisplayHint && have.numberDisplayHint !== want.numberDisplayHint)
    warn(`"${have.label}" displays as ${have.numberDisplayHint}, planned ${want.numberDisplayHint}. Left as is.`);
  if (want.options) {
    const hsLabels = (have.options ?? []).map((o) => o.label);
    const missing = want.options.filter((o) => !hsLabels.includes(o));
    const extra = hsLabels.filter((o) => !want.options!.includes(o));
    if (missing.length || extra.length)
      warn(`"${have.label}" options differ. HubSpot has: ${hsLabels.join(", ") || "none"}. Planned: ${want.options.join(", ")}. Left as is.`);
  }
  if (have.groupName !== spec.group.name) console.log(`    note: "${have.label}" is in group "${have.groupName}", not "${spec.group.label}". Not moved.`);
}

function createBody(p: Spec, name: string) {
  return {
    name,
    label: p.label,
    groupName: spec.group.name,
    type: p.type,
    fieldType: p.fieldType,
    ...(p.numberDisplayHint ? { numberDisplayHint: p.numberDisplayHint } : {}),
    ...(p.numberDisplayHint === "currency" ? { showCurrencySymbol: true } : {}),
    ...(p.options
      ? { options: p.options.map((label, i) => ({ label, value: label.toLowerCase(), displayOrder: i, hidden: false })) }
      : {}),
  };
}

try {
  if (DRY_RUN) console.log("Dry run: nothing will be changed in HubSpot or in properties.json.\n");

  for (const object of [...new Set(spec.properties.map((p) => p.object))]) {
    console.log(`${object}:`);

    // 1. Property group
    const groups = await hubspot<{ results: { name: string }[] }>("GET", `/crm/v3/properties/${object}/groups`);
    if (groups.results.some((g) => g.name === spec.group.name)) {
      console.log(`  - group "${spec.group.label}" exists`);
    } else if (DRY_RUN) {
      console.log(`  + would create group "${spec.group.label}"`);
    } else {
      await hubspot("POST", `/crm/v3/properties/${object}/groups`, { name: spec.group.name, label: spec.group.label });
      console.log(`  + created group "${spec.group.label}"`);
    }

    // 2. Properties
    const existing = (await hubspot<{ results: HsProperty[] }>("GET", `/crm/v3/properties/${object}`)).results;
    for (const p of spec.properties.filter((x) => x.object === object)) {
      const byName = p.name ? existing.find((e) => e.name === p.name) : undefined;
      if (p.builtIn) {
        // Reused HubSpot property: never created by us; it stays in HubSpot's own group.
        if (byName) {
          console.log(`  - "${p.label}" uses HubSpot built-in "${byName.label}" (${byName.name}), skipped`);
          if (byName.type !== p.type) warn(`built-in ${byName.name} is ${byName.type}, planned ${p.type}.`);
          counts.skipped++;
        } else {
          warn(`built-in ${p.name} for "${p.label}" was not found in this account. Not created; check properties.json.`);
        }
        continue;
      }
      if (byName) {
        console.log(`  - "${p.label}" exists (${byName.name}), skipped`);
        compare(p, byName);
        counts.skipped++;
        continue;
      }

      // Made by hand? Match on label, ignoring HubSpot's own built-in properties.
      const byLabel = existing.filter((e) => e.label.trim().toLowerCase() === p.label.toLowerCase());
      const custom = byLabel.filter((e) => !e.hubspotDefined);
      if (custom.length > 1) {
        warn(`"${p.label}" matches ${custom.length} properties (${custom.map((e) => e.name).join(", ")}). Skipped; pick one and set its name in properties.json.`);
        continue;
      }
      if (custom.length === 1) {
        const have = custom[0];
        console.log(`  - "${p.label}" exists, made by hand (${have.name}), skipped`);
        compare(p, have);
        if (p.name !== have.name) {
          p.name = have.name;
          namesChanged = true;
        }
        counts.skipped++;
        continue;
      }
      if (byLabel.length) console.log(`    note: HubSpot has a built-in "${p.label}" (${byLabel[0].name}); creating our own.`);
      if (p.madeByHand) warn(`"${p.label}" was expected to exist (made by hand) but was not found. It will be created.`);

      const name = p.name ?? slug(p.label);
      if (DRY_RUN) {
        console.log(`  + would create "${p.label}" (${name})`);
      } else {
        await hubspot("POST", `/crm/v3/properties/${object}`, createBody(p, name));
        console.log(`  + created "${p.label}" (${name})`);
        if (p.name !== name) {
          p.name = name;
          namesChanged = true;
        }
      }
      counts.created++;
    }
  }

  if (namesChanged && !DRY_RUN) {
    writeFileSync(FILE, JSON.stringify(spec, null, 2) + "\n");
    console.log("\nSaved internal names to hubspot/properties.json.");
  }
  console.log(
    `\n${DRY_RUN ? "Would create" : "Created"} ${counts.created}, skipped ${counts.skipped}, warnings ${counts.warnings}.`,
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
