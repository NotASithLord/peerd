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

import {
  manifestHash, verifyManifest, assertBundleWithinLimits, decodeCommittedChunk,
} from './manifest.js';
import { sha256hex } from './chunk.js';
import { parsePeerdUri } from './uri.js';
import { createChannelClient } from './transfer.js';
import { concat } from '/shared/bundle/bytes.js';

const ALPHA = 3;

/**
 * A wire message in the content protocol — JSON-framed, every field is
 * wire-decoded and validated at runtime (hash + signature checks below).
 * @typedef {{ t: string, hash: string, manifest?: any, bytes?: string }} ContentMsg
 * @typedef {{ send: (m: ContentMsg, options?: import('../transport/outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: ((msg: ContentMsg) => void) | null) => void, onClose?: (cb: () => void) => (() => void) }} ContentChannel
 */

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
 * @returns {Promise<{ manifest: any, payload: Uint8Array, providers: string[], verifiedContributors: string[] }>}
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

  // why: reachable candidates are not evidence of useful bytes. Keep the
  // original providers list separate from verified chunk contributors, and
  // expose evidence only after whole-bundle verification succeeds.
  const verifiedContributors = new Set();
  try {
    // why: a silent early provider must not suppress a healthy neighbor.
    // Bound concurrent requests, verify each candidate before winning, and
    // cancel only losing manifest requests so clients remain usable for chunks.
    const selection = new AbortController();
    let nextProvider = 0;
    /** @returns {Promise<{ chunks: Array<{ hash: string, size: number }>, size: number } & Record<string, any>>} */
    const candidate = async () => {
      while (!selection.signal.aborted && nextProvider < clients.length) {
        const { client } = clients[nextProvider++];
        try {
          const response = await client.manifest(hash, selection.signal);
          if (response.t !== 'MANIFEST') continue;
          const manifest = response.manifest;
          assertBundleWithinLimits(manifest);
          if (await manifestHash(manifest) !== hash) continue;
          if (!(await verifyManifest(manifest)).ok) continue;
          return manifest;
        } catch { /* try the next provider until selection completes */ }
      }
      throw new Error('no valid manifest from candidate providers');
    };
    let manifest;
    try {
      manifest = await Promise.any(Array.from({ length: Math.min(ALPHA, clients.length) }, candidate));
    } catch {
      throw new Error(`no reachable provider holds ${hash}`);
    } finally { selection.abort(); }
    onProgress?.({ phase: 'manifest', publisher: manifest.publisher, total: manifest.chunks.length, providers: clients.length });

    // 3. Stripe unique chunks across providers — α concurrent, per-chunk failover.
    const uniqueHashes = [...new Set(manifest.chunks.map((c) => c.hash))];
    const expectedSizes = new Map(manifest.chunks.map((c) => [c.hash, c.size]));
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
          const { did, client } = clients[(start + j) % clients.length];
          try {
            const resp = await client.chunk(h);
            if (resp.t === 'CHUNK') {
              // why cast: a CHUNK reply carries bytes; re-verified by the
              // hash check on the next line.
              const bytes = decodeCommittedChunk(resp.bytes, /** @type {number} */ (expectedSizes.get(h)));
              if (await sha256hex(bytes) === h) {
                got = bytes;
                verifiedContributors.add(did);
              } // tamper → treat as a miss, try next provider
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
    if (manifest.v === 2 && await sha256hex(payload) !== manifest.bundle.compressedHash) {
      throw new Error('compressed bundle hash mismatch');
    }
    return { manifest, payload, providers: clients.map((c) => c.did), verifiedContributors: [...verifiedContributors] };
  } finally {
    for (const { client } of clients) client.close();
  }
};
