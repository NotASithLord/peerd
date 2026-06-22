// @ts-check
// peerd-distributed/content/swarm.js — multi-provider bundle fetch (Plane 2).
//
// "Give me this content, from any peer who can provide it, or multiple peers."
// fetchBundle (transfer.js) pulls a whole bundle from ONE channel; swarmFetch
// pulls ONE bundle from MANY providers at once: the manifest from whichever
// answers first, then chunks STRIPED across providers (α concurrent) with
// per-chunk failover — a provider that NOCHUNKs or stalls just loses that chunk
// to another. This is what makes a big WASM bundle feasible: you don't depend on
// one seeder's uplink (PROPAGATION.md "big apps").
//
// Channels are INJECTED (channelFor(did) → a content channel, or null if we hold
// no link to that provider). In the sim + today's mesh that's the linked peers;
// the per-hop DIALER extends channelFor to providers we don't link yet (the DHT
// dialer hook, dht/transport.js). Integrity is unchanged: every chunk is verified
// against the signed manifest's hash, so a malicious provider can't corrupt a
// byte — it can only fail to serve, which failover covers.

import { manifestHash, verifyManifest } from './manifest.js';
import { sha256hex } from './chunk.js';
import { parsePeerdUri } from './uri.js';
import { fromBase64, concat } from '/shared/bundle/bytes.js';

const ALPHA = 3;

/**
 * A wire message in the content protocol — JSON-framed, every field is
 * wire-decoded and validated at runtime (hash + signature checks below).
 * @typedef {{ t: string, hash: string, manifest?: any, bytes?: string }} ContentMsg
 * @typedef {{ send: (m: ContentMsg) => void, setHandler: (h: ((msg: ContentMsg) => void) | null) => void }} ContentChannel
 */

// A thin request/response client over one content channel (the correlation layer
// fetchBundle keeps private, factored out so the swarm can run N of them).
/**
 * @param {ContentChannel} channel
 * @param {number} timeoutMs
 */
const createChannelClient = (channel, timeoutMs) => {
  /** @type {Map<string, (msg: ContentMsg) => void>} */
  const pending = new Map(); // `${t}:${hash}` -> settle
  channel.setHandler((msg) => {
    if (!msg || typeof msg.t !== 'string') return;
    const settle = pending.get(`${msg.t}:${msg.hash}`);
    if (settle) settle(msg);
  });
  /**
   * @param {string} reqType
   * @param {string[]} respTypes
   * @param {string} h
   * @returns {Promise<ContentMsg>}
   */
  const req = (reqType, respTypes, h) => new Promise((resolve, reject) => {
    /** @param {ContentMsg} msg */
    const settle = (msg) => { clearTimeout(timer); for (const rt of respTypes) pending.delete(`${rt}:${h}`); resolve(msg); };
    for (const rt of respTypes) pending.set(`${rt}:${h}`, settle);
    const timer = setTimeout(() => { for (const rt of respTypes) pending.delete(`${rt}:${h}`); reject(new Error('timeout')); }, timeoutMs);
    channel.send({ t: reqType, hash: h });
  });
  return {
    /** @param {string} h */
    manifest: (h) => req('MANIFEST_REQ', ['MANIFEST', 'NOMANIFEST'], h),
    /** @param {string} h */
    chunk: (h) => req('CHUNK_REQ', ['CHUNK', 'NOCHUNK'], h),
    close: () => channel.setHandler(null),
  };
};

/** @typedef {ReturnType<typeof createChannelClient>} ChannelClient */

/**
 * @param {{
 *   uri: string,
 *   providers: string[],                                       // candidate provider dids
 *   channelFor: (did: string) => (ContentChannel | null),     // a content channel, or null if unreachable
 *   onProgress?: (p: any) => void,
 *   timeoutMs?: number,
 *   alpha?: number,
 * }} opts
 * @returns {Promise<{ manifest: any, payload: Uint8Array, providers: string[] }>}
 */
export const swarmFetch = async ({ uri, providers, channelFor, onProgress, timeoutMs = 15000, alpha = ALPHA }) => {
  const { hash } = parsePeerdUri(uri);
  /** @type {Array<{ did: string, client: ChannelClient }>} */
  const clients = [];
  for (const did of [...new Set(providers)]) {
    const ch = channelFor(did);
    if (ch) clients.push({ did, client: createChannelClient(ch, timeoutMs) });
  }
  if (!clients.length) throw new Error(`swarm: no reachable provider for ${hash}`);

  try {
    // 1. Manifest — from whichever provider answers; failover past NOMANIFEST.
    // why typed shape: the manifest is wire-decoded JSON re-verified at
    // runtime (hash + signature below); chunks is what verifyManifest commits to.
    /** @type {({ chunks: Array<{ hash: string, size: number }>, size: number } & Record<string, any>) | null} */
    let manifest = null;
    for (const { client } of clients) {
      try { const m = await client.manifest(hash); if (m.t === 'MANIFEST') { manifest = m.manifest; break; } }
      catch { /* try the next provider */ }
    }
    if (!manifest) throw new Error(`no reachable provider holds ${hash}`);

    // 2. Verify the address commits to this manifest, then the signature.
    if (await manifestHash(manifest) !== hash) throw new Error('manifest hash mismatch — address does not match payload');
    const v = await verifyManifest(manifest);
    if (!v.ok) throw new Error(`manifest signature invalid: ${v.reason}`);
    onProgress?.({ phase: 'manifest', publisher: v.publisher, total: manifest.chunks.length, providers: clients.length });

    // 3. Stripe unique chunks across providers — α concurrent, per-chunk failover.
    const uniqueHashes = [...new Set(manifest.chunks.map((c) => c.hash))];
    /** @type {Map<string, Uint8Array>} */
    const byHash = new Map();
    const queue = [...uniqueHashes];
    let done = 0;
    let rr = 0; // round-robin start so load spreads across providers
    const worker = async () => {
      /** @type {string | undefined} */
      let h;
      while ((h = queue.shift()) !== undefined) {
        const start = rr++ % clients.length;
        /** @type {Uint8Array | null} */
        let got = null;
        for (let j = 0; j < clients.length && !got; j++) {
          const { client } = clients[(start + j) % clients.length];
          try {
            const resp = await client.chunk(h);
            if (resp.t === 'CHUNK') {
              // why cast: a CHUNK reply carries bytes; re-verified by the
              // hash check on the next line.
              const bytes = fromBase64(/** @type {string} */ (resp.bytes));
              if (await sha256hex(bytes) === h) got = bytes; // tamper → treat as a miss, try next provider
            }
          } catch { /* miss → next provider */ }
        }
        if (!got) throw new Error(`chunk unavailable on all providers: ${h}`);
        byHash.set(h, got);
        onProgress?.({ phase: 'chunk', done: ++done, total: uniqueHashes.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(alpha, uniqueHashes.length || 1) }, worker));

    // 4. Reassemble in manifest order; final size check.
    // why non-null: every manifest chunk hash was fetched into byHash above
    // (a missing chunk throws in the worker before we reach reassembly).
    const payload = concat(...manifest.chunks.map((c) => /** @type {Uint8Array} */ (byHash.get(c.hash))));
    if (payload.length !== manifest.size) throw new Error('reassembled size mismatch');
    return { manifest, payload, providers: clients.map((c) => c.did) };
  } finally {
    for (const { client } of clients) client.close();
  }
};
