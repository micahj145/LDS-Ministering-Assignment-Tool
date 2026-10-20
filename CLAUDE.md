# LDS Ministering Assignment Tool

## What this is

A single-page web app for planning ward ministering assignments (Church of Jesus Christ of
Latter-day Saints). Imports member/household data exported from LCR (lcr.churchofjesuschrist.org)
as CSV, lets a ward leader draft and annotate companionship pairings, geocode households for
distance-aware planning, and track both a "Current Assignments" list and a separate "Proposed"
workspace for drafting changes before they go live.

The entire app is one file: **`ministering_tool.html`**. No build step, no framework — vanilla
JS, inline `<style>`/`<script>`. Open it directly in a browser to run it. `index.html` redirects
to it, for a clean root URL.

It's deployed via **GitHub Pages** off `main` in this repo, so every push republishes the site
within a minute or so — that's how the ward team gets updates.

## Architecture today

- **State**: a single in-memory object `S` (`members`, `households`, `current`, `proposed`,
  `activityLog`), synced as one whole document to a shared Firestore backend (see below) on
  every mutation.
- **Import**: CSV upload for Households, then Members (that order — households first means the
  member import can link people to a household immediately), with column-mapping UI. Re-imports
  are a non-destructive merge/sync (adds new, updates existing, confirms before removing anyone
  missing from the file) — not a wipe-and-replace. There was a third Assignments CSV import; it
  was never used and was removed, since assignments are built in the app (Proposed → Promote, or
  "+ Add") and that import replaced Current Assignments wholesale. It was the only writer of the
  optional `district` field, which older companionships may still carry and still display.
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

### Covenant Path Progress (formerly Ward Council Collaboration)
A tab of shared watch-lists, visible to everyone with access (both roles) and editable by all of
them — no admin gating. Three groups, defined in the `GROUPS` const: **New Members** and
**Returning Members** pick people out of `S.members`; **People Being Taught** (key `mission`,
formerly Ward Mission, so old entries carry over) takes free-typed names,
since missionary contacts aren't in ward records. Each entry carries *two* independent comment
threads, **Goals** and **Notes**, both dated and signed by author.

- Stored as `S.groups` — a fourth top-level key in the shared document alongside members/
  households/current/proposed. `normalizeGroups()` always returns all three lists, so a document
  written before this feature (which has no `groups` key at all) loads fine; the same guard runs
  on session-file import.
- Entries denormalize like companionship records do: `memberId` links to the ward list so a
  rename follows through, and `name` is kept beside it so the entry still reads correctly if that
  member is later deleted from Members. Deleting a member does **not** remove them from a group.
- The Goals/Notes threads reuse the existing notes modal rather than duplicating it.
  `_notesCtx.field` selects which array is being edited and defaults to `'notes'`, so every
  pre-existing call site (`openNotesModal('member', id)` etc.) behaves exactly as before.
- Clearing data: groups are wiped only by **Clear All Data**, not by clearing members or
  households — the council's goals and notes aren't member or household data.

**Notes written elsewhere are pulled into a group entry's Notes thread** (`groupLinkedNotes()` /
`groupMergedNotes()`), so the council sees everything said about a person in one place. Sources:
their own member record, their household, companionships they minister in or that serve their
household, and *any* note anywhere whose text mentions their name.

- **Pulled in live, never copied.** Copying would duplicate the text, drift when the original is
  edited, miss anything written before the person joined the group, and grow the single shared
  document. The tradeoff is that a pulled-in note disappears from the group if its original is
  deleted, which is the correct behaviour anyway.
- **Name matching** (`noteMentionsName()`) is deliberately generous — a missed note is worse than
  a stray one. It matches when every significant part of the name appears in any order ("Daniel
  Brooks" and "Brooks, Daniel" both hit), or when the surname alone appears *capitalised* in the
  original text — that capitalisation check is what keeps "a brown couch" from matching a member
  named Brown. `NAME_STOPWORDS` drops words like "family" and "Elder" that say nothing about
  which person is meant.
- **Dismissing a false positive** (`dismissLinkedNote()`) appends its key to `entry.hiddenLinks`,
  hiding it from that group only; the original note is untouched. Keys are `source::noteId`, with
  a text/date fallback for any note predating note ids.
- Only the **Notes** thread aggregates. Goals stay purely the council's own.

### New Member Move Ins / Move Outs — Move Ins
A tab, visible to both roles, for following households that move into the ward until their
ministering is in place, and for removing people who have moved out.

- **Storage**: `S.groups.movein` — a fourth `GROUPS` entry flagged `tab: 'moves'` (so
  `renderCouncil()` skips it and `renderMoves()` draws it) and `byHousehold: true`. Living in
  `S.groups` means it saves, exports, imports and clears exactly like the council groups.
- **One entry per household**, not per person: `{ id, householdId, name, people: [{ memberId,
  name, position, age, moveInDate }], moveInDate, addressNote, status, statusBy, statusDate,
  notes, nextSteps, hiddenLinks, addedBy, addedDate, source }`. `groupEntryName()` follows
  `householdId` so a household rename shows through.
- **Status**: `MOVEIN_STATUSES` — new / contacted / pool (ministering pool decided) / assigned
  (ministering assignments done). Stamped with who set it and when.
- **Pool** on each row reads and writes the household's own `hh.inPool` (true / 'maybe' /
  false) — the same field the Households tab's In Pool / Maybe / Out badge cycles — so there is
  no separate copy to drift. It's independent of Status; picking "Ministering pool decided"
  doesn't set it, and setting it doesn't change Status.
