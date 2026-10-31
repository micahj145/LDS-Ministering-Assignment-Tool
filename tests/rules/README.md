# firestore.rules tests

`rules.test.js` checks `firestore.rules` against the Firestore emulator, twice: as written (step 1,
`finalRules()` false) and with `finalRules()` switched to true (step 2). 61 cases: allowed list,
two-step sign-in, the 14-day limit, email verification, the allowed list's own protections,
profiles, ward data per role, unit statistics, notes, and the step-1 fallbacks.

```bash
cd tests/rules
npm install
./run.sh
```

Needs Java 11+ (for the emulator). Uses project id `demo-rules`, so nothing touches the live project.
