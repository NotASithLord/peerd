// @ts-check
// peerd-distributed/content/transfer.js — chunk request/serve (PROTOCOL §4.3).
//
// Phase 0 transfer protocol over one reliable channel. The publisher runs
// a responder; the consumer runs fetchBundle. Point-to-point, parallel
// pulls (α=3), every chunk verified against the signed manifest's hash on
// arrival. Simple by design — WebTorrent-style swarming is deferred
// (PROTOCOL §4.3, ROADMAP).
//
// Wire messages (Phase 0 JSON framing; CBOR is the Phase 1 upgrade):
//   { t:'MANIFEST_REQ', hash }      -> { t:'MANIFEST', hash, manifest }
//                                   or { t:'NOMANIFEST', hash }
//   { t:'CHUNK_REQ', hash }         -> { t:'CHUNK', hash, bytes(base64) }
//                                   or { t:'NOCHUNK', hash }
// A CHUNK_REQ with requestId opts into bounded CHUNK parts carrying that id,
// offset and total size. Missing requestId preserves the legacy whole reply.

import {
  manifestHash, verifyManifest, assertBundleWithinLimits, decodeCommittedChunk,
} from './manifest.js';
import { CHUNK_SIZE, sha256hex } from './chunk.js';
import { parsePeerdUri } from './uri.js';
import { toBase64, concat } from '/shared/bundle/bytes.js';
import { contentServiceBudget } from './service-budget.js';

const ALPHA = 3; // lookup/transfer parallelism (PROTOCOL §5.1)
// why: a signed chunk's base64 JSON exceeds SCTP's negotiated message limit.
// Slice the wire representation, never the immutable manifest/chunk hashes.
// This also fits the WebRTC default when a peer omits max-message-size in SDP.
export const CHUNK_PART_BYTES = 48_000;

class ChunkPartError extends Error {
  constructor() { super('invalid chunk part bounds'); this.name = 'ChunkPartError'; }
}

/**
 * A wire message in the Phase 0 content protocol — JSON-framed, so every
 * field is wire-decoded and validated at runtime by the switch below.
 * @typedef {{ t: string, hash: string, manifest?: any, bytes?: string,
 *   requestId?: string, offset?: number, size?: number }} ContentMsg
 * @typedef {{
 *   getManifest: (hash: string) => any,
 *   getChunk: (chunkHash: string) => (Uint8Array | null | undefined),
 * }} ContentStore
 * @typedef {{ send: (m: ContentMsg, options?: import('../transport/outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: ((msg: ContentMsg) => void) | null) => void, onClose?: (cb: () => void) => (() => void) }} ContentChannel
 */

// Publisher side: a handler (msg, send) the channel routes inbound
// content requests to. Serves only what the store has announced.
/**
 * @param {{ store: ContentStore, budget?: typeof contentServiceBudget }} deps
 * @returns {(msg: ContentMsg, send: (m: ContentMsg) => void | Promise<void>, owner?: object) => Promise<void>}
 */
export const createContentResponder = ({ store, budget = contentServiceBudget }) => {
  const defaultOwner = {};
  return (msg, send, owner = defaultOwner) => budget.run(owner, async () => {
    switch (msg && msg.t) {
      case 'MANIFEST_REQ': {
        const manifest = store.getManifest(msg.hash);
        await send(manifest ? { t: 'MANIFEST', hash: msg.hash, manifest } : { t: 'NOMANIFEST', hash: msg.hash });
        return;
      }
      case 'CHUNK_REQ': {
        const bytes = store.getChunk(msg.hash);
        if (typeof msg.requestId === 'string' && msg.requestId.length > 0 && msg.requestId.length <= 64) {
          if (!bytes) { await send({ t: 'NOCHUNK', hash: msg.hash, requestId: msg.requestId }); return; }
          for (let offset = 0; offset < bytes.length; offset += CHUNK_PART_BYTES) {
            await send({ t: 'CHUNK', hash: msg.hash, requestId: msg.requestId, offset, size: bytes.length,
              bytes: toBase64(bytes.subarray(offset, offset + CHUNK_PART_BYTES)) });
          }
          return;
        }
        await send(bytes ? { t: 'CHUNK', hash: msg.hash, bytes: toBase64(bytes) } : { t: 'NOCHUNK', hash: msg.hash });
        return;
      }
      default: return;
    }
  });
};