- **Notes** behave like a council group's: `groupLinkedNotes()` hands household entries to
  `moveInLinkedNotes()`, which pulls in notes for every person in the entry plus the household.
- **Next Steps** is a third thread on the shared notes modal (`_notesCtx.field = 'nextSteps'`).
  Each step can carry `tags: [{ uid, name }]`. The nav button and a banner count households
  whose *latest* step tags the current user and aren't at "assigned" yet.
- **Who can be tagged — `S.users`**: a names-only `{ uid, name }` list stored in the shared
  document, because `firestore.rules` only lets admins read `profiles/`. Every user adds
  themselves on sign-in (`registerSelfInDirectory()`), and an admin opening the Admin tab
  rebuilds it from the approved profiles (`syncUserDirectory()`), which also drops denied users.
  Deliberately no emails in it. A user who hasn't signed in since this shipped isn't taggable
  until they do (or an admin opens the Admin tab).

**Fetch/Print/Download + Import buttons**: each report card has a **Fetch/Print/Download** link
(`.lcr-fetch`, `data-report="in|out"`) that opens the LCR report page in a new tab, using
`LCR_REPORT_URLS` (members-moved-in / members-moved-out under lcr.churchofjesuschrist.org/mlt/report;
an empty URL renders the link disabled). The user signs in to LCR, saves the report as a PDF,
then taps **Import** (the file picker). The app can't read LCR directly — it's a separate
signed-in site.

**Covenant Path Progress → import from LCR (printed web pages)**: one "Import from LCR" card with
Fetch/Print/Download + Import for each list (`CP_IMPORTS`: new, returning, mission). LCR's
progress-record pages (`LCR_REPORT_URLS['cp-new' | 'cp-returning' | 'cp-mission']`; `tab=recentConverts` and
`tab=returningMembers`, `tab=peopleBeingTaught`; an empty URL would render the button disabled) have no export, so
users print the page to PDF (laptop and Android Chrome tested for New Members: same text, same order).
- `pdfTextLines()` rebuilds lines from pdf.js runs (grouped by y; touching runs glued so a phone
  print's split "é" rejoins; NFC).
- `parseCovenantPage()`: a card ends at its first anchor line (`CP_CARD_ANCHOR`: "View Details" or
  "Attended Sacrament Meeting" — some cards have no View Details). The name is the nearest
  `looksLikeName()` line above it (no digits, ≤7 capitalised words/particles, not a page label),
  within 4 lines and not before the previous card; the lines in between are the subtitle (`detail`,
  e.g. "Member for 3 months"). Attendance/friends counts are deliberately NOT read or stored
  (Micah: LCR already shows them). All three tabs use the same card layout (checked with real prints);
  People Being Taught cards' subtitle is "First Taught - <date>".
- New/Returning (`matchMembers`): `matchReportName()` matches "First Middle Last [Jr]" against
  Members' "Last, First" (surname tokens end the name, suffixes ignored both sides; first given name
  before it) → `match`/`several` ticked; looser overlap → `possible`; else `none` (addable unlinked).
  People Being Taught: every name found ticked, added by name.
- Review: entries already on the list get `lcr` refreshed; entries not on the page are listed with an
  unticked Remove. Saved per entry: `lcr: { detail, asOf }` (older entries: `memberFor`), shown by
  `lcrSnapshotHTML()`. `lcr` changes don't notify followers.

**Importing the LCR "Members Moved In" report (PDF)**:
- pdf.js 3.11.174 is loaded lazily from cdnjs, with jsDelivr as a fallback (`PDFJS_SOURCES`),
  only when someone imports. The PDF is parsed in the browser and never uploaded.
