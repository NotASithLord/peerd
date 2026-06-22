#!/usr/bin/env bash
# vendor-cheerpx.sh — pull a pinned CheerpX release into
# extension/vendor/cheerpx/.
#
# Why
# ---
# MV3 extension_pages CSP forbids `script-src https://<external>` (and
# blob:). The only legitimate path to load CheerpX is to vendor its
# files locally and import from a relative path. This script does that.
#
# CheerpX 1.x's cx.esm.js is a thin wrapper that imports cx_esm.js,
# which in turn pulls cxcore.js / cxbridge.js / cheerpOS.js / workerclock.js
# / fail.wasm / tun/* at runtime. We fetch all of them so the runtime
# can resolve every reference relative to vendor/cheerpx/.
#
# Pinned version
# --------------
# Bump CHEERPX_VERSION below to upgrade. After bumping, run the script
# and commit the new bytes.

set -euo pipefail

CHEERPX_VERSION="1.2.8"     # pinned; bump to upgrade

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/cheerpx"
BASE_URL="https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}"

# Files we need from upstream. Listed explicitly so the set is reviewable
# and the script doesn't crawl the CDN blindly. If a CheerpX bump adds
# new sub-resources, the runtime will fail with a 404 in the console —
# add the missing file here and re-run.
FILES=(
  "cx.esm.js"
  "cx_esm.js"
  "cxcore.js"
  "cxcore.wasm"
  "cxcore-no-return-call.js"
  "cxcore-no-return-call.wasm"
  "cxbridge.js"
  "cheerpOS.js"
  "workerclock.js"
  # Network drivers + their dependency chain. CheerpX dynamically
  # imports `tun/tailscale_tun_auto.js` during Linux.create — if any
  # of its transitive deps are missing, the import promise rejects
  # and the kernel boot deadlocks waiting for it. We don't actually
  # USE tailscale (V1 is sandboxed-VM-no-egress), but we have to ship
  # the files so the import resolves.
  "tun/direct.js"
  "tun/tailscale_tun_auto.js"
  "tun/tailscale_tun.js"
  "tun/wasm_exec.js"
  "tun/ipstack.js"
  "tun/ipstack.wasm"
)

mkdir -p "${VENDOR_DIR}/tun"
echo "[vendor-cheerpx] pulling CheerpX ${CHEERPX_VERSION} → ${VENDOR_DIR}"

for rel in "${FILES[@]}"; do
  url="${BASE_URL}/${rel}"
  out="${VENDOR_DIR}/${rel}"
  mkdir -p "$(dirname "${out}")"
  echo "  ${rel}"
  if ! curl -fsSL "${url}" -o "${out}"; then
    echo "[vendor-cheerpx] WARN: failed to fetch ${rel}; continuing"
    rm -f "${out}"
  fi
done

# Compute SHA256 for the entry file so SOURCE.txt has a real pin.
ENTRY_SHA="$(shasum -a 256 "${VENDOR_DIR}/cx.esm.js" | awk '{print $1}')"
echo "[vendor-cheerpx] cx.esm.js sha256: ${ENTRY_SHA}"
echo "[vendor-cheerpx] done. Vendored ${#FILES[@]} files."
echo "[vendor-cheerpx] Update vendor/cheerpx/SOURCE.txt with version + sha if you bumped."
