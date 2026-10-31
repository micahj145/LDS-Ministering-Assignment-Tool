#!/bin/bash
# Runs rules.test.js against the Firestore emulator.
#   cd tests/rules && npm install && ./run.sh
set -e
cd "$(dirname "$0")"
FB="${FIREBASE_BIN:-npx firebase}"
$FB emulators:exec --project demo-rules --only firestore --config firebase.rules-test.json "node --test rules.test.js"
