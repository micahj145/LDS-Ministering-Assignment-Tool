# Browser suite (emulator-backed)

Drives the real `ministering_tool.html`, unchanged, against the Firebase emulators — Auth (which
"texts" two-step codes through its REST API), Firestore with `firestore.rules`, and Functions with
FCM replaced by a recorder — using invented people only.

- `seed.js` — synthetic users (admin, EQ, RS, council, pending, denied, unverified, and one approved
  person who hasn't set up two-step sign-in), allowed-list entries, phone factors, and ward data in
  the old format (notes inside the document) so the one-time move is exercised.
- `pushstub.js` — preloaded into the Functions emulator; writes would-be pushes to `__pushLog`.
- `run.js` — ~150 checks: sign-in gates, two-step setup and sign-in, every tab for every role,
  EQ/RS/council edits, before/after confirmation, notes + tags, follow feed, DMs, restricted notes,
  search, nearby, admin (allowed list, callings check with a generated PDF, reset two-step), access
  rules. `PHASE=final` also checks the sign-out with "For security, please sign in again.".
  Optional real-LCR-PDF imports when `REAL_PDF_DIR` / `REAL_ROSTER` point at local private files;
  results keep counts only.
- `compare.js` — diffs two results files. Tab text is hashed and depends on today's date, so compare
  runs from the same day. Access-rule differences are listed separately.

Layout it expects (`REPO_PARENT`): a folder holding `firebase.json` (copy `firebase.emulators.json`)
and this repo as `repo/`.

```bash
REPO_PARENT=/path/to/parent FIREBASE_BIN=/path/to/firebase ./run.sh step1
PHASE=final REPO_PARENT=… FIREBASE_BIN=… ./run.sh final
node compare.js results-step1.json results-final.json
```

Results files contain no member data. Never point `REAL_*` at anything inside the repo.
