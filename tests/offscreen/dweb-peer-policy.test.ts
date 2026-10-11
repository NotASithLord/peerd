import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPeerPolicyView } from '../../extension/offscreen/peer-policy.js';
import { createDiscoverySettings } from '../../extension/offscreen/discovery-settings.js';
import { withDeadline } from '../../extension/shared/cold-util.js';
import { encodeDidKey } from '../../extension/shared/address/did.js';
const source = readFileSync(new URL('../../extension/offscreen/dweb-base.js', import.meta.url), 'utf8');
const did = encodeDidKey(new Uint8Array(32));
const slice = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const policyBoundary = (send: () => Promise<any>) => new Function('createPeerPolicyView', 'createDiscoverySettings', 'withDeadline', 'browser',
  'let handle=null;' + slice('const peerPolicy =', '// Renderer-local mesh generation.') +
  'return { peerPolicy, discoverySettings, policyMeshes, refreshPeerPolicy, enforcePeerPolicy };')(
    createPeerPolicyView, createDiscoverySettings, withDeadline, { runtime: { sendMessage: send } });

test('policy hydration owns in-construction meshes, closes banned links and fails closed on refetch corruption', async () => {
  let reply: any = { ok: true, policy: { v: 1, revision: 1, blocked: [] } };
  const b = policyBoundary(async () => reply);
  const live = new Set([did, 'other']);
  b.policyMeshes.add({ peers: () => [...live].map(did => ({ did })), removeLink: (did: string) => live.delete(did) });
  await b.refreshPeerPolicy(); expect(live.size).toBe(2);
  reply = { ok: true, policy: { v: 1, revision: 2, blocked: [did] } };
  await b.refreshPeerPolicy(); expect([...live]).toEqual(['other']);
  reply = { ok: true, policy: { v: 1, revision: 3, blocked: ['garbage'] } };
  await expect(b.refreshPeerPolicy()).rejects.toThrow();
  expect(live.size).toBe(0); expect(b.peerPolicy.isBlocked('other')).toBe(true);
});

test('actual base creation cannot allocate a room before its policy read succeeds', async () => {
  let release!: () => void, read!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const reading = new Promise<void>(r => { read = r; });
  const b = policyBoundary(async () => { read(); await gate; return { ok: false }; });
  let joins = 0;
  const client = { available: true, identityMaterial: async () => 'material', identityFromMaterial: async () => ({ did }),
    joinBaseNetwork: async () => { joins++; return {}; } };
  const body = slice('  create: async () => {', '\n  activate: (candidate) =>').trim().replace(/^create: /, '').replace(/,$/, '');
  const create = new Function('loadDweb', 'refreshPeerPolicy', 'peerPolicy', 'discoverySettings', 'policyMeshes', 'log', 'warn', 'callKernelEffect', 'swCall',
    `return (${body});`)(async () => client, b.refreshPeerPolicy, b.peerPolicy, b.discoverySettings, b.policyMeshes, () => {}, () => {}, () => {}, () => {});
  const pending = create(); pending.catch(() => {});
  await reading; expect(joins).toBe(0);
  release(); await expect(pending).rejects.toThrow('peer-policy-unavailable'); expect(joins).toBe(0);
});

test('concurrent HELLO refreshes share one read and cannot overwrite an intervening ban update', async () => {
  let finish!: (value: any) => void, reads = 0;
  const b = policyBoundary(() => { reads++; return new Promise(r => { finish = r; }); });
  const a = b.refreshPeerPolicy(), second = b.refreshPeerPolicy();
  await Promise.resolve();
  expect(reads).toBe(1);
  b.peerPolicy.apply({ v: 1, revision: 2, blocked: [did] });
  finish({ ok: true, policy: { v: 1, revision: 1, blocked: [] } });
  await Promise.all([a, second]);
  expect(b.peerPolicy.isBlocked(did)).toBe(true);
  expect(b.peerPolicy.revision()).toBe(2);
});

test('supervisor admits only the exact SW policy command without an active dweb lease', async () => {
  const supervisor = readFileSync(new URL('../../extension/offscreen/offscreen.js', import.meta.url), 'utf8');
  const start = supervisor.indexOf("browser.runtime.onMessage.addListener(/** @type {any} */ ((");
  const end = supervisor.indexOf('\n}));', start) + '\n}));'.length;
  const listenerSource = supervisor.slice(supervisor.indexOf('const trustedSender ='), supervisor.indexOf('const claimLease ='))
    + supervisor.slice(start, end);
  let listener: any; let loads = 0, claims = 0, starts = 0;
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  const sw = {};
  new Function('browser', 'isServiceWorkerSender', 'claimLease', 'loadDwebHost', 'rejectStaleClaim', 'errorResponse', listenerSource)(
    { runtime: { onMessage: { addListener: (fn: any) => { listener = fn; } } } },
    (sender: any) => sender === sw,
    (_scope: string, reply: any) => { claims++; reply({ ok: false, error: 'no-lease' }); return null; },
    async () => { loads++; await loading; return { handleDwebBaseMessage: (message: any, _sender: any, reply: any) => {
      if (message.type !== 'dweb/base-host/peer-policy') starts++;
      reply({ ok: true }); return true;
    } }; }, () => false, () => ({ ok: false }));
  const dispatch = (type: string, sender: any) => new Promise<any>(resolve => listener({ type }, sender, resolve));
  const pending = dispatch('dweb/base-host/peer-policy', sw);
  expect(loads).toBe(1);
  // The feature remains retired while module loading is pending. A policy
  // command cannot use its eventual completion to acquire that feature.
  expect(await dispatch('dweb/base-host/start', sw)).toMatchObject({ ok: false });
  expect(await dispatch('dweb/base-host/peer-policy', {})).toMatchObject({ ok: false, error: 'unauthorized-command-sender' });
  release(); expect(await pending).toEqual({ ok: true });
  expect(loads).toBe(1); expect(claims).toBe(1); expect(starts).toBe(0);
});

test('the policy tick continues after a failed policy read', async () => {
  const timerSource = slice('    if (!policyTimer) policyTimer = setInterval', '\n    // Same-user device');
  let tick!: () => void, recovered!: () => void;
  const recovery = new Promise<void>(resolve => { recovered = resolve; });
  let reads = 0;
  new Function('refreshPeerPolicy', 'setInterval',
    `let policyTimer; ${timerSource};`)(
    async () => { if (++reads === 1) throw new Error('policy unavailable'); recovered(); },
    (callback: () => void) => { tick = callback; return 1; });
  tick(); await Promise.resolve(); // the rejection is contained by the timer
  tick(); await recovery;
  expect(reads).toBe(2);
});
