#!/usr/bin/env bash
# End-to-end experiment: capture a real browser SABR bundle, inject it into the
# ytjs server, and run the injected-bundle smoke test.
#
#   ./run-capture-experiment.sh <videoId>
#
# Prereqs: ytjs server running (pnpm start), playwright installed
#   (cd ytjs && pnpm add -D playwright && npx playwright install chromium)
set -euo pipefail

VIDEO_ID="${1:?usage: run-capture-experiment.sh <videoId>}"
YTJS_BASE="${YTJS_BASE:-http://localhost:3001}"
OUT="/tmp/sabr-bundle-${VIDEO_ID}.json"

cd "$(dirname "$0")/.."

echo "=== 1. capture from live browser ==="
node scripts/capture-sabr-bundle.mjs "$VIDEO_ID" -o "$OUT"

echo "=== 2. inject into ytjs server ==="
curl -sf -X POST "$YTJS_BASE/sabr-inject/$VIDEO_ID" \
	-H 'content-type: application/json' \
	--data-binary @"$OUT"
echo

echo "=== 3. injected-bundle smoke test ==="
curl -sf "$YTJS_BASE/sabr-test-inject/$VIDEO_ID" | python3 -m json.tool
echo
echo "Watch the server log for [sabr] stream protection status lines —"
echo "status 3 = rejected; segments arriving past requestNumber ~10 = attestation hypothesis CONFIRMED."
