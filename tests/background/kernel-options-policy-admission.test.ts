import { expect, test } from 'bun:test';
import { createKernelSenderPolicy } from '../../extension/background/kernel-sender-policy.js';
import {
  makeKernelRouteProvenance,
  makeVaultKernelMessageHandler,
} from '../../extension/background/vault-kernel-core.js';
import {
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from '../../extension/background/kernel-denylist-policy.js';
import { makeKernelComposerRoutes } from '../../extension/background/kernel-composer-routes.js';
import { makeKernelLearnedOriginRoutes } from '../../extension/background/settings-store.js';
import { makeSystemRoutes } from '../../extension/background/routes/system.js';

const POLICY_ROUTES = [
  'denylist/list', 'denylist/add', 'denylist/remove',
  'learned/list', 'learned/forget', 'learned/clear',
];
const MANAGEMENT_ROUTES = [
  'skills/list', 'skills/setEnabled', 'skills/remove', 'skills/installLocal',
  'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle',
];
const SETTINGS_CONTROLS = [...MANAGEMENT_ROUTES, 'actor-isolation/retry'];

const fixture = (scheme = 'chrome-extension') => {
  const origin = `${scheme}://runtime/`;
  const target = {
    runtimeId: 'runtime', extensionOrigin: origin,
    sidepanelUrl: `${origin}sidepanel/sidepanel.html`,
    homeUrl: `${origin}home/home.html`,
    optionsUrl: `${origin}options/options.html`,
    evalRunnerUrl: `${origin}eval/runner.html`,
    notebookTabUrl: `${origin}engine-tabs/notebook-tab/index.html`,
    offscreenUrl: `${origin}offscreen/offscreen.html`,
    appTabUrl: `${origin}engine-tabs/app-tab/index.html`,
    micUrl: `${origin}permissions/mic.html`,
  };
  const policy = createKernelSenderPolicy(target);
  const options = { id: 'runtime', url: `${target.optionsUrl}#!/denylist`, tab: { id: 5 } };
  const bind = (routes: Record<string, (...args: any[]) => any>) => {
    const handler = makeVaultKernelMessageHandler({
      routes, trusted: policy.trusted, humanUi: policy.humanUi,
      routeProvenance: makeKernelRouteProvenance({ ...policy, vaultRoutes: ['vault/lock'] }),
    });
    return (type: string, sender: unknown = options, args: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const handled = handler({ ...args, type }, sender, resolve);
        if (!handled && !Object.hasOwn(routes, type)) reject(new Error(`missing route: ${type}`));
      });
  };
  return { origin, target, options, bind };
};

test.each(['chrome-extension', 'moz-extension'])('exact %s Settings documents own the six policy routes', async (scheme) => {
  const { target, options, bind } = fixture(scheme);
  const called: string[] = [];
  const invoke = bind(Object.fromEntries(POLICY_ROUTES.map((route) => [
    route, async () => { called.push(route); return { ok: true }; },
  ])));
  for (const sender of [
    options,
    { ...options, url: `${target.optionsUrl}#!/learned-sites` },
    { id: 'runtime', url: target.sidepanelUrl },
    { id: 'runtime', url: target.homeUrl, tab: { id: 6 } },
  ]) {
    for (const route of POLICY_ROUTES) expect(await invoke(route, sender)).toEqual({ ok: true });
  }
  expect(called).toHaveLength(POLICY_ROUTES.length * 4);
});

test('forged Settings and non-human extension documents cannot read or mutate policy', async () => {
  const { origin, target, options, bind } = fixture();
  const called: string[] = [];
  const routes = [...POLICY_ROUTES, ...SETTINGS_CONTROLS];
  const invoke = bind(Object.fromEntries(routes.map((route) => [
    route, async () => { called.push(route); return { ok: true }; },
  ])));
  const senders = [
    { ...options, id: 'other-extension' },
    { ...options, url: 'https://attacker.example/options/options.html' },
    { ...options, url: `${target.optionsUrl}?forged#!/denylist` },
    { id: 'runtime', url: target.optionsUrl },
    { ...options, url: `${origin}options/options.html.evil` },
    { ...options, url: target.appTabUrl },
    { ...options, url: target.notebookTabUrl },
    { ...options, url: target.evalRunnerUrl },
    { id: 'runtime', url: target.offscreenUrl },
    { id: 'runtime', url: `${origin}offscreen/actor-worker.js` },
    { id: 'runtime', url: `${origin}background/vault-kernel.js` },
  ];
  for (const sender of senders) {
    for (const route of routes) expect(await invoke(route, sender)).toMatchObject({ ok: false });
  }
  expect(called).toEqual([]);
});

