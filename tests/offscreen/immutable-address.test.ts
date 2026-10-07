import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { immutableAppRoot } from '../../extension/shared/address/immutable-app-root.js';
import { formatDwappUri } from '../../extension/shared/address/dwapp-uri.js';
import { fetchImmutableApp, immutableAppSummary } from '../../extension/peerd-distributed/apps/immutable-address.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { createImmutableInstallOwner } from '../../extension/offscreen/immutable-install-owner.js';
import { runPublishTransaction, publishFailureError } from '../../extension/shared/publish-transaction.js';

// Execute the authored host cases with finite IO, as in dweb-base-admission.
const source = readFileSync(new URL('../../extension/offscreen/dweb-base.js', import.meta.url), 'utf8');
const cases = source.slice(source.indexOf("        case 'dweb/base-host/parse-address':"),
  source.indexOf("        case 'dweb/base-host/start':"));
const fixture = async () => {
  const identity = await generateIdentity();
  const payload = packBundle({ entry: 'index.html', files: { 'index.html': new TextEncoder().encode('App') } });
  const { manifest, hash } = await buildManifest({ payload, type: 'app', identity });
  const address = formatDwappUri({ did: identity.did, hash });
  const counts = { start: 0, fetch: 0, seed: 0, storage: 0, rollback: 0 };
  const writes: any[] = []; let duringFetch = () => {};
  const h = { base: {
    fetchApp: async () => { counts.fetch++; duringFetch(); return { manifest, payload }; },
    seedApp: async () => { counts.seed++; return hash; },
  } };
  const host = new Function('manualInstalls', 'immutableAppRoot', 'start', 'loadDweb', 'handle', 'mintAppId',
    'appContentOwner', 'runPublishTransaction', 'trackServedHash', 'swEffectCall', 'jsonSafeFiles',
    'publishFailureError', 'unserveTrackedHash', `return {
      retire: () => { handle = null; },
      dispatch: async (msg) => { let reply; const sendResponse = value => { reply = value; };
        await (async () => { switch(msg.type) { ${cases} } })(); return reply;
      }
    };`)(createImmutableInstallOwner(), immutableAppRoot, async () => { counts.start++; return h; },
    async () => ({ fetchImmutableApp, immutableAppSummary }), h, () => 'app-manual',
    () => 'owner', runPublishTransaction, () => true,
    async (type: string, payload: any) => { counts.storage++; writes.push({ type, ...payload }); return { ok: true, app: { id: payload.appId } }; },
    (files: any) => files, publishFailureError, () => { counts.rollback++; });
  return { host, counts, writes, address, hash, setDuringFetch: (fn: () => void) => { duringFetch = fn; } };
};

test('existing-host parse and inspect neither publish, install nor execute', async () => {
  const f = await fixture();
  expect(await f.host.dispatch({ type: 'dweb/base-host/parse-address', address: f.address })).toEqual({ ok: true, address: f.address });
  expect(f.counts).toEqual({ start: 0, fetch: 0, seed: 0, storage: 0, rollback: 0 });
  const reply = await f.host.dispatch({ type: 'dweb/base-host/inspect-address', address: f.address });
  expect(reply.summary).toMatchObject({ hash: f.hash, name: null });
  expect(f.counts).toEqual({ start: 1, fetch: 1, seed: 0, storage: 0, rollback: 0 });
  await expect(f.host.dispatch({ type: 'dweb/base-host/inspect-address', address: `${f.address}/index.html` })).rejects.toThrow();
  expect(f.counts.start).toBe(1);
});

test('manual install propagates custody and ignores forged mutable lineage', async () => {
  const f = await fixture();
  const reply = await f.host.dispatch({ type: 'dweb/base-host/install-address', address: f.address,
    publicationGeneration: 8, name: 'Spoof', dwappId: 'forged', seq: 999 });
  expect(reply.app.id).toBe('app-manual');
  expect(f.counts).toMatchObject({ seed: 1, storage: 1, rollback: 0 });
  expect(f.writes[0]).toMatchObject({ type: 'dweb/app-install', publicationGeneration: 8 });
  expect(f.writes[0].name).not.toBe('Spoof');
  expect(f.writes[0].dweb.dwapp_id).toBeUndefined();
  expect(f.writes[0].dweb.seq).toBeUndefined();
});

test('host retirement while bytes arrive prevents seed and storage', async () => {
  const f = await fixture(); f.setDuringFetch(f.host.retire);
  await expect(f.host.dispatch({ type: 'dweb/base-host/install-address', address: f.address })).rejects.toThrow('retired');
  expect(f.counts.seed).toBe(0); expect(f.counts.storage).toBe(0);
});
