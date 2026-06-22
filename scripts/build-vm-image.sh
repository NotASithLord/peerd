#!/usr/bin/env bash
# build-vm-image.sh — build the peerd pre-baked WebVM disk image (ext2).
#
# ============================ SCAFFOLD ====================================
# THIS IS A DOCUMENTED SKELETON, NOT A FINISHED TOOL. It encodes the
# CheerpX custom-image flow (Dockerfile -> OCI image -> mounted rootfs ->
# mkfs.ext2 -d) from docs/engine/VM-IMAGE.md §2/§5 and fails fast with a
# clear message wherever a prerequisite is missing. It has NOT been run
# end-to-end; treat every step past the prerequisite checks as a recipe
# to verify, then harden. Remove this banner only once a real image built
# by this script has booted in the extension (VM-IMAGE.md §5 steps 10-11).
# ==========================================================================
#
# Why this flow
# -------------
# CheerpX executes 32-bit x86 only, and consumes a raw ext2 image streamed
# over HTTP byte-ranges (HttpBytesDevice). The documented build path
# (https://cheerpx.io/docs/guides/custom-images) is: define the rootfs in
# a Dockerfile on an i386 base, materialize it with buildah, and pack the
# mounted tree into an ext2 file with mkfs.ext2 -d. Hard cap: 2 GB.
#
# Usage
#   scripts/build-vm-image.sh [IMAGE_SIZE]
#     IMAGE_SIZE   ext2 allocation size passed to mkfs.ext2 (default 1400M;
#                  must exceed the rootfs du by ~20%; hard cap 2000M).
#
# Prerequisites (checked below, in order)
#   - Linux host (buildah userns + ext2 tooling do not exist on macOS)
#   - buildah        (rootless OK; the mount step runs under `buildah unshare`)
#   - mkfs.ext2      (e2fsprogs)
#   - a Dockerfile at build/vm-image/Dockerfile (see VM-IMAGE.md §2)
#   - ~3x IMAGE_SIZE free disk in the working directory

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="${REPO_ROOT}/build/vm-image/Dockerfile"
IMAGE_SIZE="${1:-1400M}"
DATE_TAG="$(date +%Y%m%d)"
OUT_BASENAME="peerd-debian-py_${DATE_TAG}"
OCI_TAG="peerd-vm-image"
CONTAINER="peerd-vm-container"

die() { echo "build-vm-image: ERROR: $*" >&2; exit 1; }

# --- Prerequisite checks (fail fast, say exactly what to do) --------------

[ "$(uname -s)" = "Linux" ] || die \
  "this script needs a Linux host (found: $(uname -s)). buildah's rootless \
mount namespace and mkfs.ext2 -d are Linux-only — run this on a Linux box \
or a CI runner (see docs/engine/VM-IMAGE.md §5)."

command -v buildah >/dev/null 2>&1 || die \
  "buildah not found. Install it (Debian/Ubuntu: 'apt install buildah'; \
Fedora: 'dnf install buildah') — it builds the i386 OCI image and mounts \
its rootfs without requiring root."

command -v mkfs.ext2 >/dev/null 2>&1 || die \
  "mkfs.ext2 not found. Install e2fsprogs (Debian/Ubuntu: \
'apt install e2fsprogs') — it packs the mounted rootfs into the ext2 \
image CheerpX streams."

[ -f "$DOCKERFILE" ] || die \
  "no Dockerfile at ${DOCKERFILE}. Create it first — the reference \
package set (python3/pip/pandas/requests/jq/curl/git/ripgrep on an \
i386 Debian base, pandas via apt NOT pip) is in docs/engine/VM-IMAGE.md §2."

case "$IMAGE_SIZE" in
  *M|*G) : ;;
  *) die "IMAGE_SIZE '${IMAGE_SIZE}' must end in M or G (e.g. 1400M)." ;;
esac

echo "==> prerequisites OK (host, buildah, mkfs.ext2, Dockerfile)"
echo "==> building OCI image (${OCI_TAG}) from ${DOCKERFILE} [linux/i386]"

# --- 1. Dockerfile -> OCI image -------------------------------------------
# --dns=none: keep the build host's resolver state out of the image — the
# VM has no real network at runtime (peerd-fetch marker protocol only).
buildah build -f "$DOCKERFILE" --dns=none --platform linux/i386 -t "$OCI_TAG"

# --- 2. OCI image -> container -> mounted rootfs -> ext2 ------------------
# The mount + mkfs must run inside one `buildah unshare` session (rootless
# user namespace); we pass the remainder of the flow in as a script.
echo "==> materializing rootfs and packing ext2 (size ${IMAGE_SIZE})"
buildah from --name "$CONTAINER" "$OCI_TAG" >/dev/null

export _OUT_BASENAME="$OUT_BASENAME" _IMAGE_SIZE="$IMAGE_SIZE" _CONTAINER="$CONTAINER"
buildah unshare bash -s <<'INNER'
set -euo pipefail
mnt="$(buildah mount "$_CONTAINER")"
echo "==> rootfs mounted at ${mnt}"
echo "==> rootfs size (allocate ~20% above this; hard cap 2000M):"
du -sh "$mnt"
# -b 4096 matches the block size the stock WebVM images use.
mkfs.ext2 -b 4096 -d "$mnt" "${_OUT_BASENAME}.ext2" "$_IMAGE_SIZE"
buildah umount "$_CONTAINER" >/dev/null
INNER

# --- 3. Cleanup + finalize name with byte size (stock-image convention) ----
buildah rm "$CONTAINER" >/dev/null
buildah rmi "$OCI_TAG" >/dev/null || true

BYTES=$(stat -c %s "${OUT_BASENAME}.ext2")
FINAL="${OUT_BASENAME}_${BYTES}.ext2"
mv "${OUT_BASENAME}.ext2" "$FINAL"
sha256sum "$FINAL" > "${FINAL}.sha256"

echo "==> built: ${FINAL} (${BYTES} bytes)"
echo "==> sha256: $(cut -d' ' -f1 "${FINAL}.sha256")"
cat <<EOF

NEXT STEPS (manual — see docs/engine/VM-IMAGE.md §5):
  1. Attach ${FINAL} + .sha256 to a GitHub release (archive/provenance).
  2. Upload to R2 with: cache-control "public, max-age=31536000, immutable"
     (the bytes behind a published URL must NEVER change — §4).
  3. Verify the origin: curl -r 0-1023 must return 206 + accept-ranges
     + access-control-allow-origin (§5 step 9).
  4. Boot test in the extension with a FRESH VM (never reuse an overlay
     from another image — §4 rule 2).
EOF
