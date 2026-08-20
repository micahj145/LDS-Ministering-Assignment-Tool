# LDS Ministering Assignment Tool

## What this is

A single-page web app for planning ward ministering assignments (Church of Jesus Christ of
Latter-day Saints). Imports member/household data exported from LCR (lcr.churchofjesuschrist.org)
as CSV, lets a ward leader draft and annotate companionship pairings, geocode households for
distance-aware planning, and track both a "Current Assignments" list and a separate "Proposed"
workspace for drafting changes before they go live.

The entire app is one file: **`ministering_tool.html`**. No build step, no framework — vanilla
JS, inline `<style>`/`<script>`. Open it directly in a browser to run it. `index.html` is a
one-line redirect to it, for a clean root URL if hosted (e.g. GitHub Pages).

## Architecture today

- **State**: a single in-memory object `S` (`members`, `households`, `current`, `proposed`,
  `activityLog`), synced as one whole document to a shared Firestore backend (see below) on
  every mutation.
- **Import**: CSV upload for Members, Households, and (optionally) an Assignments CSV, with
  column-mapping UI. Re-imports are a non-destructive merge/sync (adds new, updates existing,
  confirms before removing anyone missing from the file) — not a wipe-and-replace.
- **Geocoding**: household addresses are geocoded via Nominatim (OpenStreetMap), rate-limited to
  ~1 req/sec, cached in `S.households[].lat/lng`. Used to compute minister-to-minister and
  minister-to-household distances shown on companionship cards.
- **Notes**: multi-author, dated notes arrays on members, households, and companionships (both
  current and proposed) — not a single free-text field.
- **Current vs. Proposed**: two independent, fully-editable companionship lists (add/edit/delete/
  notes/distances all work on both). "Promote All from Proposed" copies Proposed into Current
  (replacing it) without touching Proposed. "Copy to Proposed" goes the other direction.
- **Session export/import**: a "Share / Collaborate" panel can still export the whole `S` object
  as a dated JSON file and load it back in — kept as a standing manual backup/portability option
  even though it's no longer the primary sync mechanism (see below).

## Backend: Firebase (Auth + Firestore)

The app previously went through a full migration to Supabase (Postgres) for shared multi-user
storage — auth, a five-table relational schema, RLS policies, an audit-log trigger, admin email
notifications via Resend. That version worked, but **Supabase's free tier paused the project
after a period of low activity**, which is exactly the usage pattern a ward-planning app has
(bursty, not daily). Rather than pay for Supabase or fight the pausing, the app was rebuilt on
Firebase, deliberately choosing a *simpler* data model than the Postgres one had.

