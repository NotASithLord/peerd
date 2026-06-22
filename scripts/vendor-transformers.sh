#!/usr/bin/env bash
# Vendor Transformers.js + ONNX-Runtime-Web (WebGPU/JSEP) for the local runner
# (FEATURE-LOCAL-WEBGPU B / M1). Run ONCE to populate extension/vendor/transformers/.
#
# why vendored, not CDN: the offscreen document's CSP is `script-src 'self'`, so
# the engine can only `import()` same-origin JS. Both the library AND the ORT
# wasm-factory `.mjs` load via dynamic import (script-src governed) — a CDN import
# is blocked there. So we vendor all the JS/WASM runtime pieces and point
# `env.backends.onnx.wasm.wasmPaths` at this dir. Only the MODEL WEIGHTS stream
# from HF at runtime (connect-src https:), browser-cached like the voice model.
#
# Pinning (these MUST stay in lockstep — Gemma-4 needs gemma4 support, and the
# ORT wasm/mjs pair must match the version Transformers.js bundles):
#   - @huggingface/transformers 4.2.0  → first line that ships Gemma4ForConditional-
#     Generation + its AutoProcessor (3.x has ZERO gemma4 support → the
#     "No image_processor_type" fallback error). Use the UNIVERSAL transformers.js
#     (self-contained — inlines ORT, no bare specifiers; 1.3MB). NOT transformers.web.js:
#     the "web" build externalizes ORT via bare imports ("onnxruntime-web/webgpu",
#     "onnxruntime-common") that a no-build browser can't resolve and that the
#     offscreen CSP can't fix with an import map (inline importmaps are script-src
#     blocked). The 108 relative `import(...)` in transformers.js are JSDoc type
#     comments, inert at runtime.
#   - onnxruntime-web 1.26.0-dev.20260416-b7804b056c → the exact build 4.2.0 pins.
#     4.2.0's loader picks the ASYNCIFY variant on non-Safari (Chrome/Firefox) and
#     the plain variant on Safari — it does NOT use the old `.jsep.` names (that's
#     the 1.22.0 scheme the voice stack still vendors). peerd ships Chrome+Firefox,
#     so we vendor only ort-wasm-simd-threaded.asyncify.{mjs,wasm}.
set -euo pipefail

TX_VERSION="${1:-4.2.0}"
ORT_VERSION="${2:-1.26.0-dev.20260416-b7804b056c}"
DEST="extension/vendor/transformers"
TX_BASE="https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TX_VERSION}/dist"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

# local-model.js sets env.wasmPaths to this dir; the ORT inlined in transformers.js
# then builds `<dir>ort-wasm-simd-threaded.asyncify.{mjs,wasm}` and loads them (the
# .mjs via dynamic import with an absolute URL → script-src 'self' needs it local;
# the .wasm is the WebGPU runtime binary). fetch guards against a 404/error page
# slipping in as a tiny file.
fetch() {  # fetch <url> <outfile> <min_bytes>
  echo "  ↓ $2"
  curl -fSL "$1" -o "$DEST/$2"
  local got; got=$(wc -c < "$DEST/$2")
  if [ "$got" -lt "$3" ]; then
    echo "✗ $2 is only $got bytes (<$3) — likely a 404/error page, not the real asset." >&2
    exit 1
  fi
}

rm -rf "$DEST"          # drop any stale vendor (e.g. an earlier wrong-version pull)
mkdir -p "$DEST"
echo "Vendoring transformers@${TX_VERSION} + onnxruntime-web@${ORT_VERSION} → $DEST"
fetch "${TX_BASE}/transformers.js"                          transformers.js                          1000000
fetch "${ORT_BASE}/ort-wasm-simd-threaded.asyncify.mjs"     ort-wasm-simd-threaded.asyncify.mjs      10000
fetch "${ORT_BASE}/ort-wasm-simd-threaded.asyncify.wasm"    ort-wasm-simd-threaded.asyncify.wasm     1000000

# SOURCE.txt + SHA-256s — the vendor/ convention (audit + drift detection).
{
  echo "@huggingface/transformers@${TX_VERSION}  (universal self-contained build: transformers.js)"
  echo "onnxruntime-web@${ORT_VERSION}           (WebGPU runtime: ort-wasm-simd-threaded.asyncify.{mjs,wasm})"
  echo "  for the local WebGPU runner (extension/offscreen/local-model.js)."
  echo "  from: ${TX_BASE} + ${ORT_BASE}"
  echo ""
  echo "files + SHA-256:"
  ( cd "$DEST" && shasum -a 256 transformers.js ort-wasm-simd-threaded.asyncify.mjs ort-wasm-simd-threaded.asyncify.wasm )
} > "$DEST/SOURCE.txt"

echo ""
echo "✓ done ($(du -sh "$DEST" | cut -f1)). Reload the extension, then hit 'Download"
echo "  local model' in eval/ — the ~GB model weights stream from HF on first run."
