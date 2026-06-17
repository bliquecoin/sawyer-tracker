# Sawyer Tracker

A local-first phone-friendly tracker for Sawyer's seizures, Epibrom, Phenomav, and MCT oil C8/C10.

## Run Locally

```sh
python3 -m http.server 4173
```

Open:

```text
http://127.0.0.1:4173
```

The app stores records in the browser with IndexedDB and can work offline after the first load.

## Current Features

- Seizure logging with timer, duration, severity, symptoms, cluster flag, trigger, recovery, and notes
- Daily medication and supplement tracking
- Preloaded schedule for Epibrom morning/night, Phenomav morning/night, and MCT oil C8/C10 daily
- Long-term timeline
- Local observations for seizure gaps, milestones, time-of-day patterns, missed/late dose context, and MCT oil context
- Reminder permission and in-app reminder checks
- Installable PWA shell
- JSON backup/import and CSV export

## Supabase Sync

The app is local-first. It saves to IndexedDB immediately, then syncs with Supabase when configured and signed in.

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

Replace the two email placeholders with the emails that will sign in on each iPhone. Copy the returned `household_id`.

### 2. Configure the App

In `config.js`, fill:

```js
window.SAWYER_SUPABASE_CONFIG = {
  supabaseUrl: "https://udlgabqdepersvsrqkzj.supabase.co",
  supabaseAnonKey: "sb_publishable_vV7AXKL97-pfcL5EI5l_aA_la_DCyTL",
  supabaseHouseholdId: "f81c536a-0b14-4793-80df-4d92707afb70"
};
```

The publishable key is public. Access is protected by Supabase Auth plus Row Level Security.

### 3. Auth Settings

In Supabase Auth URL settings, add the deployed app URL as an allowed redirect URL. Use the same URL you and your partner will open on your iPhones.

### 4. Deploy for iPhone

The app must be served over HTTPS for reliable install/offline behavior on iPhone. Good options:

- GitHub Pages
- Netlify
- Vercel
- Cloudflare Pages

After deployment:

1. Open the HTTPS URL in Safari on each iPhone.
2. Sign in with the allowed email.
3. Use Safari Share > Add to Home Screen.
4. Open from the Home Screen and tap Backup > Sync Now.
