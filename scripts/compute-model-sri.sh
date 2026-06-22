#!/usr/bin/env bash
# compute-model-sri.sh — compute SRI hashes for Moonshine model files.
#
# Usage:
#   scripts/compute-model-sri.sh <url> [<url>...]
#
# For each URL, downloads the bytes, computes SHA-384, prints a base64
# SRI hash in the form `sha384-<base64>`. Paste the result into the
# `sri` field of the matching asset in
# peerd-runtime/voice/model-store.js MODEL_VARIANTS.
#
# Why this matters
# ----------------
# Moonshine .onnx files live on Hugging Face / npm CDNs; without SRI
# verification, a CDN compromise could swap in a model that
# transcribes to attacker-chosen text. We refuse to load any model
# whose computed SHA-384 disagrees with the baked-in expected value.
#
# Caveat: SRI hashes are tied to a SPECIFIC URL (a Hugging Face commit
# or a pinned npm version). If you bump the model URL, you must
# re-run this and update the constants. Use commit-pinned URLs, not
# 'latest'.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  cat <<'USAGE'
Usage: scripts/compute-model-sri.sh <url> [<url>...]

Example:
  scripts/compute-model-sri.sh \
    https://huggingface.co/UsefulSensors/moonshine/resolve/<commit>/onnx/tiny/encoder.onnx
USAGE
  exit 1
fi

for url in "$@"; do
  echo "[compute-sri] ${url}"
  TMP="$(mktemp)"
  curl -fsSL "${url}" -o "${TMP}"
  bytes_size=$(stat -f%z "${TMP}" 2>/dev/null || stat -c%s "${TMP}")
  digest_b64=$(openssl dgst -sha384 -binary "${TMP}" | base64)
  echo "  sizeBytes: ${bytes_size}"
  echo "  sri:       sha384-${digest_b64}"
  rm -f "${TMP}"
done
