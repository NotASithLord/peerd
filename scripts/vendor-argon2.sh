#!/usr/bin/env bash
# vendor-argon2.sh — pull a pinned release of hash-wasm's per-algorithm
# Argon2 bundle into extension/vendor/argon2/.
#
# Why this script exists
# ----------------------
# Peerd does not allow npm runtime in the extension, and MV3 CSP forbids
# remote script execution — the Argon2 implementation must be a committed
# file in vendor/. This script is the auditable, reproducible vendoring
# step: it pins a specific version, verifies the upstream bytes against a
# recorded hash, writes the vendored files, and leaves a VERSION marker.
#
# Why hash-wasm (and not antelle/argon2-browser)
# ----------------------------------------------
# See extension/vendor/argon2/SOURCE.txt for the full rationale. Short
# form: hash-wasm ships a small (~29 KB) per-algorithm dist with the
# WASM binary base64-embedded — a single self-contained file, no
# separate .wasm fetch, no environment sniffing, no SharedArrayBuffer,
# works in the MV3 service worker under `wasm-unsafe-eval`.
#
# Pinned version
# --------------
# Edit HASH_WASM_VERSION below to bump. After bumping, run, manually
# verify the new SHA against the npm registry tarball
# (https://registry.npmjs.org/hash-wasm/-/hash-wasm-<ver>.tgz —
# extract package/dist/argon2.umd.min.js and shasum -a 256 it; the CDN
# and the registry must agree), update EXPECTED_DIST_SHA256, and commit.

set -euo pipefail

HASH_WASM_VERSION="4.12.0"     # bump to upgrade; MUST be a pinned release, not 'latest'

# Real upstream hash for the dist file at the pinned version, verified
# against BOTH cdn.jsdelivr.net and the registry.npmjs.org tarball
# (package/dist/argon2.umd.min.js) on 2026-06-12. The script refuses to
# write the vendor if this doesn't match the bytes it pulls — that's how
# we catch CDN tampering or surprise version drift.
EXPECTED_DIST_SHA256="dcec617a2e1b700fa132d1583a186cb70611113395e869f2dd6cc82b415d3094"  # @4.12.0 dist/argon2.umd.min.js

# Layout
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/argon2"
DIST_URL="https://cdn.jsdelivr.net/npm/hash-wasm@${HASH_WASM_VERSION}/dist/argon2.umd.min.js"

echo "[vendor-argon2] pulling ${DIST_URL}"
mkdir -p "${VENDOR_DIR}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL "${DIST_URL}" -o "${TMP}"

ACTUAL_SHA256="$(shasum -a 256 "${TMP}" | awk '{print $1}')"
echo "[vendor-argon2] upstream sha256: ${ACTUAL_SHA256}"

if [[ -n "${EXPECTED_DIST_SHA256}" && "${ACTUAL_SHA256}" != "${EXPECTED_DIST_SHA256}" ]]; then
  echo "[vendor-argon2] FATAL: sha256 mismatch."
  echo "  expected: ${EXPECTED_DIST_SHA256}"
  echo "  actual:   ${ACTUAL_SHA256}"
  echo "  Either the upstream changed without a version bump, or the CDN"
  echo "  is serving tampered bytes. Investigate before proceeding."
  exit 1
fi
if [[ -z "${EXPECTED_DIST_SHA256}" ]]; then
  echo "[vendor-argon2] WARN: EXPECTED_DIST_SHA256 is empty — vendoring without verification."
  echo "                Fill the constant in this script before tagging a release."
fi

# The dist is UMD-only. In an ES-module scope its factory falls through to
# the globalThis branch (`globalThis.hashwasm = …`), so we APPEND a thin
# ESM adapter re-exporting the one function peerd uses, plus the VENDORED
# sentinel (same pattern as vendor-moonshine.sh). A missing named ESM
# import is a hard link error, so feature code fails loudly if the vendor
# file is absent or truncated. The dist bytes above the append are
# untouched (the recorded SHA256 below is the UPSTREAM hash, pre-append).
cp "${TMP}" "${VENDOR_DIR}/argon2.js"
chmod 644 "${VENDOR_DIR}/argon2.js"   # mktemp files are 0600; vendored files are world-readable
printf '\n// --- appended by scripts/vendor-argon2.sh: ESM adapter + peerd VENDORED sentinel ---\n// why: the upstream dist is UMD-only; in module scope its factory takes the\n// globalThis branch, so the named export peerd imports is re-exported here.\n// The upstream bytes above this line are untouched (the recorded SHA256 is\n// the UPSTREAM hash, pre-append).\nexport const argon2id = globalThis.hashwasm.argon2id;\nexport const VENDORED = true;\n' >> "${VENDOR_DIR}/argon2.js"
echo "${ACTUAL_SHA256}  argon2.js (upstream dist, before ESM-adapter append)" > "${VENDOR_DIR}/argon2.js.SHA256"
echo "${HASH_WASM_VERSION}" > "${VENDOR_DIR}/VERSION"

echo "[vendor-argon2] wrote:"
echo "  ${VENDOR_DIR}/argon2.js"
echo "  ${VENDOR_DIR}/argon2.js.SHA256"
echo "  ${VENDOR_DIR}/VERSION"
echo "[vendor-argon2] done."