- `parseMoveInReport()` finds the columns from each page's header row ("Name", "Age", "Move In
  Date", "Household Position", "Gender", "Street Address", "Phone Number") and assigns each text
  run to the last column starting left of it. A line with Name plus Age/Move In Date starts a
  person; address-only lines are the wrapped street/unit/city lines. It stops at "Count:" and
  reports that count, so a mismatch is shown as a warning. A line ahead of the street number
  (a community or building name) is split off into `addressNote` so the address still geocodes.
  Positions seen in LCR's report: Primary Household Contact, Spouse, Household Member.
- `buildMoveInPlan()` groups people into households by address (`addrKey()`), matches people
  to Members by `normNameKey()`, and households first via a matched member's household, then
  by address. New households are named LCR-style ("Last, First & Spouse").
- **Same address, different families** (roommates): `moveInUnits()` splits an address's people
  into likely households — anyone already linked stays with their household, a Spouse goes with
  the primary contact whatever their surname, everyone else joins whoever shares a surname part
  (`surnameTokens()` / `sharesFamily()`). Existing households at the address that nobody joined
  come back as empty units. If that leaves more than one unit and any of them has no household
  yet, the item is `ambiguous`: the review asks **One household** or **Separate households at
  the same address**, and Add stays disabled until every ticked one is answered.
  `expandMoveInItem()` turns the answer into ordinary items at apply time. When the records
  already settle it (everyone linked to distinct households), nothing is asked.
- **Split…** on a Move Ins row (shown when its people fall into more than one surname group)
  fixes roommates already saved together: the primary contact's group keeps the household and
  entry with its status and threads; each other group gets a new household at the same address
  (coordinates copied, Pool left Out) and a fresh entry. The kept household is only renamed if
  the import had named it. Deleting a member (by hand or Moved Out) also drops them from Move
  Ins rows (`dropFromMoveIns()`).
- The review lets you untick households; applying adds missing members/households, only
  *fills blanks* on existing records (never overwrites), adds or extends the Move Ins entry,
  then geocodes any touched household without coordinates through the existing
  `geocodeAddress()` (rate-limited Nominatim).

**Importing the LCR "Members Moved Out" report (PDF)**:
- Both report parsers share `parseLcrTable(pages, columns, anchors)`; each report only defines
  its columns (`MOVEIN_COLUMNS`, `MOVEOUT_COLUMNS`) and which ones mark the start of a person.
- Moved Out columns: Name, Birth Date, Move Date, New Unit ("Deceased" also appears there).
  **No address**, so `buildMoveOutPlan()` matches by `normNameKey()` and cross-checks the age
  worked out from the birth date (`ageFromBirth()`) against `member.age`, within a year.
  Levels: *confirmed* (name + age) and *name* (no age on file) start ticked; *age* (ages
  disagree) and *possible* (same surname and first name, different middle) start unticked;
  *none* isn't in Members. Several members with the same name get a picker.
- Households that would be left with no members are offered for removal too (ticked by
  default), with warnings for companionships serving them, household notes, and a Move Ins
  entry (removed along with the household).
