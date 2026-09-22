# Sawyer Tracker

A phone-friendly tracker for Sawyer's seizures, Epibrom, Phenomav, and MCT oil C8/C10, using Supabase as the shared source of truth.

## Live App

Open on iPhone in Safari:

```text
https://bliquecoin.github.io/sawyer-tracker/
```

Then use Share > Add to Home Screen.

## Run Locally

```sh
python3 -m http.server 4173
```

Open:

```text
http://127.0.0.1:4173
```

Connect the household once while online. The installed app then caches its shell, saves care records to IndexedDB, and can reopen and record entries offline. A banner identifies changes waiting to sync. Keep the app open or reopen it when connected to upload pending changes; background sync while the app is closed is not guaranteed.

Unfinished seizure, note, vet, blood-test and setup forms are saved as device-local drafts. They survive navigation, refresh and reopening. Saving clears the relevant draft; **Discard draft** removes it explicitly. Drafts are private to that browser and household and are not shared between phones.

## Supabase Keep-Alive

Free Supabase projects can pause after a week of low activity. The
private `bliquecoin/sawyer-tracker-keepalive` repository makes three
authenticated, read-only database requests twice daily. Keeping this scheduler
in a private repository prevents GitHub's 60-day inactivity rule for scheduled
workflows in public repositories from disabling it.

This reduces the likelihood of inactivity pausing, but it is not a replacement
for backups. Free projects should still be exported periodically.

## Current Features

- Seizure logging with minutes/seconds entry (including durations above two minutes), severity, symptoms, automatic cluster detection, trigger, recovery, and notes
- Daily medication and supplement tracking, optional Given confirmations with carer name and time, and a shared setting to require explicit confirmation
- Preloaded schedule for Epibrom morning/night, Phenomav morning/night, and MCT oil C8/C10 daily
- Long-term timeline
- Local observations for seizure gaps, milestones, time-of-day patterns, missed/late dose context, and MCT oil context
- Background Web Push alerts for each 5-day seizure-free heart, matching the longest completed episode gap, and reaching the historical average gap
- Private vet PDF storage shared between both phones
- Installable PWA shell
- Complete ZIP backup/restore (including vet PDFs) and CSV export with recorder and sync status

## Push Notifications

Push alerts use the standards-based Push API, a persistent service worker, Supabase Edge Functions, and a once-per-minute Supabase Cron job. Each installed phone registers its own encrypted Web Push subscription.

On iPhone, push requires iOS 16.4 or later and Sawyer Tracker must be opened from a Home Screen installation. Open **More > Seizure-free push alerts**, choose **Enable Push Alerts**, and then use **Send Test** to confirm delivery.

The average-gap alert is a historical tracking cue, not a medical prediction. It is only enabled after at least two completed seizure-episode gaps are available.

The VAPID public key belongs in `config.js`. `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, and `VAPID_SUBJECT` must be stored in Supabase Edge Function secrets; never commit the private key.

## Supabase Sync

Supabase is the shared source of truth for Beau and Janelle's phones. Device storage also holds drafts and pending changes. The app retries when connectivity returns, when reopened, and every 30 seconds while visible. New writes are persisted locally before upload; a failure remains visibly pending rather than being reported as shared.

Updates use a conditional `updated_at` comparison against the version originally edited. If another phone changed the record, **More > Changes on this device** shows both versions. Choose **Use shared version** or **Keep this device's version**. Retries carry a stable mutation ID so a lost success response does not create a duplicate. New dose IDs are derived from the date, schedule and time slot; older dose IDs are discovered before insertion. Both phones should run the current release to benefit from these protections.

The normal reset, sign-out and household-change flows are blocked while changes are unsynced. Browser/OS storage deletion can still remove local drafts and pending changes. Device recovery mode does not claim to save durable offline entries when IndexedDB is unavailable.

### Household Access Code

Sawyer Tracker does not require Supabase email sign-in for normal use. Each phone enters the shared household access code once, stores a hash on that device, and sends it to Supabase with each sync request. Row Level Security checks that hash before any records are read or written.

Do not commit the plain access code or its hash. Store the hash only in the private Supabase table created by the household access migration.

### 1. Create Supabase Project

Create a Supabase project, then open the SQL editor.

Run:

```text
supabase/schema.sql
```

Then edit and run:

```text
supabase/seed-household.sql
```

The email member rows are still supported for backwards compatibility, but normal phone access uses the household access code. Copy the returned `household_id`.

### 2. Configure the App

In `config.js`, fill:

```js
window.SAWYER_SUPABASE_CONFIG = {
  appUrl: "https://bliquecoin.github.io/sawyer-tracker/",
  supabaseUrl: "https://udlgabqdepersvsrqkzj.supabase.co",
  supabaseAnonKey: "sb_publishable_vV7AXKL97-pfcL5EI5l_aA_la_DCyTL",
  supabaseHouseholdId: "f81c536a-0b14-4793-80df-4d92707afb70"
};
```

The publishable key is public. Access is protected by Row Level Security plus the shared household access code.

Vet PDFs are stored in the private `sawyer-vet-documents` Storage bucket.
Uploads, short-lived viewing links, and permanent deletion are handled by the
`sawyer-vet-documents` Edge Function. PDFs are limited to 20 MB and are included
in complete ZIP backups. PDF access, backup and restore require a connection.

### 3. App URL

The deployed app URL is:

```text
https://bliquecoin.github.io/sawyer-tracker/
```

Use this URL when installing the app on iPhone.

### 4. Deploy for iPhone

The app must be served over HTTPS for reliable install/offline behavior on iPhone. Good options:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages

After deployment:

1. Open the HTTPS URL in Safari on each iPhone.
2. Enter the shared household access code.
3. Use Safari Share > Add to Home Screen.
4. Open from the Home Screen and tap Backup > Sync Now.

## Development and verification

The active stylesheet is `styles.css`; earlier snapshots are retained in Git history.
Browser storage, draft recovery and conditional cloud writes live in
`lib/tracker-storage.js`, `lib/tracker-drafts.js` and `lib/tracker-sync.js`.
Pure calculations live in `lib/tracker-core.js`; `app.js` owns the screens and user flows.
No database migration is required for this release: conditional updates use the existing primary keys, `updated_at` columns and RLS policies.

```sh
npm ci
npx playwright install chromium webkit
npm run check
npm test
npm run test:e2e
```

Browser tests run in Chromium and iPhone-sized WebKit using a fake Supabase client;
they never write production care data. Coverage includes draft recovery, long-duration
edits, offline queues, retry, conflict review and named dose confirmation. Sync unit
tests exercise simultaneous writers and a lost response after the server commits.
The offline service-worker reopening test runs in Chromium. Before publishing, also
check Home Screen installation, offline reopening and push delivery on a physical
iPhone; desktop WebKit emulation is not a substitute for those OS behaviours.