### Why Firebase over Supabase (again)
Per Firebase's own docs, the free **Spark** plan is purely usage-metered (daily read/write/
storage quotas) with **no inactivity-based pausing or auto-deletion** — structurally different
from the failure mode that hit the Supabase project. No credit card is required for Spark. See
`FIREBASE_SETUP.md` for the one-time console setup (has to be done by a human with a Google
account — it can't be provisioned by an AI session).

### Live project
- Project ID: `pb1-ward-council-planning`
- Firestore edition: **Standard** (Enterprise requires the paid Blaze plan even within its own
  free quota — defeats the point of staying off billing).
- The `firebaseConfig` values (apiKey, authDomain, etc.) are wired directly into
  `ministering_tool.html` — client-safe, not secrets, same as the old Supabase anon key wasn't.
- Auth provider, Firestore database, and `firestore.rules` have all been set up against this
  project per `FIREBASE_SETUP.md`.

### Why a single-document blob instead of Firestore collections per entity
Rather than re-doing the old five-table relational shape as five Firestore collections (which
would mean re-deriving something like the old RLS policies as Firestore security rules, per
collection), the whole ward dataset — `members`, `households`, `current`, `proposed`,
`activityLog` — lives in **one Firestore document**: `wardData/shared`. This is much closer to
the *original* pre-Supabase architecture (a single in-memory `S` object), just auto-synced to the
cloud instead of manually exported/emailed as a JSON file. Tradeoffs, both deliberate:
- **Last-write-wins on the whole document**, same as the old Supabase RLS model ("single shared
  ward dataset" — this was already the accepted model, not a new risk). Two people editing at
  the literal same moment can still clobber each other; a manual "↻ Refresh" button next to Sign
  Out lets anyone pull the latest before editing if that's a concern.
- **1 MiB Firestore document size limit.** Comfortably above the current dataset size; worth
  monitoring if notes accumulate heavily over years. If it's ever approached, the fix is
  splitting into a couple of documents — not a full redesign.
- **No Cloud Functions.** Firebase requires the paid Blaze plan (even though its free quota would
  likely cover this app) for server-side triggers. So there's no server-side equivalent of the
  old `handle_new_user()` trigger or the Resend email-on-signup notification — the client creates
  its own `profiles/{uid}` doc at signup instead, and `firestore.rules` carries the real security
  weight for preventing self-approval/self-promotion (see the comments in that file). Admins see
  pending signups in the Admin tab rather than getting emailed about them.
- **Client-side activity log, not a server-side audit trigger.** `S.activityLog` is a capped
  (200-entry) array of `{ ts, user }`, appended to on every save and stored as part of the shared
  document. It shows *who saved changes and when*, not a per-field trail like the old Postgres
  `log_audit()` trigger gave ("added a note on household X"). A trusted-small-group tradeoff, not
  tamper-proof — acceptable for this app's scale.

### Auth
Email/password sign-up and sign-in, an admin-approval gate (new signups start `pending` and see
an "Awaiting Approval" screen), and an in-app Admin tab (admin-only) to approve/deny users, plus
a client-side activity log. **No mandatory MFA** in this version (an earlier, never-committed
draft had TOTP 2FA — it was superseded by this simpler flow, not retained). The bootstrap admin
email (`micahj145@gmail.com`) is hardcoded in both `ministering_tool.html` (`ADMIN_EMAIL`) and
`firestore.rules` (`isBootstrapAdminEmail()`) — keep those two in sync if it's ever changed.

### Files
- `ministering_tool.html` — the app. `firebaseConfig` near the top of the `<script>` block holds
  placeholder `REPLACE_ME` values until the real project's config is wired in (see
  `FIREBASE_SETUP.md`) — these are client-safe values, not secrets; real access control is
  entirely in `firestore.rules`.
- `firestore.rules` — the actual security boundary: who can read/write `wardData/shared`, and who
  can create/update `profiles/{uid}` docs (with the self-approval/self-promotion guardrails).
- `FIREBASE_SETUP.md` — step-by-step one-time console setup (project, Auth provider, Firestore
  database, deploying the rules, registering a web app for the config values).
- `migrations/`, `supabase_schema.sql` — **historical**, from the abandoned Supabase phase. Left
  in the repo for reference; not used by the current app.

## Working conventions observed in this project

- The user (Micah) tests UI changes himself in his own browser before asking for a commit — don't
  assume a feature is "done" until he's confirmed it, even if automated/headless testing passed.
- When automated browser testing is useful, this environment has Playwright available, with
  Chromium under `/opt/pw-browsers` in the Claude Code sandbox. Useful for headless dry-runs
  (e.g. mocking `window.firebase` to test the auth/sync flow's view transitions and persistence
  layer without touching a live project) before asking the user to verify for real.
- Session export JSON files, LCR CSV exports, and any Supabase-era `seed.sql` all contain real
  member PII (names, addresses, phone numbers, personal notes about family situations) and must
  **never** be committed — see `.gitignore`. This repository is **public** on GitHub, so this
  matters more than it would for a private repo. When picking "the latest" export among several
  loose files in the project root, sort by actual file mtime, not filename — export filenames are
  date-stamped by day, not by exact time, so same-day exports need mtime to disambiguate.
- Only `ministering_tool.html`, `index.html`, `firestore.rules`, `FIREBASE_SETUP.md`, and this
  file should ever be staged/committed — the project root otherwise accumulates loose data export
  files that must stay untracked.
