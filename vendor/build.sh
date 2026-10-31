#!/bin/bash
# Rebuilds vendor/firebase-12.18.0.js from firebase-shim.src.js, and copies the
# QR-code library used by the two-step sign-in setup (vendor/qrcode-1.4.4.js).
# Only needed after changing the shim or a version:
#   cd vendor && ./build.sh
# Then bump ?b= on the bundle's <script> tag in ministering_tool.html so
# browsers fetch the new copy.
set -e
cd "$(dirname "$0")"
npm install --no-save --no-audit --no-fund
npx esbuild firebase-shim.src.js --bundle --format=iife --minify --target=es2019 --legal-comments=none --outfile=firebase-12.18.0.js
cp node_modules/qrcode-generator/qrcode.js qrcode-1.4.4.js
rm -rf node_modules package-lock.json
echo "built vendor/firebase-12.18.0.js and vendor/qrcode-1.4.4.js"
