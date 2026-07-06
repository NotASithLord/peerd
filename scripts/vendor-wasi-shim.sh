#!/usr/bin/env bash
# vendor-wasi-shim.sh — pull a pinned release of @bjorn3/browser_wasi_shim
# into extension/vendor/browser-wasi-shim/.
#
# Why this script exists
# ----------------------
# peerd does not allow npm runtime in the extension, and MV3 CSP forbids
# remote script execution — the WASI shim must be committed files in
# vendor/. This script is the auditable, reproducible vendoring step: it
# pins a specific version, verifies the registry tarball against a
# recorded hash, and writes the vendored files (dist ESM verbatim, plus
# the upstream typings as sibling .d.ts so the strict typecheck sees
# real types).
#
# Why this library
# ----------------
# See extension/vendor/browser-wasi-shim/SOURCE.txt. Short form: a tiny,
# dependency-free WASI preview1 implementation whose every capability is
# an object the caller constructs and passes in — deny-by-default by
# shape, no network/eval primitives anywhere in the dist, loads as plain
# ESM with relative imports (no build step).
#
# Pinned version
# --------------
# Edit WASI_SHIM_VERSION below to bump. After bumping, verify the new
# tarball hash out of band (curl the registry URL and sha256sum it),
# update EXPECTED_TARBALL_SHA256, run, re-audit, and update SOURCE.txt.

set -euo pipefail

WASI_SHIM_VERSION="0.4.2"   # bump to upgrade; MUST be a pinned release, not 'latest'

# Registry tarball hash at the pinned version, recorded 2026-07-06. The
# script refuses to write the vendor if this doesn't match the bytes it
# pulls — that's how we catch registry tampering or surprise drift.
EXPECTED_TARBALL_SHA256="9c0281520d0e99f027ec7c1c79b4036c0f8168ed9bf98aba19db4737a1333782"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/browser-wasi-shim"
TARBALL_URL="https://registry.npmjs.org/@bjorn3/browser_wasi_shim/-/browser_wasi_shim-${WASI_SHIM_VERSION}.tgz"

echo "[vendor-wasi-shim] pulling ${TARBALL_URL}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "${TARBALL_URL}" -o "${TMP_DIR}/shim.tgz"

ACTUAL_SHA256="$(sha256sum "${TMP_DIR}/shim.tgz" | cut -d' ' -f1)"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_TARBALL_SHA256}" ]]; then
  echo "[vendor-wasi-shim] TARBALL HASH MISMATCH — refusing to vendor" >&2
  echo "  expected: ${EXPECTED_TARBALL_SHA256}" >&2
  echo "  actual:   ${ACTUAL_SHA256}" >&2
  exit 1
fi
echo "[vendor-wasi-shim] tarball sha256 OK"

tar -xzf "${TMP_DIR}/shim.tgz" -C "${TMP_DIR}"

mkdir -p "${VENDOR_DIR}"
# dist ESM verbatim + upstream typings renamed to .js-sibling .d.ts.
# tsconfig.tsbuildinfo is build residue — skipped on purpose.
for name in debug fd fs_mem fs_opfs index strace wasi wasi_defs; do
  cp "${TMP_DIR}/package/dist/${name}.js" "${VENDOR_DIR}/${name}.js"
  cp "${TMP_DIR}/package/typings/${name}.d.ts" "${VENDOR_DIR}/${name}.d.ts"
done
cp "${TMP_DIR}/package/LICENSE-MIT" "${TMP_DIR}/package/LICENSE-APACHE" "${VENDOR_DIR}/"
printf '%s\n' "${WASI_SHIM_VERSION}" > "${VENDOR_DIR}/VERSION"

echo "[vendor-wasi-shim] wrote $(ls "${VENDOR_DIR}" | wc -l | tr -d ' ') files to ${VENDOR_DIR}"
echo "[vendor-wasi-shim] per-file hashes (update SOURCE.txt if these changed):"
(cd "${VENDOR_DIR}" && sha256sum ./*.js)
echo "[vendor-wasi-shim] done — re-audit the diff and update SOURCE.txt (version, date, hashes)."
