// @ts-check
// VM base-image integrity pin — the pure decision logic.
//
// THE TRUST BOUNDARY, honestly stated: CheerpX's HttpBytesDevice /
// CloudDevice stream the Debian rootfs ext2 image block-by-block from
// inside the vendored runtime (vendor/cheerpx/). There is no hook to
// observe or verify those reads, and a whole-file SRI hash is
// impossible by construction — the device exists precisely so the ~2GB
// image is never downloaded in full. Verifying EVERY streamed block
// would take a per-block hash manifest plus a custom CheerpX block
// device that re-aligns arbitrary byte ranges to manifest chunks; that
// is a wrong-layer hack against a vendored internal and we deliberately
// don't do it (documented gap — see the boot-time why-comment in
// vm-tab.js).
//
// What we CAN do cleanly, and do here: trust-on-first-use pin the
// image's cheap identity — total byte size (from Content-Range) plus
// the SHA-256 of its first 64 KiB — fetched by OUR code (one ranged
// request) before the vendored device ever opens the URL. This targets
// the failure mode that actually corrupts user data per
// docs/engine/VM-IMAGE.md §4: the bytes behind the pinned image URL
// changing after per-VM overlays have cached base blocks (CheerpX has
// NO invalidation mechanism — a changed base silently corrupts every
// existing overlay). It does NOT defend against a malicious host that
// serves a faithful head and tampered tail; that residual risk is the
// documented trust boundary: we trust disks.webvm.io to keep serving
// the same bytes, and we now FAIL CLOSED if the cheap evidence says it
// didn't.
//
// This module is pure (values in, decision out); the vm-tab boot path
// injects the fetch/digest/storage IO.

/**
 * How much of the image head the shell hashes. why 64 KiB and not the
 * first 1 KiB: ext2 reserves bytes 0–1023 for the boot block (commonly
 * all zeros — useless as identity); 64 KiB spans the superblock + group
 * descriptors, which differ per built image, and is still a trivial
 * one-shot ranged fetch.
 */
export const IMAGE_PIN_HEAD_BYTES = 65_536;

/**
 * chrome.storage.local key for the per-URL TOFU fingerprints
 * ({ [url]: { totalBytes, headSha256, pinnedAt } }). Lives here (not in
 * vm-tab.js) because two shells read it: the vm-tab boot path verifies
 * against it, and the SW's artifact export/import routes carry the pin
 * inside vm-recipe envelopes (DESIGN-10).
 */
export const IMAGE_PIN_STORAGE_KEY = 'vmImagePins.v1';

/**
 * Parse the total size out of a Content-Range header
 * (`bytes 0-65535/2000000000`). Returns null when the header is
 * missing/malformed or the server reports an unknown total (`/*`) —
 * callers treat "unknown" as unverifiable rather than a mismatch.
 *
 * @param {string | null | undefined} header
 * @returns {number | null}
 */
export const parseContentRangeTotal = (header) => {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)\s*$/i.exec(header);
  if (!m || m[1] === '*') return null;
  const total = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
};

/**
 * Decide what to do with an observed image fingerprint given the
 * stored pin (if any).
 *
 * @param {Object} args
 * @param {{ totalBytes: number | null, headSha256: string } | null | undefined} args.pinned
 *   The stored fingerprint for this image URL, or null on first boot.
 * @param {{ totalBytes: number | null, headSha256: string }} args.observed
 *   The fingerprint just fetched from the image host.
 * @returns {{ action: 'record' } | { action: 'match' }
 *         | { action: 'mismatch', mismatches: string[] }}
 *   'record'   — no pin yet: persist the observed fingerprint (TOFU).
 *   'match'    — pin holds; safe to hand the URL to CheerpX.
 *   'mismatch' — the bytes behind the URL changed; the boot must FAIL
 *                (streaming a different base under existing overlays is
 *                silent filesystem corruption, VM-IMAGE.md §4 rule 1).
 */
export const evaluateImagePin = ({ pinned, observed }) => {
  if (!pinned) return { action: 'record' };
  const mismatches = [];
  if (pinned.headSha256 !== observed.headSha256) mismatches.push('headSha256');
  // why null-tolerant: a server may stop (or start) reporting a total
  // (`/*`). Only a CONFLICT between two known totals is evidence of a
  // changed image; absence of evidence stays inconclusive and the
  // head hash remains the load-bearing check.
  if (pinned.totalBytes != null && observed.totalBytes != null
      && pinned.totalBytes !== observed.totalBytes) {
    mismatches.push('totalBytes');
  }
  return mismatches.length === 0 ? { action: 'match' } : { action: 'mismatch', mismatches };
};
