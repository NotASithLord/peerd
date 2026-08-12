// @ts-check
// peerd-distributed/self/sync.js: the self-device state-transfer protocol.
//
// A versioned, surface-oriented replication protocol for AUTHENTICATED
// self-device links (handshake.js must have marked the link; hosts enforce
// that before any frame here is answered, issue invariant 12). It never
// moves raw IndexedDB/OPFS stores; each surface is an explicit LOGICAL
// payload the runtime shapes (peerd-runtime/transfer/self-sync.js) and the
// receiver re-materializes.
//
// Wire shape, designed for interruption:
//   SYNC_OFFER     the source's snapshot manifest, per-surface byte size +
//                  SHA-256, so the receiver knows exactly what a complete
//                  transfer looks like before asking for anything.
//   SYNC_PULL      the receiver asks for ONE surface (its choice, its
//                  order, its retry, pulls are idempotent).
//   SYNC_CHUNK     bounded chunks of that surface's bytes.
//   SYNC_REFUSE    an honest per-surface refusal (consent withheld,
//                  unknown surface, oversize).
//
// The receiver verifies each surface against the offered hash before
// applying it, applies surfaces independently (a torn transfer leaves
// whole surfaces present or absent, never half-written), and can re-pull
// any surface after a drop: same snapshotId, same bytes, same hash.
//
// Secrets ride the SAME mechanics but are consent-gated at the source
// (the runtime includes the surface only when the user approved), the
// protocol itself treats them as one more named surface.

import { utf8, fromUtf8, toBase64, fromBase64, toHex } from '/shared/bundle/bytes.js';

export const SYNC_PROTO = 1;
export const SNAPSHOT_VERSION = 1;

// The closed set of logical surfaces this protocol speaks. Growing it is a
// protocol version decision, not a payload option: an unknown name in an
// offer is refused, never "applied generically" (issue invariant 18: a
// hostile payload must not be able to invent a surface that writes
// somewhere new).
export const SYNC_SURFACES = Object.freeze([
  'settings',
  'providerEndpoints',
  'memory',
  'hooks',
  'skills',
  'sessions',
  'apps',
  'workspaces',
  'secrets',
]);

// Per-surface byte ceilings, transport sanity, not storage policy. The
// generous workspace cap still bounds a hostile offer to something a
// receiving profile can hold.
const SURFACE_BYTE_CAPS = Object.freeze({
  settings: 256 * 1024,
  providerEndpoints: 256 * 1024,
  memory: 16 * 1024 * 1024,
  hooks: 1024 * 1024,
  skills: 1024 * 1024,
  sessions: 64 * 1024 * 1024,
  apps: 64 * 1024 * 1024,
  workspaces: 128 * 1024 * 1024,
  secrets: 1024 * 1024,
});

// why 48 KiB: WebRTC data channels fragment poorly above 64 KiB and the
// mesh envelope adds framing; 48 KiB payload keeps every SYNC_CHUNK frame
// comfortably under the channel's safe message size.
export const SYNC_CHUNK_BYTES = 48 * 1024;
const MAX_SNAPSHOT_ID = 64;
const MAX_LABEL = 64;

/** @param {Uint8Array} bytes */
export const surfaceHash = async (bytes) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes))));

/**
 * @typedef {{ name: string, version: number, bytes: number, hash: string, count?: number }} SurfaceEntry
 * @typedef {{ v: number, snapshotId: string, createdAt: number, label?: string,
 *   surfaces: SurfaceEntry[] }} SnapshotManifest
 */

/**
 * Build the offer manifest from shaped surface payloads.
 *
 * @param {Object} args
 * @param {Record<string, { bytes: Uint8Array, version: number, count?: number }>} args.surfaces
 * @param {string} [args.snapshotId]
 * @param {string} [args.label]  the source device's human label
 * @param {number} [args.now]
 * @returns {Promise<{ manifest: SnapshotManifest, payloads: Map<string, Uint8Array> }>}
 */
export const buildSnapshotOffer = async ({ surfaces, snapshotId, label, now }) => {
  /** @type {SurfaceEntry[]} */
  const entries = [];
  /** @type {Map<string, Uint8Array>} */
  const payloads = new Map();
  for (const [name, surface] of Object.entries(surfaces)) {
    if (!SYNC_SURFACES.includes(name)) throw new Error(`unknown sync surface ${name}`);
    const cap = SURFACE_BYTE_CAPS[/** @type {keyof typeof SURFACE_BYTE_CAPS} */ (name)];
    if (surface.bytes.length > cap) {
      throw new Error(`surface ${name} exceeds its transfer cap (${surface.bytes.length} > ${cap})`);
    }
    entries.push({
      name,
      version: surface.version,
      bytes: surface.bytes.length,
      hash: await surfaceHash(surface.bytes),
      ...(surface.count !== undefined ? { count: surface.count } : {}),
    });
    payloads.set(name, surface.bytes);
  }
  return {
    manifest: {
      v: SNAPSHOT_VERSION,
      snapshotId: snapshotId ?? crypto.randomUUID(),
      createdAt: now ?? Date.now(),
      ...(label ? { label } : {}),
      surfaces: entries,
    },
    payloads,
  };
};

