# Setting up the Firebase project

`ministering_tool.html` now talks to Firebase (Auth + Firestore) instead of
Supabase. Firebase can't be created by an AI session on your behalf — it
needs your own Google account — so here's the one-time setup. Should take
about 10 minutes.

## 1. Create the project

1. Go to <https://console.firebase.google.com> and sign in with the Google
   account you want to own this project.
2. Click **Add project**. Name it something like `ministering-tool` (the
   name is cosmetic — Firebase will generate a unique project ID).
3. You can decline Google Analytics for this project — it's not needed.
4. Wait for project creation to finish, then open the project.

This creates the project on the free **Spark** plan by default. Spark has
no credit card requirement and, per Firebase's own docs, no inactivity-based
pausing or deletion — the specific problem you hit with Supabase's free tier
shouldn't apply here. Stay on Spark (don't upgrade to Blaze) — this app is
built to work entirely within it.

## 2. Enable Email/Password auth

1. In the left sidebar: **Build -> Authentication**.
2. Click **Get started**.
3. Under **Sign-in method**, choose **Email/Password**, toggle it **on**,
   and save. Leave "Email link (passwordless sign-in)" off.

## 3. Create the Firestore database

1. In the left sidebar: **Build -> Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode** (not test mode — we're deploying
   real security rules in the next step, so production mode is fine from
   the start).
4. Pick a location close to you (e.g. `us-east1` / `nam5`). This can't be
   changed later, but for a single-ward app any US region is fine.

## 4. Deploy the security rules

1. Still in **Firestore Database**, click the **Rules** tab.
2. Delete the default contents and paste in the full contents of
   `firestore.rules` (in this repo).
3. Click **Publish**.

These rules gate everything: only an approved user can read/write ward
data, and only an admin can approve/deny/promote other users — a client
can't self-approve even though there's no server-side trigger doing that
check (see the comments at the top of `firestore.rules` for why that's
still safe).

## 5. Register a Web App and get your config

1. In the project, click the gear icon next to **Project Overview** ->
   **Project settings**.
2. Scroll to **Your apps**, click the **</>** (Web) icon.
3. Give it a nickname (e.g. `ministering-tool-web`). You do **not** need
   Firebase Hosting for this — the app is a single HTML file you'll host
   however you already were (GitHub Pages via `index.html`, or just open
   it locally / share the file).
4. Firebase will show you a `firebaseConfig` object with values like
   `apiKey`, `authDomain`, `projectId`, `storageBucket`,
   `messagingSenderId`, `appId`.
5. Send me those six values (they're safe to share/paste — they're the
   client-facing config, not a secret, the same way the old Supabase
   anon key wasn't a secret) and I'll wire them into
   `ministering_tool.html` in place of the `REPLACE_ME` placeholders.

## 6. Create your (admin) account in the app

Once the config is wired in and the file is live:

1. Open the app, click **Sign Up**, and sign up with
   **micahj145@gmail.com** (must match exactly — it's hardcoded as the
   bootstrap admin in both `ministering_tool.html` and
   `firestore.rules`).
2. That account is auto-approved and auto-admin — no one needs to approve
   you. Every other ward leader who signs up afterward will show up under
   **Admin -> Pending Requests** for you to approve.

## What's intentionally not included

- **No Cloud Functions.** Server-side triggers (like the old
  `handle_new_user()` Postgres trigger, or emailing admins on signup)
  require Firebase's paid Blaze plan, even though Blaze's own free quota
  would likely cover this app's usage. We stayed off Blaze entirely to
  avoid needing a credit card on file. The tradeoff: an admin finds out
  about a pending signup by checking the Admin tab, not by email.
- **No live/realtime sync.** Data loads on sign-in and on manual
  "↻ Refresh" — not pushed live to other open tabs. This was a deliberate
  choice (not a limitation you need to work around), matching what we'd
  already decided for the Supabase version.
- **1 MiB Firestore document size limit.** Because the whole ward dataset
  is one document, there's a hard ceiling — comfortably above where
  you're at today, but worth knowing about if the ward's data (especially
  notes) grows a lot over the years. If it ever gets close, the fix is
  splitting into a couple of documents, not a full redesign.
