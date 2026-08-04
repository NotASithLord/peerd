#!/usr/bin/env bash
# vendor-cheerpx.sh — pull a pinned, HASH-VERIFIED CheerpX release into
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
# Integrity
# ---------
# This is the highest-privilege third-party code in the tree — a Wasm CPU
# emulator, fetched from a single-vendor CDN. So every file is verified
# against scripts/vendor-cheerpx.sha256 BEFORE anything is written into
# vendor/, and the whole vendoring is atomic: a mismatch, a missing file, or
# a failed download aborts without touching the working tree. (The previous
# version warned and continued on a failed fetch, which could leave a
# partially-updated vendor dir.)
#
# Bumping
# -------
#   1. Bump CHEERPX_VERSION below.
#   2. Run with --reseed: downloads, shows the hashes, and REWRITES
#      scripts/vendor-cheerpx.sha256 without verifying against the old pins.
#   3. Review the new bytes, then run without --reseed to confirm the
#      verified path passes.
#   4. Refresh extension/vendor/cheerpx/SOURCE.txt, regenerate the vendor
#      lock (`bun packaging/check-vendor.ts --write`), and commit all of it
#      together.
#
# why --reseed is explicit and separate: an upgrade must be a deliberate act
# that a reviewer sees as a hash diff, never something a re-run does quietly.

set -euo pipefail

CHEERPX_VERSION="1.2.8"     # pinned; bump to upgrade

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/cheerpx"
SUMS_FILE="${REPO_ROOT}/scripts/vendor-cheerpx.sha256"
BASE_URL="https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}"

RESEED=0
[[ "${1:-}" == "--reseed" ]] && RESEED=1

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

# Stage into a temp tree first — nothing reaches vendor/ until every file
# has downloaded AND verified.
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

echo "[vendor-cheerpx] pulling CheerpX ${CHEERPX_VERSION} (staging)"
for rel in "${FILES[@]}"; do
  url="${BASE_URL}/${rel}"
  out="${STAGE}/${rel}"
  mkdir -p "$(dirname "${out}")"
  echo "  ${rel}"
  if ! curl -fsSL "${url}" -o "${out}"; then
    echo "[vendor-cheerpx] FATAL: failed to fetch ${rel} — aborting without touching vendor/."
    exit 1
  fi
done

if [[ "${RESEED}" -eq 1 ]]; then
  # Write via a temp file: a bare `> "${SUMS_FILE}"` truncates the committed pins
  # BEFORE sha256sum runs, so a failure there would destroy them.
  TMP_SUMS="$(mktemp)"
  ( cd "${STAGE}" && sha256sum "${FILES[@]}" ) > "${TMP_SUMS}"
  mv "${TMP_SUMS}" "${SUMS_FILE}"
  echo "[vendor-cheerpx] RESEEDED ${SUMS_FILE}:"
  cat "${SUMS_FILE}"
  echo "[vendor-cheerpx] Before committing, diff the new bytes against the previously"
  echo "                 vendored version (git diff extension/vendor/cheerpx/) — Leaning"
  echo "                 Technologies publishes no per-file digests for this CDN path, so"
  echo "                 that diff, plus the npm @leaningtech/cheerpx tarball for the same"
  echo "                 version, is the verifiable cross-check available."
else
  if [[ ! -f "${SUMS_FILE}" ]]; then
    echo "[vendor-cheerpx] FATAL: ${SUMS_FILE} missing. Run with --reseed to create it."
    exit 1
  fi
  # `sha256sum -c` only checks files LISTED IN THE SUMS FILE — an entry added to
  # FILES without a reseed downloads, passes, and gets copied in having never been
  # hashed, while the script prints a verified count it did not verify. (That is
  # exactly the workflow the FILES comment above prescribes for a version bump.)
  # So assert the two sets match, both directions, before trusting the check.
  want="$(printf '%s\n' "${FILES[@]}" | sort)"
  have="$(awk '{ $1=""; sub(/^ +/,""); print }' "${SUMS_FILE}" | sort)"
  if [[ "${want}" != "${have}" ]]; then
    echo "[vendor-cheerpx] FATAL: FILES and $(basename "${SUMS_FILE}") disagree."
    echo "  only in FILES (would be vendored UNVERIFIED):"
    comm -23 <(printf '%s\n' "${want}") <(printf '%s\n' "${have}") | sed 's/^/    /'
    echo "  only in the sums file (pinned but no longer fetched):"
    comm -13 <(printf '%s\n' "${want}") <(printf '%s\n' "${have}") | sed 's/^/    /'
    echo "  Re-run with --reseed after reviewing the new file set."
    exit 1
  fi
  echo "[vendor-cheerpx] verifying against $(basename "${SUMS_FILE}")"
  if ! ( cd "${STAGE}" && sha256sum --quiet -c "${SUMS_FILE}" ); then
    echo "[vendor-cheerpx] FATAL: sha256 mismatch."
    echo "  Either upstream changed the bytes at a pinned version, or the CDN is"
    echo "  serving something else. Investigate before proceeding; if the change is"
    echo "  genuine and reviewed, re-run with --reseed."
    exit 1
  fi
  echo "[vendor-cheerpx] all ${#FILES[@]} files verified"
fi

# Commit the staged tree into vendor/ by REPLACING the directory, not copying over
# it. why: a plain copy leaves behind any file a version bump dropped from FILES —
# and the next `check-vendor.ts --write` would then pin those stale bytes as part of
# the new release, permanently blessed and invisible to every gate afterward. A
# whole-directory swap gets pruning and atomicity in one move.
cp "${VENDOR_DIR}/SOURCE.txt" "${STAGE}/SOURCE.txt"
rm -rf "${VENDOR_DIR}.new"
cp -R "${STAGE}" "${VENDOR_DIR}.new"
rm -rf "${VENDOR_DIR}"
mv "${VENDOR_DIR}.new" "${VENDOR_DIR}"

echo "[vendor-cheerpx] done. Vendored ${#FILES[@]} files → ${VENDOR_DIR}"
echo "[vendor-cheerpx] Next: update vendor/cheerpx/SOURCE.txt, then"
echo "                 bun packaging/check-vendor.ts --write"