/**
 * Structural validation of a received offer, bounds before anything is
 * pulled or shown to the user.
 *
 * @param {any} manifest
 * @returns {string | null}
 */
export const validateSnapshotManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object') return 'not-an-object';
  if (manifest.v !== SNAPSHOT_VERSION) return `unsupported-version-${manifest.v}`;
  if (typeof manifest.snapshotId !== 'string' || manifest.snapshotId.length === 0
      || manifest.snapshotId.length > MAX_SNAPSHOT_ID) return 'bad-snapshot-id';
  if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0) return 'bad-created-at';
  if (manifest.label !== undefined
      && (typeof manifest.label !== 'string' || manifest.label.length === 0
        || manifest.label.length > MAX_LABEL)) return 'bad-label';
  if (!Array.isArray(manifest.surfaces) || manifest.surfaces.length > SYNC_SURFACES.length) {
    return 'bad-surfaces';
  }
  const seen = new Set();
  for (const entry of manifest.surfaces) {
    if (!entry || typeof entry !== 'object') return 'bad-surface';
    if (!SYNC_SURFACES.includes(entry.name)) return `unknown-surface-${String(entry.name).slice(0, 32)}`;
    if (seen.has(entry.name)) return 'duplicate-surface';
    seen.add(entry.name);
    if (!Number.isSafeInteger(entry.version) || entry.version < 1) return 'bad-surface-version';
    const cap = SURFACE_BYTE_CAPS[/** @type {keyof typeof SURFACE_BYTE_CAPS} */ (entry.name)];
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > cap) {
      return 'bad-surface-bytes';
    }
    if (typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash)) return 'bad-surface-hash';
    if (entry.count !== undefined
        && (!Number.isSafeInteger(entry.count) || entry.count < 0)) return 'bad-surface-count';
  }
  return null;
};

// ── frames ───────────────────────────────────────────────────────────

/** @param {SnapshotManifest} manifest */
export const buildSyncOffer = (manifest) => ({ t: 'SYNC_OFFER', proto: SYNC_PROTO, manifest });

/** @param {{ snapshotId: string, surface: string }} args */
export const buildSyncPull = ({ snapshotId, surface }) => ({
  t: 'SYNC_PULL', proto: SYNC_PROTO, snapshotId, surface,
});

/** @param {{ snapshotId: string, surface: string, reason: string }} args */
export const buildSyncRefuse = ({ snapshotId, surface, reason }) => ({
  t: 'SYNC_REFUSE', proto: SYNC_PROTO, snapshotId, surface, reason: String(reason).slice(0, 64),
});

/**
 * Slice one surface's bytes into bounded chunk frames.
 * @param {{ snapshotId: string, surface: string, bytes: Uint8Array }} args
 */
export const buildSyncChunks = ({ snapshotId, surface, bytes }) => {
  const total = Math.max(1, Math.ceil(bytes.length / SYNC_CHUNK_BYTES));
  /** @type {Array<{ t: string, proto: number, snapshotId: string, surface: string, seq: number, total: number, data: string }>} */
  const frames = [];
  for (let seq = 0; seq < total; seq++) {
    frames.push({
      t: 'SYNC_CHUNK',
      proto: SYNC_PROTO,
      snapshotId,
      surface,
      seq,
      total,
      data: toBase64(bytes.slice(seq * SYNC_CHUNK_BYTES, (seq + 1) * SYNC_CHUNK_BYTES)),
    });
  }
  return frames;
};

/**
 * A pull's validity from the source's side: known snapshot, known surface,
 * present in the offer. (The self-device link check happens before this
 * hosts refuse non-self peers at the routing layer.)
 *
 * @param {any} pull
 * @param {{ manifest: SnapshotManifest }} context
 * @returns {string | null}
 */
export const validateSyncPull = (pull, { manifest }) => {
  if (!pull || typeof pull !== 'object' || pull.t !== 'SYNC_PULL') return 'not-sync-pull';
  if (pull.proto !== SYNC_PROTO) return 'unsupported-proto';
  if (pull.snapshotId !== manifest.snapshotId) return 'unknown-snapshot';
  if (!manifest.surfaces.some((entry) => entry.name === pull.surface)) return 'unknown-surface';
  return null;
};

/**
 * The receiver's per-surface reassembly. Feed frames in any order;
 * `complete` fires exactly once with hash-verified bytes, `failed` on any
 * structural or integrity defect. A failed surface can simply be re-pulled
 * (fresh collector): that is the whole interruption story.
 *
 * @param {Object} args
 * @param {SurfaceEntry} args.entry  the offer's manifest row for this surface
 * @param {string} args.snapshotId
 */
