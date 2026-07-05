#!/usr/bin/env bash
# Deploy the peerd web demo to demo.peerd.ai (Cloudflare Pages, project
# "peerd-demo"). The tree is built FRESH from live extension/ source each run
# (packaging/package-web.ts), so the demo always reflects current main; there
# are no hand-vendored snapshots to keep in sync.
#
#   web/deploy.sh                build web-dist/ + deploy
#   web/deploy.sh --build-only   build web-dist/ only (no creds; local preview)
#
# One-time setup (owner, in the Cloudflare dashboard):
#   - create a Pages project named "peerd-demo"
#   - add the custom domain demo.peerd.ai (CNAME to the Pages deploy)
#   web-dist/_headers carries COOP/COEP so the origin is cross-origin-isolated
#   (WebVM/ORT need it); keeping it on this origin leaves peerd.ai unconstrained.
#
# Auth (deploy only): CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env
# (Pages:Edit on the account).
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

BUILD_ONLY=0
if [ "${1:-}" = "--build-only" ]; then
  BUILD_ONLY=1
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--build-only]" >&2
  exit 2
fi

if [ "$BUILD_ONLY" -eq 0 ]; then
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN not set" >&2; exit 1; }
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "CLOUDFLARE_ACCOUNT_ID not set" >&2; exit 1; }
fi

echo "→ building web-dist/ from live extension/ source"
bun run package:web

echo "→ verifying the staged tree is import-closed"
bun run check:web

if [ "$BUILD_ONLY" -eq 1 ]; then
  echo "→ --build-only: web-dist/ ready. Preview: npx serve -l 8126 web-dist"
  exit 0
fi

echo "→ deploying web-dist/ to Cloudflare Pages (peerd-demo → demo.peerd.ai)"
npx --yes wrangler@latest pages deploy web-dist --project-name=peerd-demo --branch=main --commit-dirty=true
