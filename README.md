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

The app uses a small browser cache so it opens quickly, but new care records require a connected Supabase household access code.

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

Supabase is the shared source of truth for Beau and Janelle's phones. The browser cache is only used to render the app quickly and recover from Safari storage quirks.

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
