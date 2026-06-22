#!/usr/bin/env bash
# Local CI-equivalent gate runner used during the service-worker refactor.
# Mirrors the jobs in .github/workflows/package-and-release.yml so a step
# is only "green" when every gate the CI runs passes here too.
set -uo pipefail
cd "$(dirname "$0")/.."
export CHROME_PATH=${CHROME_PATH:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}

fail=0
# run NAME CMD... — preserves CMD's real exit code (no masking pipe).
run() {
  local name="$1"; shift
  echo "=== $name ==="
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  echo "$out" | tail -6
  if [ $rc -ne 0 ]; then echo ">>> GATE FAILED: $name (rc=$rc)"; fail=1; fi
  echo
}

run "bun test"   bun test ./tests
run "typecheck"  bun run typecheck
run "lint"       bun run lint
run "boundary"   bun run check:boundary
run "gen:dev"    bun run gen:dev
echo "=== drift ==="
if git diff --quiet extension/manifest.json extension/shared/channel-config.js; then
  echo "no drift"
else
  echo ">>> GATE FAILED: drift detected"; fail=1
fi
echo
run "in-browser" node scripts/cdp/run-inbrowser-tests.mjs
run "netproc"    bun run test:netproc
run "twopeer"    bun run test:twopeer

if [ $fail -ne 0 ]; then echo "########## ONE OR MORE GATES FAILED ##########"; exit 1; fi
echo "########## ALL GATES GREEN ##########"