- Removal only happens after a `confirm()` naming everyone. It does what `deleteMember()` does
  (drops the name from the household's display list) and warns when a removed person ministers
  in a companionship — those records keep the name until someone updates them, same as a manual
  delete. Notes on removed members/households go with them.
- Every removal is logged in `S.groups.moveout` (`GROUPS` key `moveout`, `tab: 'moves'`) as
  `{ name, householdName, moveDate, newUnit, removedBy, removedDate }` and shown as the
  **Moved Out** list. A re-import marks those people "Already removed". The birth date is not
  stored.
- The Moved Out list keeps only entries whose `removedDate` is within three months of when the
  page was loaded (`MOVEOUT_KEEP_MONTHS`, `PAGE_LOADED_AT`). `pruneMoveOutLog()` runs in
  `loadAllData()` and saves the shorter list, so old entries are deleted for everyone rather
  than just hidden. An entry with no readable date is kept. Once pruned, a re-import shows
  that person as "Not in Members" rather than "Already removed".

### Tagging and the Notifications tab
- **Every** Notes / Goals / Next Steps thread can tag users. There is only one free-text input
  in the app (the shared notes modal), and its tag picker is now shown for every field. A note
  carries `tags: [{ uid, name }]` when anyone is tagged, plus `authorId` (new since this
  feature; older notes only have `author`, a display name).
- The tag list comes from `S.users` (see Move Ins above: names only, self-registered on
  sign-in, rebuilt by an admin opening the Admin tab).
- **Notifications tab** (`allTaggedNotes()`): every note anywhere that tags the signed-in user
  (members, households, current/proposed companionships, every `GROUPS` list and its goals,
  notes and next steps), newest first, each with an Open button into that thread.
- **Clearing**: items stay until the user clears them. Tagged notes: ✕ per item or **Clear all**
  adds `noteKey`s (`tagNoteKey()`, same format as `functions/tags.js` `noteKey`) to
  `profiles/{uid}.clearedTags` — it hides them for that user only; the note itself is untouched.
  `visibleTaggedNotes()` filters them out of the list, unread count and badge; keys for notes
  that no longer exist are pruned on each save. The server's `unreadCount()` skips them too.
  Feed: ✕ removes that entry (`arrayRemove`), **Clear all** sets `feed: []`.
- **Unread** = dated after the user last opened the tab *and* not written by them
  (`authorId`, falling back to the author name for older notes). The last-opened time is
  `notifSeenAt` on the user's **own profile document**, not the shared ward doc. The existing
  self-update rule allows it (it only pins status/isAdmin/email), so no rules change was needed.
- Counts show on the nav button and, through the Badging API, on the installed app's icon
  (`updateNotifBadges()`): iPhone/iPad Home Screen apps (only once notifications are allowed;
  the tab offers an Allow button, but only when running installed) and installed Chrome/Edge
  apps on Windows/Mac. Android has no badge API; it only dots icons for real notifications.
- No live listener (by design), so the in-app list updates on load or ↻ Refresh. Phone
  notifications (below) cover the "something new happened" part.

### Following households
- Anyone can **🔔 Follow** a household from the Households tab or a Move Ins row. The list is
  `profiles/{uid}.followHouseholds` (own profile; self-update rule allows it).
- **`notifyFollowers`** (Cloud Function, same `wardData/shared` trigger as tags) runs
  `householdChanges(before, after)` from `functions/follow.js` — pure and unit-tested — which
  reports, per household: notes on the household, its members, companionships serving it, and
  its council-list / Move Ins entries; pool, address and phone changes; members added, linked,
  unlinked or removed; assigned / unassigned / companionship removed; Move In status; added to
  or removed from a list; household removed. Each item is `{ hhId, text, link }`; text names the
  household/member and who acted but **never note text**.
- Followers are found with `array-contains-any` (30 ids per query). The editor is skipped via
  `updatedByUid`, which `runSync()` now writes beside `updatedBy`. Items are prepended to the
  follower's `profiles/{uid}.feed` (cap 500, `FEED_MAX`) inside a transaction that re-reads the
  profile, so a Clear made in the app isn't overwritten; a push ("Ana Reyes made 2 updates to households
  you follow.") goes at most every 3 minutes per person (`lastFollowPushAt`) — the feed always
  updates. Push `unread` and the app's unread count both include feed items newer than
  `notifSeenAt`.
- App: `applyFollowState()` / `reloadMyFollowState()` (on sign-in and ↻ Refresh) hold
  `_myFollows` and `_myFeed`; the Notifications tab's **Households you follow** card lists the
  followed households (✕ to unfollow) and the feed. `goToLink()` handles the links:
  `#open=type,id[,groupKey,field]` opens that notes thread (switching to its tab),
  `#tab=name` switches tab; also used when the app is opened with such a hash.
- **Following people on Covenant Path Progress**: each row has 🔔 Follow. The key is the
  member's household id when they're linked to one (`councilFollowKey()`), so it's the same as
  following that household; otherwise `entry:<entryId>` (People Being Taught, unlinked members).
  `followHouseholds` holds both kinds; `householdChanges()` reports group changes under
  `entry:<id>` when an entry has no household; `followKeyName()` names either kind for the chips.
- Keep `householdChanges()` in step with where the app stores things, the same way
  `forEachNote()` must match `allTaggedNotes()`.

### Messages tab: direct messages and restricted notes
Private material can't go in `wardData/shared` (every approved user can read that whole document),
so both live in their own collections, locked down by `firestore.rules` — the database refuses
non-members, not just the UI. Not end-to-end encrypted: the project owner can read them in the
Firebase console (the tab says so). Read live with `onSnapshot` (`startPrivateListeners()` after
sign-in, `stopPrivateListeners()` on sign-out).
- **DMs**: `threads/{id}` `{ participants (2–20 uids), names, createdBy, createdAt, lastAt, lastBy,
  lastByName }` + `threads/{id}/messages/{id}` `{ authorId, authorName, text (≤5000), createdAt }`.
  Rules: only participants read; a participant may add people or remove only themselves (Leave);
  messages are never edited, only deleted by their author; threads are never deleted. Sending is a
  batch (message + thread `lastAt/lastBy`). Starting a conversation with exactly the same people
  reopens the existing one. New members of a conversation see its history (the modal says so).
- **Restricted notes**: `privateNotes/{id}` `{ authorId, authorName, viewers (incl. author),
  viewerNames, sharedAt {uid: iso}, target {type,id,groupKey}, targetKey "type:id:groupKey",
  targetLabel, text, createdAt, updatedAt }`. Added from the Notes window of a household, member,
  companionship or group entry (shown only for the `notes` field, not goals/next steps); also listed
  on the Messages tab with Open. Only the author edits text/viewers or deletes. `sharedAt[uid]` is
  set when someone is added, so a later share counts as new for them.
- **Unread** (Messages nav count, and added to the app-icon badge): threads with `lastAt` after
  `profiles/{uid}.threadSeen.{threadId}` from someone else, plus restricted notes shared after
  `restrictedSeenAt` (set to max(now, newest share) when the tab opens, to tolerate clock skew).
- **Push** (`functions/private.js`, tested in `private.test.js`): `notifyMessage` (new message →
  other participants) and `notifyRestrictedNote` (create/update → newly added viewers). Text is
  only "New message from X." / "X shared a restricted note with you." — never content. Link
  `#tab=messages`; the app's `open-tab` handler now routes `tab=`/`open=` hashes via `goToLink()`.
  `badgeCount()` = Notifications unread + Messages unread, used by every push.
- `firebase.json` now includes `firestore.rules`, so `firebase deploy --only firestore:rules` works.

### Ministering: brothers and sisters, current and draft (Oct 2026)
- **Tabs**: Brothers, Current / Draft Ministering Brother Assignments (`S.current` / `S.proposed`,
  tab ids `current` / `propose`), Sisters, Current / Draft Ministering Sister Assignments
  (`S.currentRS` / `S.proposedRS`, tabs `currentRS` / `proposeRS`). `LISTS` maps each list key to its
  tab and label; anything that walks companionships (tagged notes, linked notes, notes modal,
  goToLink, move-out helpers, tags.js, follow.js) uses all four.
- **Access**: everyone sees every tab (`hasFullAccess()` now always true). Roles on the profile:
  `council` | `eq` | `rs` (Admin tab select). `canEditEQ()` (admin or eq) gates brother lists, the
  Brothers pool and the **EQ household pool** (`hh.inPool`, also on Move Ins); `canEditRS()` (admin or
  rs) gates sister lists, both sister pools and the **RS household pool** (`hh.rsPool`). Static
  controls carry `.eq-edit` / `.rs-edit` (hidden) and `.eq-viewonly` / `.rs-viewonly` notices,
  toggled in `applyAccessVisibility()`. Client-side only — the rules don't know roles.
- **Pools**: brothers `m.inPool`; sisters `m.rsPool` (ministering) and `m.rsRecipient` (receives);
  households `hh.inPool` (EQ) and `hh.rsPool` (RS). `sisters()` = female members 18+ (or no age).
- **Companionship shape**: `{ id, m1Id, m1Name, m2Id, m2Name, m3Id?, m3Name?, households: [hhId],
  assignees?: [memberId], extraAssignees?: [names not in Members], notes, position, source? }`.
  Brother cards (`companionshipHTML`) show m3 and extras; `saveEditCompanionship` keeps unedited
  fields. Sister cards (`rsCompanionshipHTML`) show households 🏠 and individual sisters; edited in
  `#rs-modal` (ministers from `sisters()`, ★ pool / ☆ maybe; pickers = RS-pool households +
  receives-pool sisters, plus anything already selected).
- **LCR import** (`parseMinisteringReport`, card on both Current tabs, `LCR_REPORT_URLS.ministering`):
  rows from the cells' stripe fills (shaded rows = fills, plain rows = gaps); a row that continues
  past a page break has no name and joins the previous one. Companionships: groups whose members
  all list each other (assignments = those every member lists); else a one-companion row + its
  companion = a pair; leftovers = solo (`how`). Verified on the Oct 2026 PDF: 464 rows, 61
  companionships, every row reconciles. Side: all-male → EQ, all-female → RS, couples/unknown →
  by assignees (all female → RS) and listed for the user to change. Replace Current (per side,
  per role) keeping id/notes of companionships with the same minister set (`minKey`). EQ:
  assignees → their households; RS: assignees stay individuals (RS households kept from before).

### Identifiers tab (markers beside names)
Four LCR name reports (Members Without Callings, Part-Member Households, YSAs, Birthdays) imported
with Fetch/Print/Download → Import (`LCR_REPORT_URLS['id-…']`; YSA comes from LCR's Organizations
page, unitOrgTypeId=1183). Stored on the records in the shared ward doc: `member.ident = { noCalling, ysa,
partMember, bday: 'MM-DD' }` (birth year never kept), `household.partMember`, and
`S.identMeta[kind] = { at, by, count, households?, unmatched[] }` (now in the `runSync` payload and
`loadAllData`). Each import **replaces** its marker for everyone. `parseIdentReport()` uses
`identRecords()`: per page, the header row ("Name" / "Household") fixes the name column; each data
row is a line with something in the next column; name pieces wrapped onto the lines above/below
(YSA report) join the nearest row; the Birthday List's "Birthday" column gives "1 Jan" → 'MM-DD'.
Match by exact normalised name, else a unique one-sided prefix (`identFind`). Part-member rows
match household names (a member hit marks their household). No header → old line-prefix fallback.
Checked against the real PDFs (Oct 2026): 412 / 51 / 68 / 517 rows, all well formed.
Shown as coloured dots (`.idot`, grey/blue/amber/pink) with a hint on hover/tap (`identTip`):
`identBadgesHTML(member)`, `identDotsHH(hh)` (its own part-member dot plus fainter dots for any
member's markers, names in the hint), `identDotsByName()` for companionship ministers. On Members,
Households, Brothers, Current/Proposed (cards, unassigned and Maybe lists, household picker),
Covenant Path Progress and Move Ins; each of those tabs has a `.ident-legend-slot` filled by
`renderIdentLegends()` (hidden until something has been imported). 🎂 = birthday within the next 14 days
(`BDAY_WINDOW_DAYS`), computed at render time. Filters: Members `id-*`, Households `part-member`.
follow.js doesn't diff `ident`, so imports don't notify followers.

### Unit Statistics tab (LCR report dashboards)
Four LCR reports, printed to PDF and imported with the usual Fetch/Print/Download → Import buttons
(`LCR_REPORT_URLS['st-us' | 'st-qr' | 'st-ki' | 'st-fh']`). Ward totals only, no names. Stored in
its own doc **`wardData/stats`** (rules: same access as `wardData/shared`), written with dotted
field paths (`saveStats()`; creates the doc on first use) so concurrent imports don't clobber:
- `us.snapshots[]` `{ date, by, groups: [{ label, value, items: [{label, value}] }] }` — every Unit
  Statistics import is a new snapshot; the card shows ▲/▼ vs the previous one.
  `parseUnitStats()`: "label  N" lines; section totals are in a different (bold) font.
- `qr.{2026Q3}` `{ quarter, years [this, last, 5-yr-ago], rows: [{ n, section, label, actual,
  potential, pct[3] }], convertCount }` — one per quarter; selector offers (year−3)Q1 … current
  quarter, unimported ones say so. `parseQuarterly()`: row regex over `statLines()`; two-line labels
  (rows 17, 26) join the next line. Convert Detail **names are deliberately not stored**.
- `ki.series.{key}.{2026Q3}` = whole %, `ki.updatedAt/By` — each import adds/updates only its
  quarters. `parseKeyIndicators()` reads **chart geometry** (`pdfPageData()` walks the pdf.js
  operator list with the transform stack): ticked legend boxes (nearest square left of each label
  that isn't white; the colour swatch is further left) give the included indicators in legend
  order (left column, then right); each series is a stroked straight-segment path immediately
  followed by its point markers, drawn in that same order; y via `axisFromTicks()` (tick labels
  paired with gridlines); x via nearest "YYYY-Q" label. Prints lose series colours, hence order.
  Verified: sparse and full prints agree; firstFour matches the FH report.
- `fh` latest Family History import: `monthly[year][1..12]` from point markers (colour → year via
  the legend marks; LCR hides overlapping labels, so labels aren't used), bar charts from their
  labels (`allTickLabels()` excludes every axis column), YTD submitters "x / y" table, headline.
- UI: `renderStatsTab()`, `statsLineChart()` (dependency-free SVG, sized to the viewport), KI
  checkboxes + 2–16 quarter range (`_kiOn`, `_kiRange`), QR quarter select (`_qrPick`).
- Note: the Covenant Path importer's token helper is `reportNameTokens()` — it had been named
  `nameTokens`, silently replacing the note-matching `nameTokens()` (fixed 2026-10-20).

### Phone notifications (push) — Blaze + Cloud Function
Set-up steps are in `NOTIFICATIONS_SETUP.md` (Blaze upgrade, budget alert, Web Push key,
Firebase CLI, deploy).
- **Access requests**: `notifyAccessRequest` (`onDocumentCreated` on `profiles/{uid}`) runs on
  each sign-up; if the new profile is `pending` it sends every *approved admin's* devices "New
  access request: <name>." (the requester's own name — not member data) linking to `#admin`.
  The bootstrap admin signs up already approved, so that sends nothing. In the app, the Admin
  button shows a red count of pending requests (`updateAdminPendingCount()`, a
  `status == 'pending'` query only admins may run); `#admin` on load, or a tap on the
  notification while the app is open (`open-tab` message from sw.js), opens the Admin tab.
  Both functions share `sendToProfile()` (send + dead-token clean-up) and set a notification
  `tag` so a tag alert and an access request don't replace each other.
- **Server**: `functions/index.js` → `notifyTagged`, a 2nd-gen `onDocumentWritten` trigger on
  `wardData/shared` (region `us-central1`, max 2 instances). `functions/tags.js` (pure, unit
  tested in `tags.test.js`) diffs before/after for new (note, person) tag pairs — keyed by
  note id — skipping self-tags; groups them per person; reads `profiles/{uid}` (approved only,
  `fcmTokens`); sends one data-only FCM message per person with `{ title, body, unread, link }`;
  removes tokens FCM reports as dead. **The body names only the tagger**, never members or note
  text. The Admin SDK bypasses rules; the function never writes `wardData`, so no trigger loop.
  `forEachNote()` there must stay in step with `allTaggedNotes()` in the app.
- **Client**: `VAPID_PUBLIC_KEY` (public, from Project settings → Cloud Messaging) gates the
  feature; empty = hidden. The Notifications tab card (`renderPushCard()`) handles: iPhone not
  installed (explains Add to Home Screen), unsupported, blocked, on, off. **Turn on** requests
  permission, gets a token with `getToken({ vapidKey, serviceWorkerRegistration })` — the
  registration of our own `sw.js`, because FCM's default `/firebase-messaging-sw.js` would be
  looked for at the domain root, outside this GitHub Pages project path — and adds it to
  `profiles/{uid}.fcmTokens` (allowed by the self-update rule). The token is also kept in
  localStorage only to know "on for this device"; `refreshPushToken()` swaps it if FCM rotates it.
- **sw.js** imports the 12.18.0 compat app + messaging SDKs (keep the version in step with the
  page) and shows the notification in `onBackgroundMessage`, sets the icon badge from `unread`,
  and on tap focuses an open window (postMessage → refresh + Notifications tab) or opens
  `…#notifications`. When the app is open and visible, FCM delivers to the page instead
  (`onMessage` → "You were tagged — Show me" banner). Still caches nothing.
- Firebase files at the repo root: `firebase.json` (functions codebase) and `.firebaserc`
  (default project). `.gitignore` re-includes `firebase.json` past the `/*.json` rule and
  ignores `node_modules/`.
- Verified in headless Chromium with the real FCM service-worker SDK: a push delivered while the
  app was closed showed the notification with the right text, icon and link. The function was
  run against fake Firestore/Messaging (one message per person, dead-token clean-up, nothing on
  re-saves). Not yet run against the live project.

### Installable app (PWA)
- `manifest.json` (start_url `./ministering_tool.html`, standalone), `icons/` (192, 512,
  512 maskable, 180 apple-touch-icon), and head tags in `ministering_tool.html`.
- `sw.js` is a deliberate **pass-through**: no fetch handler, no caching, so member data is
  never stored on devices and the `?v=` cache-buster still controls updates. It exists because
  installed apps and future push need one. It registers only over https (or localhost).
- `.gitignore` ignores `/*.json` to keep exports out; `!/manifest.json` re-includes the manifest.
- Verified with Chrome DevTools Protocol: no installability or manifest errors.

### Roles: two ways the tool is used
The app serves two audiences, controlled by a `role` field on the profile and applied in
`applyAccessVisibility()` / `hasFullAccess()`:

- **`role: 'eq'` — Elders Quorum presidency.** The full tool: everything below plus Brothers,
  Current Assignments and Proposed Assignments. This is the original use case — keeping
  ministering companionships current.
- **anything else — ward council member.** Import, Members, Households, and Ward Council
  Collaboration. No ministering assignment tabs.
- **Removing users**: the Admin tab offers **Remove** only for someone already **denied**
  (two deliberate steps; never yourself). `removeUserProfile()` deletes `profiles/{uid}`, which
  `firestore.rules` already allows admins to do. Their Firebase Auth account can't be deleted
  from the browser, so it stays: they remain locked out and see "Access Removed" (a missing
  profile at sign-in, outside the `_signingUp` window during sign-up). To let them sign up again
  with the same email, delete the account in Firebase console → Authentication → Users. Their
  notes and tags stay; `syncUserDirectory()` drops them from the tag list.
- **Coming back after Remove**: the email stays registered (the Auth account isn't deleted),
  so sign-up says "already has an account". A removed person *signs in* and gets **Request
  access again** (`reRequestAccess()`), which recreates their profile as `pending` with exactly
  the six sign-up fields the create rule allows; admins are notified as for a new sign-up.
  Denied = blocked (profile kept), Removed = cleared (may ask again). The sign-in form has
  **Forgot password?** (`fbAuth.sendPasswordResetEmail`, same message whether or not the email
  exists), and sign-up turns `auth/email-already-in-use` into an explanation.
- **Email verification**: sign-up sends Firebase's verification email (`sendVerification()`,
  continue URL back to the app). Anyone with a pending or approved profile whose
  `user.emailVerified` is false sees **Check Your Email** (resend / "I've verified — continue",
  which reloads the user and forces a token refresh) instead of the app. `firestore.rules`
  requires `request.auth.token.email_verified == true` for `wardData/shared` — that, not the
  screen, is the real gate. The app copies `emailVerified: true` onto the profile once verified,
  only so the Admin list can show it (self-written, so informational, not trusted).
- **`micahj145.github.io` must be in Firebase → Authentication → Settings → Authorized
  domains.** Verification emails carry a continue URL back to the app, and Firebase refuses to
  send one (`UNAUTHORIZED_DOMAIN`, surfaced by the SDK as `auth/unauthorized-continue-uri`)
  when that URL's domain isn't listed. Password sign-in works without the listing, which is why
  this went unnoticed at first; the code's fallback then retried without the URL, doubling
  requests until Firebase throttled them (`auth/too-many-requests`). Each attempt is now
  recorded before sending and auto-sends happen at most daily per device.
- **`isAdmin`** is separate and orthogonal: it gates the Admin tab, the Data Management card and
  Load Session File. **Admins always get full access regardless of role**, so the bootstrap admin
  can't demote themselves out of the tab where roles are set.

Notes for anyone changing this:
- A profile with **no `role` predates this feature and is treated as ward council** (least
  access). That's why the bootstrap admin, whose profile has no role, still sees everything —
  via `isAdmin`, not via role.
- **`role` is deliberately not written at signup.** `firestore.rules` pins a newly created
  profile to exactly six keys (`hasOnly([...])`), so adding a seventh there would make every
  signup fail. An admin assigns the role afterwards from the Admin tab, which the rules permit.
- **None of this is a data boundary.** Every approved user can still read and write the whole
  `wardData/shared` document, so hiding a tab keeps people in their lane and prevents accidents —
  it does not withhold information. Making it real would mean encoding roles in `firestore.rules`
  (and note the current self-update rule doesn't pin `role`, so a non-admin could set their own
  from the console). Deliberate tradeoff for a small, trusted group.

### Files
- `ministering_tool.html` — the app. `firebaseConfig` near the top of the `<script>` block holds
  the live project's real values (see "Live project" above) — client-safe values, not secrets;
  real access control is entirely in `firestore.rules`.
- `index.html` — redirects to the app with a `?v=<timestamp>` cache-busting stamp, and
  `ministering_tool.html` self-redirects once to add the same stamp when loaded without one (so a
  bookmark straight to the file is covered too). GitHub Pages serves with a ~10-minute cache
  header and browsers hold on longer, which left ward members on a stale build after a deploy; a
  query string is a distinct cache key, so the fetch has to go to the server. The self-redirect is
  skipped over `file://`, so opening the file locally still works normally. A stamp older than 10 minutes
  is replaced too, because an iPhone Home Screen app or a bookmark saves the stamped URL and
  would otherwise keep reopening a stale build.
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
- Only `ministering_tool.html`, `index.html`, `firestore.rules`, `FIREBASE_SETUP.md`, this
  file, the PWA files (`manifest.json`, `sw.js`, `icons/`), `NOTIFICATIONS_SETUP.md`, and the
  push files (`firebase.json`, `.firebaserc`, `functions/` minus `node_modules`) should ever be
  staged/committed — the project root otherwise accumulates loose data export
  files that must stay untracked.
