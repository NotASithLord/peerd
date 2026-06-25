// @ts-check
// peerd-distributed/dht/node.js — the Kademlia node (PROTOCOL §5).
//
// The four RPCs (PING / FIND_NODE / FIND_VALUE / STORE) and the iterative
// lookup that finds the k nodes closest to a key. The RPC TRANSPORT is
// injected (`rpc(contact, msg) -> Promise<response>`): in production a thin
// adapter ensures a WebRTC connection to the contact (reuse a mesh link or
// dial via the base layer) and round-trips a ch=1 envelope; in tests it routes
// straight to the target node's `handle`. That split keeps the lookup
// algorithm — the part that's easy to get subtly wrong — pure and testable.
//
// REACHABLE-ONLY discipline (dht/routing-table.js): a contact enters the
// routing table only via `learn`, which the lookup calls ONLY after that
// contact answered our query. A peer that merely queries us (incoming `handle`)
// is NOT added — it proved it can send to us, not that we can reach it.
//
// v1 scope: standard iterative parallel lookup (α concurrency). S/Kademlia
// disjoint-path lookups (the Sybil hardening) are a documented v1.1 follow-up
// layered on this same shortlist machinery.

import { createRoutingTable } from './routing-table.js';
import { nodeIdOf, byDistanceTo } from './distance.js';
import { itemKey } from './records.js';
import { toHex, fromHex } from '/shared/bundle/bytes.js';

// A wire-supplied DHT key/target is always a SHA-256 digest in hex: exactly 64
// lowercase hex chars (nodeIdOf / itemKey / mutableKey all hash to 32 bytes,
// toHex emits lowercase). Anything else is a malformed frame — reject it BEFORE
// fromHex (odd-length throws, `undefined` throws a TypeError) so handle() stays
// total and the responder can answer {t:'ERR'} instead of black-holing the RESP.
/** @param {unknown} h */
const isDhtKeyHex = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * @param {{
 *   identity: { did: string },
 *   selfId: Uint8Array,
 *   store: ReturnType<typeof import('./store.js').createDhtStore>,
 *   providers?: ReturnType<typeof import('./provider-store.js').createProviderStore> | null,
 *   rpc: (contact: any, msg: any) => Promise<any>,
 *   k?: number, alpha?: number, now?: () => number,
 * }} opts
 */
