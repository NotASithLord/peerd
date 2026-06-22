#!/usr/bin/env bash
# compute-ocr-sri.sh — compute SRI hashes for the opt-in OCR engine assets.
#
# Usage:
#   scripts/compute-ocr-sri.sh <url> [<url>...]
#   scripts/compute-ocr-sri.sh            # uses the URLs baked into OCR_ASSETS
#
# For each URL, downloads the bytes, computes SHA-384, and prints a base64
# SRI hash in the form `sha384-<base64>` plus the byte size. Paste each
# into the matching asset in
# peerd-runtime/pdf/ocr-store.js OCR_ASSETS (the `sri` / `sizeBytes` fields).
#
# Why this matters
# ----------------
# The OCR engine (Tesseract core WASM + a language model) is downloaded on
# demand from a CDN. Without SRI verification, a CDN compromise could swap in
# a tampered binary. peerd refuses to cache any asset whose computed SHA-384
# disagrees with the pinned value, and PRODUCTION refuses to download at all
# until every `sri` is pinned (hasValidOcrSris) — the same fail-closed posture
# as the Moonshine voice model.
#
# Caveat: SRI is tied to a SPECIFIC URL (a pinned npm/CDN version). If you bump
# a URL, re-run this and update the constants. Use version-pinned URLs.

set -euo pipefail

# Default to the URLs the code already pins, so a plain run prints exactly what
# OCR_ASSETS needs. Override by passing URLs as arguments.
DEFAULT_URLS=(
  "https://cdn.jsdelivr.net/npm/tesseract.js-core@6/tesseract-core-simd.wasm"
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1/4.0.0_best_int/eng.traineddata.gz"
)

urls=("$@")
if [[ ${#urls[@]} -eq 0 ]]; then
  urls=("${DEFAULT_URLS[@]}")
fi

for url in "${urls[@]}"; do
  echo "[compute-ocr-sri] ${url}"
  TMP="$(mktemp)"
  curl -fsSL "${url}" -o "${TMP}"
  bytes_size=$(stat -f%z "${TMP}" 2>/dev/null || stat -c%s "${TMP}")
  digest_b64=$(openssl dgst -sha384 -binary "${TMP}" | base64)
  echo "  sizeBytes: ${bytes_size}"
  echo "  sri:       sha384-${digest_b64}"
  rm -f "${TMP}"
done
