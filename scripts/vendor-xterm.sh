#!/usr/bin/env bash
# vendor-xterm.sh — pull a pinned @xterm/xterm release into
# extension/vendor/xterm/.
#
# Why
# ---
# No npm runtime inside the extension. xterm.js is the only realistic
# terminal renderer that survives complex output (cursor positioning,
# ANSI colors, scrollback, VT escape codes). MIT licensed.

set -euo pipefail

XTERM_VERSION="5.5.0"          # pinned; bump to upgrade
ADDON_FIT_VERSION="0.10.0"     # the FitAddon resizes the terminal to its container

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="${REPO_ROOT}/extension/vendor/xterm"
BASE_URL="https://cdn.jsdelivr.net/npm"

mkdir -p "${VENDOR_DIR}"
echo "[vendor-xterm] pulling xterm ${XTERM_VERSION} + fit-addon ${ADDON_FIT_VERSION} → ${VENDOR_DIR}"

# Core xterm — ESM bundle + CSS.
curl -fsSL "${BASE_URL}/@xterm/xterm@${XTERM_VERSION}/lib/xterm.js" -o "${VENDOR_DIR}/xterm.js"
curl -fsSL "${BASE_URL}/@xterm/xterm@${XTERM_VERSION}/css/xterm.css" -o "${VENDOR_DIR}/xterm.css"

# FitAddon — auto-sizes the terminal to its container element. Tiny.
curl -fsSL "${BASE_URL}/@xterm/addon-fit@${ADDON_FIT_VERSION}/lib/addon-fit.js" -o "${VENDOR_DIR}/addon-fit.js"

XT_SHA="$(shasum -a 256 "${VENDOR_DIR}/xterm.js" | awk '{print $1}')"
FIT_SHA="$(shasum -a 256 "${VENDOR_DIR}/addon-fit.js" | awk '{print $1}')"
echo "[vendor-xterm] xterm.js sha256: ${XT_SHA}"
echo "[vendor-xterm] addon-fit.js sha256: ${FIT_SHA}"
echo "[vendor-xterm] done."
