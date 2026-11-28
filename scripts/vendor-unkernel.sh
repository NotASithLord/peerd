#!/usr/bin/env bash
# vendor-unkernel.sh - pull a pinned, HASH-VERIFIED unkernel release into
# extension/vendor/unkernel/.
#
# Why vendored (not npm-installed into package.json or loaded from a CDN):
# Extension MV3 CSP forbids external script sources (`script-src 'self'
# 'wasm-unsafe-eval'`). Keeping the MIT web SDK and the gzipped Linux 7.x
# kernel bundle under extension/vendor/unkernel/ lets vm-tab.js import
# `/vendor/unkernel/web.mjs` locally with zero external script origins.
#
# Supply-chain integrity: every extracted file is verified against
# scripts/vendor-unkernel.sha256 BEFORE anything is written into
# extension/vendor/unkernel/.
#
# Usage:
#   ./scripts/vendor-unkernel.sh           # verify against scripts/vendor-unkernel.sha256
#   ./scripts/vendor-unkernel.sh --reseed  # after an intentional version bump
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNKERNEL_TAG="v0.2.0-261127-3b71fa5"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/unkernel"
SUMS_FILE="${REPO_ROOT}/scripts/vendor-unkernel.sha256"
BASE_URL="https://github.com/pithings/unkernel/releases/download/${UNKERNEL_TAG}"

RESEED=0
if [[ "${1:-}" == "--reseed" ]]; then RESEED=1; fi

FILES=(
  "LICENSE"
  "LICENSE-MIT"
  "THIRD-PARTY.md"
  "_chunks/core.mjs"
  "_chunks/vk-host.mjs"
  "_chunks/vk-shader.mjs"
  "unkernel.wasm.gz"
  "web.mjs"
)

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
mkdir -p "${STAGE}/out/_chunks"

echo "[vendor-unkernel] pulling unkernel ${UNKERNEL_TAG} (staging)"
curl -fsSL --retry 3 "${BASE_URL}/unkernel.tgz" -o "${STAGE}/unkernel.tgz"
curl -fsSL --retry 3 "${BASE_URL}/unkernel.wasm.gz" -o "${STAGE}/out/unkernel.wasm.gz"
tar -xzf "${STAGE}/unkernel.tgz" -C "${STAGE}"

cp "${STAGE}/package/dist/web.mjs" "${STAGE}/out/web.mjs"
cp "${STAGE}/package/dist/_chunks/core.mjs" "${STAGE}/out/_chunks/core.mjs"
cp "${STAGE}/package/dist/_chunks/vk-host.mjs" "${STAGE}/out/_chunks/vk-host.mjs"
cp "${STAGE}/package/dist/_chunks/vk-shader.mjs" "${STAGE}/out/_chunks/vk-shader.mjs"
cp "${STAGE}/package/LICENSE" "${STAGE}/out/LICENSE"
cp "${STAGE}/package/LICENSE-MIT" "${STAGE}/out/LICENSE-MIT"
cp "${STAGE}/package/THIRD-PARTY.md" "${STAGE}/out/THIRD-PARTY.md"

hash_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

if [[ "${RESEED}" -eq 1 ]]; then
  (cd "${STAGE}/out" && hash_cmd "${FILES[@]}") > "${SUMS_FILE}"
  echo "[vendor-unkernel] RESEEDED ${SUMS_FILE}:"
  cat "${SUMS_FILE}"
else
  if [[ ! -f "${SUMS_FILE}" ]]; then
    echo "[vendor-unkernel] FATAL: ${SUMS_FILE} missing. Run with --reseed to create it." >&2
    exit 1
  fi
  echo "[vendor-unkernel] verifying against $(basename "${SUMS_FILE}")"
  if ! (cd "${STAGE}/out" && hash_cmd -c "${SUMS_FILE}"); then
    echo "[vendor-unkernel] FATAL: sha256 mismatch." >&2
    exit 1
  fi
fi

mkdir -p "${VENDOR_DIR}/_chunks"
for rel in "${FILES[@]}"; do
  cp "${STAGE}/out/${rel}" "${VENDOR_DIR}/${rel}"
done
echo "[vendor-unkernel] done. Vendored ${#FILES[@]} files -> ${VENDOR_DIR}"
echo "[vendor-unkernel] Next: run 'bun packaging/check-vendor.ts --write'."
