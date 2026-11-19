# Connecting Lumen Console to HubSpot

This guide gets an access token for a **HubSpot developer test account**, so Lumen Console can read and write companies, contacts, deals, notes, tasks and custom properties there.

HubSpot no longer lets you create "legacy private apps". Instead, an app is a small **project** (two config files) that you upload with the HubSpot CLI and install into one account. Ours lives in [`hubspot/app/`](app/), and its permissions ("scopes") are listed in [`hubspot/app/src/app/app-hsmeta.json`](app/src/app/app-hsmeta.json).

Based on HubSpot's developer docs for developer platform 2025.2, read 19 Nov 2026.

## What you need

- A HubSpot **developer account** (where apps are built).
- A **developer test account** inside it (where the app is installed and tested).
- Node 20 or newer (already installed for this project).

Nothing is installed globally: every CLI command below runs through `npx`.

## Step by step

### 1. Create a developer test account (skip if you have one)

In your HubSpot developer account, click **Development → Testing → Test accounts → Create developer test account**. A test account expires after 90 days without API calls.

### 2. Get a personal access key for the CLI

This key lets the CLI upload the app for you. It is **not** the token the app uses.

In your developer account, click **Development → Keys → Personal access key**, generate one and copy it.

### 3. Sign the CLI in

In Terminal, from the `lumen-console` folder, run:

```bash
npx -p @hubspot/cli@latest hs account auth
```

Paste the personal access key when asked. The CLI saves it in its own settings file in your home folder (`~/.hscli/config.yml`), outside this project, so it can never be committed to git.

> HubSpot's docs show a global install (`npm install -g @hubspot/cli`). We use `npx -p … hs` instead, which runs the same CLI without installing it. If it fails, tell Claude rather than installing globally.

### 4. Upload the app

```bash
cd hubspot/app
```

```bash
npx -p @hubspot/cli@latest hs project upload
```

This builds the project in your developer account. If it reports a problem with a config file, paste the error to Claude.

### 5. Install it in the test account

In your developer account, click **Development → Projects → lumen-console → Overview → Project components → Lumen Console → Distribution** tab. Click **Add test install(s)**, then **Install** next to your developer test account, and approve the permissions.

### 6. Copy the access token into `.env.local`

On the same **Distribution** tab, after the install, click **Show** next to the access token and copy it.

Open `.env.local` in this project and add one line (paste your token after the `=`):

```
HUBSPOT_ACCESS_TOKEN=
```

Never paste the token into chat, Slack or a commit. `.env.local` is already ignored by git.

### 7. Test the connection

From the `lumen-console` folder:

```bash
npm run hubspot:test
```

It prints the names of 5 companies from the test account. Then create the Lumen Console custom properties:

```bash
npm run hubspot:setup -- --dry-run
```

```bash
npm run hubspot:setup
```

The first command only shows what would change; the second makes the changes.

## Scopes the app asks for

| Data | Scopes |
|---|---|
| Companies | `crm.objects.companies.read`, `crm.objects.companies.write` |
| Contacts | `crm.objects.contacts.read`, `crm.objects.contacts.write` |
| Deals | `crm.objects.deals.read`, `crm.objects.deals.write` |
| Custom properties and groups | `crm.schemas.companies.read/write`, `crm.schemas.contacts.read/write`, `crm.schemas.deals.read/write` |
| Notes and tasks | No separate scope is listed in HubSpot's scope reference; notes and tasks are attached to companies, contacts and deals, and are expected to be covered by the scopes above. **Check with a test note and task before relying on this.** |

**Changing scopes later:** edit `app-hsmeta.json`, run `hs project upload` again, then reinstall from the **Reinstall URL** on the Distribution tab. The token stays the same; rotate it about every 6 months (same tab).

## Custom properties

[`properties.json`](properties.json) lists the Lumen Console properties, all in the property group **Lumen Console**. `npm run hubspot:setup` creates any that are missing and skips any that exist. It never deletes or changes a property. Properties made by hand in HubSpot are matched by their label, and their internal names are saved back into `properties.json`.

**We reuse HubSpot's built-in properties where one exists**, instead of creating a duplicate. These are marked `"builtIn": true` in `properties.json`, keep HubSpot's internal name and stay in HubSpot's own property group. Today that is:

| Our field | HubSpot built-in | Internal name |
|---|---|---|
| Renewal date (company) | Next Renewal Date | `hs_next_renewal_date` |

The other properties are ours: their internal names start with `lumen_` and they live in the **Lumen Console** group.

### Percent values

HubSpot stores percentage properties as decimals: 0.42 displays as **42%**, and 42 would display as **4200%**. **Decision (19 Nov 2026):** the sync sends our fractions unchanged (0.42 for 42%). Before the full sync, test one record and confirm HubSpot shows "42%", not "4200%" or "0.42%".
