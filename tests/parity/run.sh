#!/bin/bash
# usage: run.sh <label> [appFile]   — appFile is relative to the repo root
#   PHASE=final ./run.sh <label>    runs against firestore.rules with finalRules() switched on
set -e
H="$(cd "$(dirname "$0")" && pwd)"; P="${REPO_PARENT:-$H/..}"   # dir holding firebase.json + repo/
LABEL="${1:-baseline}"; APPF="${2:-ministering_tool.html}"
(cd "$P/repo" && exec python3 -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1) & SRV=$!
trap "kill $SRV 2>/dev/null" EXIT
export NODE_OPTIONS="--require $H/pushstub.js"
cd "$P"
CFG=firebase.json
if [ "$PHASE" = "final" ]; then
  sed 's/function finalRules() { return false; }/function finalRules() { return true; }/' repo/firestore.rules > firestore.final.rules
  sed 's#"repo/firestore.rules"#"firestore.final.rules"#' firebase.json > firebase.final.json
  CFG=firebase.final.json
fi
"${FIREBASE_BIN:-$P/../emu/node_modules/.bin/firebase}" emulators:exec --config "$CFG" --project demo-parity --only auth,firestore,functions \
  "NODE_OPTIONS= PHASE=$PHASE node $H/seed.js && NODE_OPTIONS= PHASE=$PHASE node $H/run.js $LABEL $APPF" 2>&1 | grep --line-buffered -v -E "^\s*$|i  (functions|firestore|auth|emulators|hub|logging|ui)|EAFNOSUPPORT|MetadataLookupWarning|MOTD"
