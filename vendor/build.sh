#!/bin/bash
# Rebuilds vendor/firebase-12.18.0.js from firebase-shim.src.js.
# Only needed after changing the shim or the Firebase version:
#   cd vendor && ./build.sh
set -e
cd "$(dirname "$0")"
npm install --no-save --no-audit --no-fund
npx esbuild firebase-shim.src.js --bundle --format=iife --minify --target=es2019 --legal-comments=none --outfile=firebase-12.18.0.js
rm -rf node_modules package-lock.json
echo "built vendor/firebase-12.18.0.js"
