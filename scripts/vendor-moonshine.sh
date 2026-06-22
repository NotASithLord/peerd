#!/usr/bin/env bash
# vendor-moonshine.sh — pull a pinned release of @moonshine-ai/moonshine-js
# into extension/vendor/moonshine-js/.
#
# Why this script exists
# ----------------------
# Peerd does not allow npm runtime in the extension. The Moonshine JS
# wrapper must be a committed file in vendor/. This script is the
# auditable, reproducible vendoring step: it pins a specific version,
# verifies the upstream bytes against a recorded hash, writes the
# vendored files, and leaves a VERSION marker.
#
# Pinned version
# --------------
# Edit MOONSHINE_VERSION below to bump. After bumping, run, manually
# verify the new SHA matches the expected upstream hash from npm
# (https://www.npmjs.com/package/@moonshine-ai/moonshine-js?activeTab=code),
# update EXPECTED_DIST_SHA256 to the new hash, and commit.

set -euo pipefail

MOONSHINE_VERSION="0.1.29"     # bump to upgrade; MUST be a pinned release, not 'latest'

# Real upstream hash for the dist file at the pinned version. The script
# refuses to write the vendor if this doesn't match the bytes it pulls
# — that's how we catch CDN tampering or surprise version drift.
EXPECTED_DIST_SHA256="5531de142441cec986ee8e171461fbe4a06c071aefe1be8e4356b708ccf32eb9"  # @0.1.29 dist/moonshine.min.js

# Layout
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/moonshine-js"
DIST_URL="https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-js@${MOONSHINE_VERSION}/dist/moonshine.min.js"

echo "[vendor-moonshine] pulling ${DIST_URL}"
mkdir -p "${VENDOR_DIR}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL "${DIST_URL}" -o "${TMP}"

ACTUAL_SHA256="$(shasum -a 256 "${TMP}" | awk '{print $1}')"
echo "[vendor-moonshine] upstream sha256: ${ACTUAL_SHA256}"

if [[ -n "${EXPECTED_DIST_SHA256}" && "${ACTUAL_SHA256}" != "${EXPECTED_DIST_SHA256}" ]]; then
  echo "[vendor-moonshine] FATAL: sha256 mismatch."
  echo "  expected: ${EXPECTED_DIST_SHA256}"
  echo "  actual:   ${ACTUAL_SHA256}"
  echo "  Either the upstream changed without a version bump, or the CDN"
  echo "  is serving tampered bytes. Investigate before proceeding."
  exit 1
fi
if [[ -z "${EXPECTED_DIST_SHA256}" ]]; then
  echo "[vendor-moonshine] WARN: EXPECTED_DIST_SHA256 is empty — vendoring without verification."
  echo "                  Fill the constant in this script before tagging a release."
fi

# The @0.1.x dist is already an ESM module (named exports). We copy it
# verbatim, then APPEND a `VENDORED` sentinel: peerd's transcriber.js does
# `import { MicrophoneTranscriber, VENDORED }`, and the upstream dist doesn't
# provide VENDORED — a missing named ESM import is a hard link error, so without
# this the voice module fails to load. The dist bytes above this line are
# untouched (the recorded SHA256 below is the UPSTREAM hash, pre-append).
cp "${TMP}" "${VENDOR_DIR}/moonshine.js"
printf '\n// --- appended by scripts/vendor-moonshine.sh: peerd VENDORED sentinel ---\nexport const VENDORED = true;\n' >> "${VENDOR_DIR}/moonshine.js"
echo "${ACTUAL_SHA256}  moonshine.js (upstream dist, before VENDORED append)" > "${VENDOR_DIR}/moonshine.js.SHA256"
echo "${MOONSHINE_VERSION}" > "${VENDOR_DIR}/VERSION"

echo "[vendor-moonshine] wrote:"
echo "  ${VENDOR_DIR}/moonshine.js"
echo "  ${VENDOR_DIR}/moonshine.js.SHA256"
echo "  ${VENDOR_DIR}/VERSION"
echo "[vendor-moonshine] done."
