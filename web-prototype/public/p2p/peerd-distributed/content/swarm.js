// peerd-distributed/content/swarm.js — multi-provider bundle fetch (Plane 2).
//
// "Give me this content, from any peer who can provide it, or multiple peers."
// fetchBundle (transfer.js) pulls a whole bundle from ONE channel; swarmFetch
// pulls ONE bundle from MANY providers at once: the manifest from whichever
// answers first, then chunks STRIPED across providers (α concurrent) with
// per-chunk failover — a provider that NOCHUNKs or stalls just loses that chunk
// to another. This is what makes a big WASM bundle feasible: you don't depend on
// one seeder's uplink (the "big apps" case).
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

// A thin request/response client over one content channel (the correlation layer
// fetchBundle keeps private, factored out so the swarm can run N of them).
const createChannelClient = (channel, timeoutMs) => {
  const pending = new Map(); // `${t}:${hash}` -> settle
  channel.setHandler((msg) => {
    if (!msg || typeof msg.t !== 'string') return;
    const settle = pending.get(`${msg.t}:${msg.hash}`);
    if (settle) settle(msg);
  });
  const req = (reqType, respTypes, h) => new Promise((resolve, reject) => {
    const settle = (msg) => { clearTimeout(timer); for (const rt of respTypes) pending.delete(`${rt}:${h}`); resolve(msg); };
    for (const rt of respTypes) pending.set(`${rt}:${h}`, settle);
    const timer = setTimeout(() => { for (const rt of respTypes) pending.delete(`${rt}:${h}`); reject(new Error('timeout')); }, timeoutMs);
    channel.send({ t: reqType, hash: h });
  });
  return {
    manifest: (h) => req('MANIFEST_REQ', ['MANIFEST', 'NOMANIFEST'], h),
    chunk: (h) => req('CHUNK_REQ', ['CHUNK', 'NOCHUNK'], h),
    close: () => channel.setHandler(null),
  };
};

/**
 * @param {{
 *   uri: string,
 *   providers: string[],                         // candidate provider dids
 *   channelFor: (did: string) => any | null,     // a content channel, or null if unreachable
 *   onProgress?: (p: any) => void,
 *   timeoutMs?: number,
 *   alpha?: number,
 * }} opts
 * @returns {Promise<{ manifest: any, payload: Uint8Array, providers: string[] }>}
 */
export const swarmFetch = async ({ uri, providers, channelFor, onProgress, timeoutMs = 15000, alpha = ALPHA }) => {
  const { hash } = parsePeerdUri(uri);
  const clients = [];
  for (const did of [...new Set(providers)]) {
    const ch = channelFor(did);
    if (ch) clients.push({ did, client: createChannelClient(ch, timeoutMs) });
  }
  if (!clients.length) throw new Error(`swarm: no reachable provider for ${hash}`);

  try {
    // 1. Manifest — from whichever provider answers; failover past NOMANIFEST.
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
    const byHash = new Map();
    const queue = [...uniqueHashes];
    let done = 0;
    let rr = 0; // round-robin start so load spreads across providers
    const worker = async () => {
      let h;
      while ((h = queue.shift()) !== undefined) {
        const start = rr++ % clients.length;
        let got = null;
        for (let j = 0; j < clients.length && !got; j++) {
          const { client } = clients[(start + j) % clients.length];
          try {
            const resp = await client.chunk(h);
            if (resp.t === 'CHUNK') {
              const bytes = fromBase64(resp.bytes);
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
    const payload = concat(...manifest.chunks.map((c) => byHash.get(c.hash)));
    if (payload.length !== manifest.size) throw new Error('reassembled size mismatch');
    return { manifest, payload, providers: clients.map((c) => c.did) };
  } finally {
    for (const { client } of clients) client.close();
  }
};
