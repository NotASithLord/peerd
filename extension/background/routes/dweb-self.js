// @ts-check
// background/routes/dweb-self.js: the service-worker half of same-user
// device sync (portable identity).
//
// The split of labour, and the reason this file exists at all: the OFFSCREEN
// document owns the mesh and the cryptography (it can reach the dweb module;
// this file structurally cannot). The SERVICE WORKER owns the stores and the
// vault. So the offscreen side moves opaque bytes between proven self
// devices, and this side is the only place that knows what a "surface"
// means: how to shape one out of the local stores, and how to apply one
// that arrived.
//
// That split is also a containment boundary. The offscreen document is the
// process that talks to the network; it never gets store access, and the two
// relay routes below are the entire surface it can reach. Both verify the
// sender is genuinely the offscreen document, because `runtime.sendMessage`
// is reachable from every extension page.
//
// BOUNDARY: names no dweb-module path (the manifest's digests are plain
// WebCrypto here), so it ships inert in the store package like every other
// dweb route.
//
// What a snapshot is: shaped bytes cached under one snapshotId, served on
// demand rather than handed over in one lump. A workspace surface can be
// large, and the offer/pull protocol is built to stream it a chunk at a
// time; holding the whole snapshot in the offscreen document would give
// that back for nothing.

/** Same hex SHA-256 the sync protocol's manifest entries carry. */
const digestHex = async (/** @type {Uint8Array} */ bytes) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const bytesToB64 = (/** @type {Uint8Array} */ bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const b64ToBytes = (/** @type {string} */ b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// A prepared snapshot is dropped once its transfer settles or this expires.
// The receiver re-pulls against the SAME snapshotId on interruption, so the
// window has to outlive a slow link, not just a single pull.
const SNAPSHOT_TTL_MS = 30 * 60_000;
const MAX_CACHED_SNAPSHOTS = 8;
const MAX_CACHED_SNAPSHOT_BYTES = 192 * 1024 * 1024;
// Must stay at or below the receiver protocol caps. Only live SW-backed
// surfaces are present here; unsupported protocol names remain unavailable.
const LIVE_SURFACE_BYTE_CAPS = Object.freeze({
  settings: 256 * 1024,
  memory: 16 * 1024 * 1024,
  sessions: 64 * 1024 * 1024,
  apps: 64 * 1024 * 1024,
});
const PROTOCOL_SURFACE_NAMES = Object.freeze([
  'settings', 'providerEndpoints', 'memory', 'hooks', 'skills',
  'sessions', 'apps', 'workspaces', 'secrets',
]);

/**
 * Deps (all injected, this module imports nothing):
 *   dwebReady           build + setting gate, awaited on every route
 *   isOffscreenSender    the offscreen-document provenance check
 *   callBaseHost         relay to the offscreen `dweb/base-host/*` handler
 *   surfaceShapers       surface name -> the local payload, or null to
 *                        withhold. The SW owns these because only it can
 *                        read the stores.
 *   surfaceAppliers      surface name -> how an arrived payload is written
 *   auditLog             append-only provenance for both directions
 *
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeDwebSelfRoutes = (deps) => {
  const {
    dwebReady, isOffscreenSender, callBaseHost, surfaceShapers, surfaceAppliers, auditLog,
  } = deps;
  // Test seam only, never wired at the call site (which is shorthand-only by
  // the routes-wiring guard, tests/meta/sw-routes-wiring.test.ts).
  const now = deps.now ?? (() => Date.now());
  const surfaceByteCaps = deps.surfaceByteCaps ?? LIVE_SURFACE_BYTE_CAPS;

  /** @type {Map<string, { at: number, payloads: Map<string, Uint8Array> }>} */
  const snapshots = new Map();

  const sweepSnapshots = () => {
    const cutoff = now() - SNAPSHOT_TTL_MS;
    for (const [id, entry] of snapshots) if (entry.at < cutoff) snapshots.delete(id);
  };

  const cachedBytes = () => [...snapshots.values()].reduce(
    (sum, entry) => sum + [...entry.payloads.values()].reduce((n, bytes) => n + bytes.length, 0), 0,
  );

  /** @param {number} incomingBytes */
  const makeSnapshotRoom = (incomingBytes) => {
    while (snapshots.size >= MAX_CACHED_SNAPSHOTS
        || (snapshots.size > 0 && cachedBytes() + incomingBytes > MAX_CACHED_SNAPSHOT_BYTES)) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  };

  const ensureSelfHost = async () => {
    try {
      const result = await callBaseHost('dweb/base-host/self-start');
      if (result?.ok !== true) return { ok: false, error: result?.error ?? 'self-device-start-failed' };
      if (result.running !== true) {
        return { ok: false, error: result.reason ?? 'self-device-not-running' };
      }
      return null;
    } catch (e) {
      return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
    }
  };

  return {
    /** The panel's read window: is this install part of a device set, who is online. */
    'dweb/self-status': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      try {
        const started = await callBaseHost('dweb/base-host/self-start');
        if (!started?.ok || started.running !== true) return started;
        return await callBaseHost('dweb/base-host/self-status');
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    /**
     * SOURCE side. Shape the requested surfaces, cache them under a fresh
     * snapshotId, and hand the offscreen host a manifest to offer.
     *
     * Consent is applied HERE, by omission: a surface the caller did not ask
     * for is never shaped, so it never appears in the manifest and the
     * protocol has nothing to refuse. `secrets` is therefore only ever
     * offered when the user explicitly named it.
     */
    'dweb/self-prepare-offer': async ({ surfaces, label, targetDeviceDid } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (!Array.isArray(surfaces) || surfaces.length === 0) {
        return { ok: false, error: 'surfaces-required' };
      }
      const startFailure = await ensureSelfHost();
      if (startFailure) return startFailure;
      sweepSnapshots();
      const snapshotId = crypto.randomUUID();
      /** @type {Map<string, Uint8Array>} */
      const payloads = new Map();
      /** @type {Array<{ name: string, version: number, bytes: number, hash: string }>} */
      const entries = [];
      /** @type {string[]} */
      const unavailable = [];
      /** @type {Record<string, string>} */
      const wireUnavailable = {};
      for (const name of [...new Set(surfaces)]) {
        if (typeof name !== 'string') { unavailable.push(String(name)); continue; }
        const shaper = Object.hasOwn(surfaceShapers, name) ? surfaceShapers[name] : null;
        if (!shaper) {
          unavailable.push(name);
          if (PROTOCOL_SURFACE_NAMES.includes(name)) wireUnavailable[name] = 'unsupported';
          continue;
        }
        let shaped;
        try { shaped = await shaper(); } catch {
          unavailable.push(name);
          wireUnavailable[name] = 'capture-failed';
          continue;
        }
        if (shaped === null || shaped === undefined) {
          unavailable.push(name);
          wireUnavailable[name] = 'unavailable';
          continue;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(shaped));
        const cap = surfaceByteCaps[name];
        if (!Number.isSafeInteger(cap) || bytes.length > cap) {
          unavailable.push(name);
          wireUnavailable[name] = 'over-transfer-cap';
          continue;
        }
        payloads.set(name, bytes);
        entries.push({ name, version: 1, bytes: bytes.length, hash: await digestHex(bytes) });
      }
      if (entries.length === 0 && Object.keys(wireUnavailable).length === 0) {
        return { ok: false, error: 'nothing-to-offer', unavailable };
      }
      const totalBytes = [...payloads.values()].reduce((sum, bytes) => sum + bytes.length, 0);
      makeSnapshotRoom(totalBytes);
      snapshots.set(snapshotId, { at: now(), payloads });
      const manifest = {
        v: 1,
        snapshotId,
        createdAt: now(),
        ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
        surfaces: entries,
        ...(Object.keys(wireUnavailable).length > 0 ? { unavailable: wireUnavailable } : {}),
      };
      try {
        const reply = await callBaseHost('dweb/base-host/self-offer', {
          manifest,
          ...(typeof targetDeviceDid === 'string' && targetDeviceDid ? { targetDeviceDid } : {}),
        });
        await auditLog.append({
          type: 'dweb_self_snapshot_offered',
          details: { surfaces: entries.map((e) => e.name), offered: reply?.offered?.length ?? 0 },
        }).catch(() => {});
        return { ok: true, snapshotId, surfaces: entries.map((e) => e.name), unavailable, ...reply };
      } catch (e) {
        snapshots.delete(snapshotId);
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    /**
     * Called BY the offscreen host while serving a pull. Offscreen-only:
     * this hands out shaped state, so an ordinary extension page must not
     * be able to ask for it.
     */
    'dweb/self-read-surface': async ({ snapshotId, surface } = {}, sender = undefined) => {
      if (!isOffscreenSender(sender)) return { ok: false, error: 'unauthorized-relay' };
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      const entry = snapshots.get(snapshotId);
      if (entry && entry.at < now() - SNAPSHOT_TTL_MS) {
        snapshots.delete(snapshotId);
        return { ok: false, error: 'snapshot-expired' };
      }
      const bytes = entry?.payloads.get(surface);
      if (!bytes) return { ok: false, error: 'unavailable' };
      return { ok: true, bytes: bytesToB64(bytes) };
    },

    /**
     * Called BY the offscreen host with hash-verified bytes for one surface.
     * Offscreen-only for the same reason in reverse: this WRITES to local
     * stores, and the appliers are the only code that decides how.
     */
    'dweb/self-apply-surface': async ({ surface, bytes, sourceDeviceDid } = {}, sender = undefined) => {
      if (!isOffscreenSender(sender)) return { ok: false, error: 'unauthorized-relay' };
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      const applier = typeof surface === 'string' && Object.hasOwn(surfaceAppliers, surface)
        ? surfaceAppliers[surface] : null;
      // An unknown surface name is refused, never applied generically: a
      // hostile payload must not be able to invent somewhere new to write.
      if (!applier) return { ok: false, error: 'unknown-surface' };
      if (typeof bytes !== 'string') return { ok: false, error: 'bytes-required' };
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(b64ToBytes(bytes)));
      } catch {
        return { ok: false, error: 'undecodable-payload' };
      }
      try {
        const result = await applier(payload, { sourceDeviceDid: String(sourceDeviceDid ?? '') });
        await auditLog.append({
          type: 'dweb_self_surface_applied',
          details: { surface, sourceDeviceDid: String(sourceDeviceDid ?? ''), result: result ?? null },
        }).catch(() => {});
        return { ok: true, result: result ?? null };
      } catch (e) {
        const partial = /** @type {{ result?: any }} */ (e)?.result;
        return {
          ok: false,
          error: /** @type {{ message?: string }} */ (e)?.message ?? String(e),
          ...(partial && typeof partial === 'object' ? { partial } : {}),
        };
      }
    },

    /** RECEIVER side. Pull the chosen surfaces from one proven self device. */
    'dweb/self-restore': async ({ deviceDid, surfaces } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof deviceDid !== 'string' || deviceDid.length === 0) {
        return { ok: false, error: 'deviceDid-required' };
      }
      const startFailure = await ensureSelfHost();
      if (startFailure) return startFailure;
      try {
        return await callBaseHost('dweb/base-host/self-restore', { deviceDid, surfaces });
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
  };
};