test.each(['chrome-extension', 'moz-extension'])('exact %s Settings and sidepanel own management; Home gains only fixed retry', async (scheme) => {
  const { target, options, bind } = fixture(scheme);
  const calls: string[] = [];
  const invoke = bind(Object.fromEntries(SETTINGS_CONTROLS.map((route) => [
    route, async () => { calls.push(route); return { ok: true }; },
  ])));
  for (const sender of [
    { ...options, url: `${target.optionsUrl}#!/skills` },
    { ...options, url: `${target.optionsUrl}#!/hooks` },
    { id: 'runtime', url: target.sidepanelUrl },
  ]) {
    for (const route of SETTINGS_CONTROLS) expect(await invoke(route, sender)).toEqual({ ok: true });
  }
  expect(calls).toHaveLength(SETTINGS_CONTROLS.length * 3);
  for (const route of MANAGEMENT_ROUTES) {
    expect(await invoke(route, { id: 'runtime', url: target.homeUrl, tab: { id: 6 } }))
      .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
  }
  expect(calls).toHaveLength(SETTINGS_CONTROLS.length * 3);
  expect(await invoke('actor-isolation/retry', { id: 'runtime', url: target.homeUrl, tab: { id: 6 } }))
    .toEqual({ ok: true });
  expect(calls).toHaveLength(SETTINGS_CONTROLS.length * 3 + 1);
});

test('Settings recovery delegates only to the fixed isolation probe and preserves its refusal', async () => {
  const { bind } = fixture();
  const calls: unknown[][] = [];
  const refusal = { ok: false, capability: { status: 'temporarily_unavailable', retryable: true } };
  const routes = makeSystemRoutes({
    retryActorIsolation: (...args: unknown[]) => { calls.push(args); return refusal; },
  });
  const invoke = bind({ 'actor-isolation/retry': routes['actor-isolation/retry']! });
  expect(await invoke('actor-isolation/retry', undefined, {
    job: { code: 'must never run', getSecret: true }, capability: { status: 'available' },
  })).toEqual(refusal);
  expect(calls).toEqual([[]]);
});

test('Settings policy admission does not admit unrelated session, actor, or App authority', async () => {
  const { bind } = fixture();
  const denied = [
    'session/get', 'commands/list', 'session/archive', 'agent/send', 'actor/spawn',
    'app/editor/read', 'dweb/app-authority-generations',
  ];
  let calls = 0;
  const invoke = bind(Object.fromEntries(denied.map((route) => [
    route, async () => { calls += 1; return { ok: true }; },
  ])));
  for (const route of denied) {
    expect(await invoke(route)).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
  }
  expect(calls).toBe(0);
});

test('Settings reads and edits the real policy stores with audit and network synchronization intact', async () => {
  const { bind } = fixture();
  const records = new Map<string, any>([['learnedOrigins.v1', {
    'account.example': 'password-field', 'shop.example': 'confirmed-write',
  }]]);
  const kv = {
    get: async (key: string) => records.get(key),
    set: async (key: string, value: unknown) => { records.set(key, value); },
    list: async () => ({}),
  };
  const audit: any[] = [];
  const auditLog = { append: async (entry: unknown) => { audit.push(entry); } };
  let syncs = 0;
  const denylist = createKernelDenylistPolicy({
    kv, readSeed: async () => ({ categories: { finance: ['bank.example'] } }),
  });
  const composer = makeKernelComposerRoutes({
    browser: {}, kv, idb: { get: async () => null }, sessionCache: { sessionGet: async () => null },
    vault: { isLocked: () => true }, denylist,
    commands: { list: async () => [] }, appFiles: { list: async () => [] },
  });
  const invoke = bind({
    'denylist/list': composer['denylist/list'],
    ...makeKernelDenylistRoutes({
      policy: denylist, auditLog, networkCustody: { sync: async () => { syncs += 1; } },
    }),
    ...makeKernelLearnedOriginRoutes({ kv, auditLog }),
  });
  expect(await invoke('denylist/list')).toMatchObject({ ok: true, patterns: ['bank.example'] });
  expect(await invoke('denylist/add', undefined, { pattern: 'blocked.example' }))
    .toMatchObject({ ok: true, added: ['blocked.example'] });
  expect(denylist.blocks('blocked.example')).toBe(true);
  expect(await invoke('denylist/remove', undefined, { pattern: 'blocked.example' }))
    .toMatchObject({ ok: true, added: [] });
  expect(denylist.blocks('bank.example')).toBe(true);
  expect(await invoke('learned/list')).toMatchObject({ ok: true, origins: [
    { host: 'account.example', reason: 'password-field' },
    { host: 'shop.example', reason: 'confirmed-write' },
  ] });
  expect(await invoke('learned/forget', undefined, { host: 'account.example' }))
    .toMatchObject({ ok: true, origins: [{ host: 'shop.example', reason: 'confirmed-write' }] });
  expect(await invoke('learned/clear')).toEqual({ ok: true, origins: [], forgotten: 1 });
  expect(records.get('learnedOrigins.v1')).toEqual({});
  expect(syncs).toBe(2);
  expect(audit.map((entry) => entry.type)).toEqual([
    'denylist_added', 'denylist_removed', 'origin_unlearned_sensitive', 'origin_unlearned_sensitive',
  ]);
});