export const createDhtNode = ({ identity, selfId, store, providers = null, rpc, k = 8, alpha = 3, now = Date.now }) => {
  /** @typedef {{ did: string, id: Uint8Array, hints?: any }} Contact */
  const rt = createRoutingTable({ selfId, k, now });

  // Add a peer that just ANSWERED us. id is recomputed from the did (never
  // trusted from the wire) — it's deterministically SHA-256(pubkey).
  /**
   * @param {string} did
   * @param {any} [hints]
   */
  const learn = async (did, hints) => {
    if (!did || did === identity.did) return;
    rt.seen({ did, id: await nodeIdOf(did), hints });
  };

  // A wire contact omits `hints` when absent — the canonical signer rejects
  // `undefined` (it's not valid JSON), and a hint-less contact is common. The
  // `broker` hint is LOCAL reachability ("I learned this contact from peer X, so
  // X can relay me to it") — it's meaningless to anyone else, so it never goes
  // on the wire.
  /** @param {Contact} c */
  const wire = (c) => {
    if (!c.hints) return { did: c.did };
    const { broker, ...rest } = c.hints;
    return Object.keys(rest).length ? { did: c.did, hints: rest } : { did: c.did };
  };

  // Serve an incoming RPC from a directly-connected peer (the mesh wiring
  // calls this for ch=1 frames; `from` is the authenticated neighbour did).
  /**
   * @param {string} from — authenticated neighbour did
   * @param {any} msg — a wire-decoded RPC frame (dispatched by `t` below)
   */
  const handle = async (from, msg) => {
    switch (msg?.t) {
      case 'PING':
        return { t: 'PONG' };
      case 'FIND_NODE':
        if (!isDhtKeyHex(msg.target)) return { t: 'ERR', reason: 'bad-target' };
        return { t: 'NODES', nodes: rt.closest(fromHex(msg.target), k).map(wire) };
      case 'FIND_VALUE': {
        if (!isDhtKeyHex(msg.key)) return { t: 'ERR', reason: 'bad-key' };
        const hit = store.get(msg.key);
        if (hit) return { t: 'VALUE', item: hit };
        return { t: 'NODES', nodes: rt.closest(fromHex(msg.key), k).map(wire) };
      }
      case 'STORE':
        return { t: 'STORED', ...(await store.put(msg.item)) };
      case 'ADD_PROVIDER':
        return { t: 'PROVIDED', ...(providers ? await providers.add(msg.entry) : { ok: false, reason: 'no-provider-store' }) };
      case 'GET_PROVIDERS':
        // Like FIND_VALUE: hand back whatever providers we hold for the key AND
        // the closer contacts, so the caller's iterative walk converges.
        if (!isDhtKeyHex(msg.key)) return { t: 'ERR', reason: 'bad-key' };
        return { t: 'PROVIDERS', providers: providers ? providers.list(msg.key) : [], nodes: rt.closest(fromHex(msg.key), k).map(wire) };
      default:
        return { t: 'ERR', reason: 'unknown-rpc' };
    }
  };

  // Iterative lookup toward `targetKey` (bytes). Resolves
  // { value, closest:[contact] }: `value` is set only when wantValue and a
  // holder returned it; `closest` is the k nearest contacts we ended up knowing.
  /**
   * @param {Uint8Array} targetKey
   * @param {{ wantValue?: boolean }} [opts]
   */
  const lookup = async (targetKey, { wantValue = false } = {}) => {
    const targetHex = toHex(targetKey);
    /** @type {Map<string, Contact>} */
    const known = new Map(); // did -> { did, id, hints }
    for (const c of rt.closest(targetKey, k)) known.set(c.did, c);
    /** @type {Set<string>} */
    const queried = new Set();
    /** @type {any} */
    let value = null;

    const shortlist = () => byDistanceTo(targetKey, [...known.values()]).slice(0, k);

    // Converges when the α closest unqueried set is empty (everyone near the
    // target has answered) or no contacts remain.
    while (!value) {
      const batch = shortlist().filter((c) => !queried.has(c.did)).slice(0, alpha);
      if (!batch.length) break;
      await Promise.all(batch.map(async (c) => {
        queried.add(c.did);
        let resp;
        try { resp = await rpc(c, wantValue ? { t: 'FIND_VALUE', key: targetHex } : { t: 'FIND_NODE', target: targetHex }); }
        catch { rt.remove(c.did); return; } // unreachable → drop (reachable-only)
        await learn(c.did, c.hints); // it answered → reachable
        if (wantValue && resp?.t === 'VALUE') { value = resp.item; return; }
        for (const n of (resp?.nodes ?? [])) {
          if (n?.did && n.did !== identity.did && !known.has(n.did)) {
            // Remember WHO vouched for this contact (the responder `c`) so the
            // dialer can relay-dial it through `c` — `c` answered us, so it's
            // directly linked (the one-hop relay rule holds). Local-only.
            known.set(n.did, { did: n.did, id: await nodeIdOf(n.did), hints: { ...(n.hints ?? {}), broker: c.did } });
          }
        }
      }));
    }
    return { value, closest: shortlist() };
  };

  return {
    routingTable: rt,
    handle,
    learn,
    lookup,

    // Store a signed item at the k closest reachable nodes to its derived key
    // (and locally — we may be among the k-closest). Returns { key, stored }.
    /** @param {import('./records.js').Item} item */
    async put(item) {
      const keyBytes = await itemKey(item);
      await store.put(item);
      const { closest } = await lookup(keyBytes);
      const results = await Promise.allSettled(closest.map((c) => rpc(c, { t: 'STORE', item })));
      return { key: toHex(keyBytes), stored: results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length };
    },

    // Get an item by key bytes — local first, then an iterative FIND_VALUE.
    /** @param {Uint8Array} keyBytes */
    async get(keyBytes) {
      const local = store.get(toHex(keyBytes));
      if (local) return local;
      const { value } = await lookup(keyBytes, { wantValue: true });
      return value ?? null;
    },

    // --- provider sets (Plane 2) ---------------------------------------------
    // Announce that WE provide the bytes at `key` (hex H(content_addr)): store
    // locally (we may be among the k-closest) and ADD_PROVIDER to the k closest
    // reachable nodes. `entry` is a self-signed provider record (records.js).
    /**
     * @param {string} key — hex H(content_addr)
     * @param {import('./records.js').ProviderEntry} entry
     */
    async announceProvider(key, entry) {
      if (providers) await providers.add(entry);
      const { closest } = await lookup(fromHex(key));
      const results = await Promise.allSettled(closest.map((c) => rpc(c, { t: 'ADD_PROVIDER', entry })));
      return { key, stored: results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length };
    },

    // Find the dids serving `key`. Iterative GET_PROVIDERS walk toward the key,
    // accumulating providers from every node along the path (local set seeds it).
    /** @param {string} key — hex H(content_addr) */
    async findProviders(key) {
      const keyBytes = fromHex(key);
      /** @type {Set<string>} */
      const found = new Set(providers ? providers.list(key) : []);
      /** @type {Map<string, Contact>} */
      const known = new Map();
      for (const c of rt.closest(keyBytes, k)) known.set(c.did, c);
      /** @type {Set<string>} */
      const queried = new Set();
      const shortlist = () => byDistanceTo(keyBytes, [...known.values()]).slice(0, k);
      for (;;) {
        const batch = shortlist().filter((c) => !queried.has(c.did)).slice(0, alpha);
        if (!batch.length) break;
        await Promise.all(batch.map(async (c) => {
          queried.add(c.did);
          let resp;
          try { resp = await rpc(c, { t: 'GET_PROVIDERS', key }); }
          catch { rt.remove(c.did); return; }
          await learn(c.did, c.hints);
          for (const did of (resp?.providers ?? [])) if (did && did !== identity.did) found.add(did);
          for (const n of (resp?.nodes ?? [])) {
            if (n?.did && n.did !== identity.did && !known.has(n.did)) {
              known.set(n.did, { did: n.did, id: await nodeIdOf(n.did), hints: { ...(n.hints ?? {}), broker: c.did } });
            }
          }
        }));
      }
      return [...found];
    },
  };
};