export const createSurfaceCollector = ({ entry, snapshotId }) => {
  /** @type {Map<number, Uint8Array>} */
  const chunks = new Map();
  /** @type {number | null} */
  let expectedTotal = null;
  let settled = false;

  /**
   * @param {any} frame
   * @returns {Promise<
   *   | { state: 'collecting', have: number, total: number | null }
   *   | { state: 'complete', bytes: Uint8Array }
   *   | { state: 'failed', defect: string }>}
   */
  const accept = async (frame) => {
    if (settled) return { state: 'failed', defect: 'already-settled' };
    /** @param {string} defect */
    const fail = (defect) => { settled = true; return { state: /** @type {const} */ ('failed'), defect }; };
    if (!frame || typeof frame !== 'object' || frame.t !== 'SYNC_CHUNK') return fail('not-sync-chunk');
    if (frame.proto !== SYNC_PROTO) return fail('unsupported-proto');
    if (frame.snapshotId !== snapshotId || frame.surface !== entry.name) return fail('wrong-surface');
    if (!Number.isSafeInteger(frame.total) || frame.total < 1
        || frame.total > Math.ceil(entry.bytes / SYNC_CHUNK_BYTES) + 1) return fail('bad-total');
    if (expectedTotal === null) expectedTotal = /** @type {number} */ (frame.total);
    if (frame.total !== expectedTotal) return fail('total-changed');
    const total = expectedTotal; // non-null past the guard above
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq >= total) return fail('bad-seq');
    if (typeof frame.data !== 'string') return fail('bad-data');
    /** @type {Uint8Array} */
    let data;
    try {
      data = fromBase64(frame.data);
    } catch {
      return fail('bad-data');
    }
    if (data.length > SYNC_CHUNK_BYTES) return fail('chunk-oversize');
    if (!chunks.has(frame.seq)) chunks.set(frame.seq, data);
    if (chunks.size < total) {
      return { state: 'collecting', have: chunks.size, total };
    }
    let length = 0;
    for (const part of chunks.values()) length += part.length;
    if (length !== entry.bytes) return fail('size-mismatch');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (let seq = 0; seq < total; seq++) {
      const part = chunks.get(seq);
      if (!part) return fail('missing-chunk');
      bytes.set(part, offset);
      offset += part.length;
    }
    if (await surfaceHash(bytes) !== entry.hash) return fail('hash-mismatch');
    settled = true;
    return { state: 'complete', bytes };
  };

  return Object.freeze({ accept });
};

// ── retry taxonomy ───────────────────────────────────────────────────
//
// What a receiver should DO about each defect the collector can raise.
// The honest answer for every one of them is "stop": each is a property of
// the bytes the source served measured against the manifest it already
// committed to, so re-pulling the same surface of the same snapshot
// reproduces the same defect exactly. A re-pull is not recovery there, it
// is an unbounded request/reply loop with a peer that is either buggy or
// hostile, and the restore never settles.
//
// why a table and not a bare `return 'terminal'`: this is the place a
// future transient defect (a genuinely resumable one) would be added, and
// naming the disposition per defect keeps that decision explicit instead of
// hidden in a receiver's control flow.
//
// Actual interruption has the opposite shape: it produces NO defect at all,
// just silence. That is the receiver's stall timer's job (host.js), and it
// is the only thing that earns a bounded, backed-off retry.
export const SYNC_DEFECT_DISPOSITIONS = Object.freeze({
  // A late duplicate chunk for a surface that already completed. Not a
  // failure of anything: drop it and leave the settled surface alone.
  'already-settled': 'ignore',
  'not-sync-chunk': 'terminal',
  'unsupported-proto': 'terminal',
  'wrong-surface': 'terminal',
  'bad-total': 'terminal',
  'total-changed': 'terminal',
  'bad-seq': 'terminal',
  'bad-data': 'terminal',
  'chunk-oversize': 'terminal',
  'size-mismatch': 'terminal',
  'missing-chunk': 'terminal',
  'hash-mismatch': 'terminal',
});

/**
 * Fail closed: a defect this build does not recognise is terminal, never
 * a licence to keep pulling.
 *
 * @param {string} defect
 * @returns {'ignore' | 'retry' | 'terminal'}
 */
export const syncDefectDisposition = (defect) =>
  /** @type {'ignore' | 'retry' | 'terminal'} */ (
    SYNC_DEFECT_DISPOSITIONS[/** @type {keyof typeof SYNC_DEFECT_DISPOSITIONS} */ (defect)] ?? 'terminal'
  );

/** Decode a completed surface's bytes back into its logical payload. */
/** @param {Uint8Array} bytes */
export const decodeSurfacePayload = (bytes) => JSON.parse(fromUtf8(bytes));

/** Encode a logical payload into transferable surface bytes. */
/** @param {unknown} payload */
export const encodeSurfacePayload = (payload) => utf8(JSON.stringify(payload));
