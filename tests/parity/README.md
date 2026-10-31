# Parity suite (emulator-backed)

Drives the real `ministering_tool.html`, unchanged, against the Firebase
emulators (Auth, Firestore with `firestore.rules`, Functions with FCM replaced
by a recorder) using invented people only. Used to check that the modular-SDK
migration behaves exactly like the current compat version.

- `seed.js` — synthetic users (admin, EQ, RS, council, pending, denied, unverified) and ward data.
- `emuhook.js` — appended to the served SDK file in the test browser only: points the app at the emulators under a `demo-` project id.
- `pushstub.js` — preloaded into the Functions emulator; writes would-be pushes to `__pushLog`.
- `run.js` — ~150 checks: sign-in gates, every tab for every role, EQ/RS/council edits,
  notes + tags, follow feed, DMs, restricted notes, search, nearby, admin, today's access rules.
  Optional real-LCR-PDF imports when `REAL_PDF_DIR` (and `REAL_ROSTER`) point at local private files;
  results keep counts only.
- `compare.js` — diffs two results files. Access-rule ("security") differences are listed separately.

Results files contain no member data. Never point `REAL_*` at anything inside the repo.
