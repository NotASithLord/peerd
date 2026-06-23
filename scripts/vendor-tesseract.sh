#!/usr/bin/env bash
# vendor-tesseract.sh — pull a pinned release of tesseract.js (the OCR driver)
# into extension/vendor/tesseract/.
#
# Why this script exists
# ----------------------
# Peerd does not allow npm runtime in the extension. The tesseract.js DRIVER
# (the ESM API + its worker) must be committed files in vendor/ (like pdf.js).
# This is the auditable, reproducible vendoring step: it pins a specific
# version, verifies the upstream bytes against recorded sha256 hashes, writes
# the two driver files, and prints the SHA-384 SRIs to paste into SOURCE.txt.
#
# The two HEAVY assets (core WASM + language model) are NOT vendored — they're
# the opt-in, SRI-pinned runtime download in peerd-runtime/pdf/ocr-store.js.
# To repin THOSE, run scripts/compute-ocr-sri.sh (separate from this script).
#
# Pinned version
# --------------
# Edit TESSERACT_VERSION below to bump. After bumping, run, verify the new
# sha256s, update the EXPECTED_* constants + SOURCE.txt SRIs, and commit.

set -euo pipefail

TESSERACT_VERSION="6.0.1"   # bump to upgrade; MUST be a pinned release, not 'latest'

# Upstream sha256 of the two dist files at the pinned version. The script
# refuses to write the vendor if these don't match — that's how we catch
# CDN/registry tampering or surprise version drift.
EXPECTED_ESM_SHA256="da6267cfe5036ae718a59eece3b5744a4655b0b8faa9f16259362b783d74c9bb"     # @6.0.1 dist/tesseract.esm.min.js
EXPECTED_WORKER_SHA256="38645599043239c0eb6db08a6504a92dcdc292200535f3e9339cd77c4443b842"  # @6.0.1 dist/worker.min.js

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/tesseract"
TGZ_URL="https://registry.npmjs.org/tesseract.js/-/tesseract.js-${TESSERACT_VERSION}.tgz"

echo "[vendor-tesseract] pulling ${TGZ_URL}"
mkdir -p "${VENDOR_DIR}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "${TGZ_URL}" -o "${TMP}/t.tgz"
tar -xzf "${TMP}/t.tgz" -C "${TMP}"

verify() { # <file> <expected-sha256> <label>
  local actual; actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  echo "[vendor-tesseract] $3 sha256: ${actual}"
  if [[ -n "$2" && "${actual}" != "$2" ]]; then
    echo "[vendor-tesseract] FATAL: sha256 mismatch for $3."
    echo "  expected: $2"
    echo "  actual:   ${actual}"
    echo "  Upstream changed without a version bump, or the registry is serving"
    echo "  tampered bytes. Investigate before proceeding."
    exit 1
  fi
}

verify "${TMP}/package/dist/tesseract.esm.min.js" "${EXPECTED_ESM_SHA256}" "tesseract.esm.min.js"
verify "${TMP}/package/dist/worker.min.js" "${EXPECTED_WORKER_SHA256}" "worker.min.js"

cp "${TMP}/package/dist/tesseract.esm.min.js" "${TMP}/package/dist/worker.min.js" "${VENDOR_DIR}/"

echo "[vendor-tesseract] wrote:"
echo "  ${VENDOR_DIR}/tesseract.esm.min.js"
echo "  ${VENDOR_DIR}/worker.min.js"
echo "[vendor-tesseract] SHA-384 SRIs (paste into SOURCE.txt):"
for f in tesseract.esm.min.js worker.min.js; do
  printf '  %-24s sha384-%s\n' "$f" "$(openssl dgst -sha384 -binary "${VENDOR_DIR}/$f" | openssl base64 -A)"
done
echo "[vendor-tesseract] done. (core WASM + lang are repinned via scripts/compute-ocr-sri.sh)"