// A thin request/response client over one content channel (the correlation layer
// fetchBundle keeps private, factored out so the swarm can run N of them).
/**
 * @param {ContentChannel} channel
 * @param {number} timeoutMs
 */
export const createChannelClient = (channel, timeoutMs) => {
  /** @type {Map<string, (msg: ContentMsg) => void>} */
  const pending = new Map(); // `${t}:${hash}` -> settle
  /** @type {Set<(error: Error) => void>} */
  const cancel = new Set();
  /** @type {Set<() => void>} */
  const deadlines = new Set();
  let closed = false;
  let offClose = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    offClose();
    channel.setHandler(null);
    for (const fail of [...cancel]) fail(new Error('content client closed'));
  };
  channel.setHandler((msg) => {
    if (!msg || typeof msg.t !== 'string') return;
    const settle = pending.get(`${msg.t}:${msg.hash}`);
    if (settle) settle(msg);
  });
  // why: a lost link is already a known miss; do not hold its requests until
  // their timeout. Closed channels may notify synchronously on subscription.
  offClose = channel.onClose?.(close) ?? offClose;
  if (closed) offClose();
  /**
   * @param {string} reqType
   * @param {string[]} respTypes
   * @param {string} h
   * @param {AbortSignal} [signal]
   * @returns {Promise<ContentMsg>}
   */
  const req = (reqType, respTypes, h, signal) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('content client closed')); return; }
    if (signal?.aborted) { reject(new Error('content request cancelled')); return; }
    if (respTypes.some((rt) => pending.has(`${rt}:${h}`))) {
      reject(new Error('duplicate content request')); return;
    }
    let settled = false;
    const requestId = reqType === 'CHUNK_REQ' ? crypto.randomUUID() : undefined;
    /** @type {Uint8Array | null} */
    let parts = null;
    let received = 0;
    const sending = new AbortController();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const armResponseDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('transfer timeout')), timeoutMs);
    };
    const cleanup = () => {
      parts = null;
      clearTimeout(timer);
      for (const rt of respTypes) pending.delete(`${rt}:${h}`);
      cancel.delete(fail);
      deadlines.delete(armResponseDeadline);
      signal?.removeEventListener('abort', abort);
      sending.abort();
    };
    /** @param {Error} error */
    const fail = (error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    /** @param {ContentMsg} msg */
    const settle = (msg) => {
      if (settled) return;
      // why: concurrent downloads share a link and may request the same hash.
      // Their fragment streams must never complete or corrupt each other.
      if (msg.requestId !== undefined && msg.requestId !== requestId) return;
      // The reliable ordered channel can make one of several concurrent chunk
      // requests wait behind another. Any correlated response proves that the
      // shared path is progressing, so none of this client's requests is idle.
      for (const arm of deadlines) arm();
      if (msg.t === 'CHUNK' && msg.requestId !== undefined) {
        const size = msg.size;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > CHUNK_SIZE
          || msg.offset !== received || (parts && parts.length !== size)) {
          fail(new ChunkPartError()); return;
        }
        try {
          const bytes = decodeCommittedChunk(msg.bytes, Math.min(CHUNK_PART_BYTES, size - received));
          parts ??= new Uint8Array(size);
          parts.set(bytes, received);
          received += bytes.length;
          // why: a bounded, valid part proves forward progress. A single
          // absolute deadline turns a healthy high-latency chunk into failure;
          // the fixed part count still bounds how long a malicious drip can live.
          if (received < parts.length) { armResponseDeadline(); return; }
          msg = { t: 'CHUNK', hash: h, bytes: toBase64(parts) };
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
      settled = true; cleanup(); resolve(msg);
    };
    const abort = () => fail(new Error('content request cancelled'));
    for (const rt of respTypes) pending.set(`${rt}:${h}`, settle);
    cancel.add(fail);
    deadlines.add(armResponseDeadline);
    // Queue wait has its own bound. The response clock starts only once the
    // request reaches the native transport; synchronous responses still win.
    timer = setTimeout(() => fail(new Error('content send timed out')), 15_000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      Promise.resolve(channel.send({ t: reqType, hash: h, ...(requestId ? { requestId } : {}) }, { signal: sending.signal })).then(() => {
        if (settled) return;
        armResponseDeadline();
      }, (error) => fail(error instanceof Error ? error : new Error(String(error))));
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  return {
    /** @param {string} h @param {AbortSignal} [signal] */
    manifest: (h, signal) => req('MANIFEST_REQ', ['MANIFEST', 'NOMANIFEST'], h, signal),
    /** @param {string} h */
    chunk: (h) => req('CHUNK_REQ', ['CHUNK', 'NOCHUNK'], h),
    close,
  };
};

/**
 * Consumer side: fetch + verify a whole bundle over `channel`.
 * `channel` is a buffered channel ({ send, setHandler }). Returns
 * { manifest, payload } with payload integrity guaranteed by the chunk
 * hashes the (verified) manifest commits to.
 *
 * @param {{
 *   uri: string,
 *   channel: { send: (msg: any, options?: import('../transport/outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: ((msg: ContentMsg) => void) | null) => void },
 *   onProgress?: (p: { phase: string, done?: number, total?: number, publisher?: string | null }) => void,
 *   timeoutMs?: number,
 * }} opts
 * @returns {Promise<{ manifest: any, payload: Uint8Array }>}
 */
export const fetchBundle = async ({ uri, channel, onProgress, timeoutMs = 15000 } = /** @type {{ uri: string, channel: { send: (msg: any, options?: import('../transport/outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: ((msg: ContentMsg) => void) | null) => void } }} */ ({})) => {
  const { hash } = parsePeerdUri(uri);

  const client = createChannelClient(channel, timeoutMs);
  try {
    // 1. Manifest.
    const manResp = await client.manifest(hash);
    if (manResp.t === 'NOMANIFEST') throw new Error(`peer does not hold ${hash}`);
    // why typed shape: the manifest is wire-decoded JSON; its integrity is
    // enforced at runtime (hash + signature checks below), and the chunk-list
    // shape is what manifestHash/verifyManifest already committed to.
    /** @type {{ chunks: Array<{ hash: string, size: number }>, size: number } & Record<string, any>} */
    const manifest = manResp.manifest;

    // 2. Bound shape before canonicalization/signature work; signed hostile
    // manifests are still hostile inputs.
    assertBundleWithinLimits(manifest);
    const computed = await manifestHash(manifest);
    if (computed !== hash) throw new Error('manifest hash mismatch: content address does not match payload');
    const v = await verifyManifest(manifest);
    if (!v.ok) throw new Error(`manifest signature invalid: ${v.reason}`);
    onProgress?.({ phase: 'manifest', publisher: v.publisher, total: manifest.chunks.length });

    // 3. Fetch unique chunk hashes in parallel (dedup so identical chunks
    //    are fetched once and key collisions are impossible).
    const uniqueHashes = [...new Set(manifest.chunks.map((c) => c.hash))];
    const expectedSizes = new Map(manifest.chunks.map((c) => [c.hash, c.size]));
    /** @type {Map<string, Uint8Array>} */
    const byHash = new Map();
    let idx = 0;
    let done = 0;
    const worker = async () => {
      while (idx < uniqueHashes.length) {
        const h = uniqueHashes[idx++];
        const resp = await client.chunk(h);
        if (resp.t === 'NOCHUNK') throw new Error(`chunk unavailable: ${h}`);
        // why cast: a CHUNK reply carries bytes (a NOCHUNK was rejected above);
        // the field is wire-decoded and re-verified by the hash check below.
        const bytes = decodeCommittedChunk(resp.bytes, /** @type {number} */ (expectedSizes.get(h)));
        const got = await sha256hex(bytes);
        if (got !== h) throw new Error(`chunk hash mismatch (tamper?): ${h}`);
        byHash.set(h, bytes);
        done++;
        onProgress?.({ phase: 'chunk', done, total: uniqueHashes.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(ALPHA, uniqueHashes.length || 1) }, worker));

    // 4. Reassemble in manifest order; final size check.
    // why non-null: every manifest chunk hash was fetched into byHash above
    // (a missing chunk throws in the worker before we reach reassembly).
    const payload = concat(...manifest.chunks.map((c) => /** @type {Uint8Array} */ (byHash.get(c.hash))));
    if (payload.length !== manifest.size) throw new Error('reassembled size mismatch');
    // v2 commits the complete stored representation in addition to its chunks.
    // Check it here, before the loader is allowed to start decompression.
    if (manifest.v === 2 && await sha256hex(payload) !== manifest.bundle.compressedHash) {
      throw new Error('compressed bundle hash mismatch');
    }

    return { manifest, payload };
  } finally { client.close(); }
};
