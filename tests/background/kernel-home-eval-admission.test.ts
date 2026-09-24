import { expect, test } from 'bun:test';
import { createKernelSenderPolicy } from '../../extension/background/kernel-sender-policy.js';
import { makeKernelRouteProvenance, makeVaultKernelMessageHandler } from '../../extension/background/vault-kernel-core.js';
import { makeSessionRoutes } from '../../extension/background/routes/sessions.js';
import { makeSystemRoutes } from '../../extension/background/routes/system.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/background.js';

const HOME_ROUTES = [
  'agent/send', 'agent/stop', 'session/debugBundle', 'actor-isolation/retry',
  'local-model/catalog', 'local-model/status',
];
const EVAL_PARAMETERLESS = [
  'state/get', 'provider/status', 'models/options',
  'local-model/status', 'local-model/probe', 'local-model/init',
];
const fixture = (scheme: string) => {
  const origin = `${scheme}://runtime/`;
  const target = {
    runtimeId: 'runtime', extensionOrigin: origin,
    sidepanelUrl: `${origin}sidepanel/sidepanel.html`, homeUrl: `${origin}home/home.html`,
    optionsUrl: `${origin}options/options.html`, evalRunnerUrl: `${origin}eval/runner.html`,
    notebookTabUrl: `${origin}engine-tabs/notebook-tab/index.html`,
    offscreenUrl: `${origin}offscreen/offscreen.html`, appTabUrl: `${origin}engine-tabs/app-tab/index.html`,
    micUrl: `${origin}permissions/mic.html`,
  };
  const policy = createKernelSenderPolicy(target);
  const tab = (url: string) => ({ id: 'runtime', url, tab: { id: 7 } });
  const home = tab(`${target.homeUrl}#chat`);
  const evalSender = tab(target.evalRunnerUrl);
  const options = tab(`${target.optionsUrl}#!/providers`);
  const panel = { id: 'runtime', url: target.sidepanelUrl };
  const calls: any[] = [];
  const bind = (overrides: Record<string, any> = {}) => {
    const routes = new Proxy(overrides, {
      get: (entries, type: string) => entries[type] ?? ((message: any) => {
        calls.push(message); return { ok: true };
      }),
    });
    const handler = makeVaultKernelMessageHandler({
      routes, trusted: policy.trusted, humanUi: policy.humanUi,
      routeProvenance: makeKernelRouteProvenance({ ...policy, vaultRoutes: ['vault/unlock', 'vault/lock'] }),
    });
    return (message: any, sender: any) => new Promise<any>((resolve) => handler(message, sender, resolve));
  };
  return { target, origin, home, evalSender, options, panel, tab, calls, bind };
};

test.each(['chrome-extension', 'moz-extension'])('%s Home owns its six shipped controls', async (scheme) => {
  const h = fixture(scheme);
  const invoke = h.bind();
  for (const type of HOME_ROUTES) expect(await invoke({ type }, h.home)).toEqual({ ok: true });
  for (const message of [
    { type: 'agent/send', text: 'hello', operationId: 'host-ui-id', sessionId: 'chat' },
    { type: 'agent/send', text: 'goal', goal: true },
    { type: 'agent/send', checkOnly: true, operationId: 'host-ui-id', sessionId: 'chat' },
    { type: 'session/debugBundle', sessionId: 'chat' },
  ]) expect(await invoke(message, h.home)).toEqual({ ok: true });
  expect(h.calls).toHaveLength(10);
});

test.each(['chrome-extension', 'moz-extension'])('%s eval admits only its six parameterless requests and runner setting', async (scheme) => {
  const h = fixture(scheme);
  const invoke = h.bind();
  for (const type of EVAL_PARAMETERLESS) expect(await invoke({ type }, h.evalSender)).toEqual({ ok: true });
  for (const runnerModel of ['', 'local', 'claude-haiku-4-5']) {
    expect(await invoke({ type: 'settings/update', patch: { runnerModel } }, h.evalSender))
      .toEqual({ ok: true });
  }
  expect(h.calls).toHaveLength(9);
  const before = h.calls.length;
  for (const type of EVAL_PARAMETERLESS) {
    for (const extra of [{ sessionId: 'foreign' }, { model: 'other' }, { includeSupport: true },
      { provider: 'other' }, { activate: true }, { ignored: undefined }]) {
      expect(await invoke({ type, ...extra }, h.evalSender)).toMatchObject({ ok: false });
    }
  }
  for (const patch of [undefined, null, [], {}, { runnerModel: 1 }, { runnerModel: null },
    { runnerModel: 'local', permissionMode: 'act' }, { providerName: 'ollama' },
    { runnerModel: 'local', unused: undefined }, Object.create({ runnerModel: 'local' })]) {
    expect(await invoke({ type: 'settings/update', patch }, h.evalSender)).toMatchObject({ ok: false });
  }
  expect(await invoke({ type: 'settings/update', patch: { runnerModel: 'local' }, extra: true }, h.evalSender))
    .toMatchObject({ ok: false });
  expect(h.calls).toHaveLength(before);
});

test.each(['chrome-extension', 'moz-extension'])('%s Home local reads remain parameterless without broadening other human forms', async (scheme) => {
  const h = fixture(scheme);
  const invoke = h.bind();
  for (const type of ['local-model/catalog', 'local-model/status']) {
    for (const payload of [{ model: 'other' }, { includeSupport: true }, { ignored: undefined }]) {
      expect(await invoke({ type, ...payload }, h.home)).toMatchObject({ ok: false });
      expect(await invoke({ type, ...payload }, h.options)).toEqual({ ok: true });
    }
    expect(await invoke({ type }, h.panel)).toMatchObject({ ok: false });
  }
  for (const sender of [h.home, h.panel, h.options]) {
    for (const message of [
      { type: 'settings/update', patch: { providerName: 'ollama', permissionMode: 'plan' } },
      { type: 'models/options', sessionId: 'chat' },
      { type: 'provider/status', includeSupport: true },
      { type: 'state/get', existingHumanParameter: true },
    ]) expect(await invoke(message, sender)).toEqual({ ok: true });
  }
});

test.each(['chrome-extension', 'moz-extension'])('%s UI compatibility does not widen other authority', async (scheme) => {
  const h = fixture(scheme);
  const invoke = h.bind();
  const management = ['skills/list', 'skills/setEnabled', 'skills/remove', 'skills/installLocal',
    'hooks/list', 'hooks/save', 'hooks/remove', 'hooks/toggle'];
  for (const type of [...management, 'local-model/init', 'local-model/probe', 'voice/init',
    'voice/listen', 'voice/stop', 'voice/teardown', 'voice/silence', 'audit/voice-fetch']) {
    expect(await invoke({ type }, h.home)).toMatchObject({ ok: false });
  }
  for (const type of [...management, 'local-model/catalog', 'session/debugBundle',
    'actor-isolation/retry', 'provider/setKey', 'provider/test', 'settings/reset',
    'session/get', 'session/list', 'session/archive', 'permission/set',
    'vault/unlock', 'vault/lock', 'origin-cred/list', 'git-cred/list', 'actor/spawn']) {
    expect(await invoke({ type }, h.evalSender)).toMatchObject({ ok: false });
  }
  for (const type of ['agent/send', 'agent/stop']) {
    expect(await invoke({ type }, h.options)).toMatchObject({ ok: false });
  }
  expect(h.calls).toEqual([]);
});

test.each(['chrome-extension', 'moz-extension'])('%s forged and non-human pages cannot redeem Home or eval admission', async (scheme) => {
  const h = fixture(scheme);
  const invoke = h.bind();
  const senders = [
    { ...h.home, id: 'foreign' }, { ...h.evalSender, id: 'foreign' },
    h.tab('https://evil.example/home/home.html'), h.tab('https://evil.example/eval/runner.html'),
    h.tab(`${h.target.homeUrl}?spoof`), h.tab(`${h.target.evalRunnerUrl}?spoof`),
    h.tab(`${h.target.homeUrl}.evil`), h.tab(`${h.target.evalRunnerUrl}.evil`),
    { id: 'runtime', url: h.target.homeUrl }, { id: 'runtime', url: h.target.evalRunnerUrl },
    h.tab(h.target.appTabUrl), h.tab(h.target.notebookTabUrl), h.tab(h.target.micUrl),
    { id: 'runtime', url: h.target.offscreenUrl },
    { id: 'runtime', url: `${h.origin}background/vault-kernel.js` },
  ];
  for (const sender of senders) {
    for (const type of [...new Set([...HOME_ROUTES, ...EVAL_PARAMETERLESS])]) {
      expect(await invoke({ type }, sender)).toMatchObject({ ok: false });
    }
    expect(await invoke({ type: 'settings/update', patch: { runnerModel: 'local' } }, sender))
      .toMatchObject({ ok: false });
  }
  expect(h.calls).toEqual([]);
});

test.each(['chrome-extension', 'moz-extension'])('%s admitted Home handlers preserve vault, durable Stop and fixed retry gates', async (scheme) => {
  const h = fixture(scheme);
  let locked = true;
  let reads = 0;
  const stopped: string[] = [];
  const probes: unknown[][] = [];
  const refusal = { ok: false, error: 'isolation probe refused' };
  const sessions = makeSessionRoutes({
    makeAgentSendCustody, sessionCache: { sessionGet: async () => 'chat' },
    vault: { isLocked: () => locked },
    sessions: { get: async () => { reads += 1; return null; } },
    turnSlots: { stop: (id: string) => { stopped.push(id); return true; } },
    actorMessaging: { stopActorsFor: () => ['actor'] },
    actorLifecycle: { stopSubtree: () => ['child'] },
    haltGoalRun: async () => { throw new Error('durable Stop failed'); },
    auditLog: { append: async () => {} }, postChatNote: () => {},
  });
  const system = makeSystemRoutes({
    retryActorIsolation: (...args: unknown[]) => { probes.push(args); return refusal; },
  });
  const invoke = h.bind({ ...sessions, 'actor-isolation/retry': system['actor-isolation/retry'] });
  expect(await invoke({ type: 'session/debugBundle', sessionId: 'chat' }, h.home))
    .toEqual({ ok: false, error: 'locked' });
  expect(reads).toBe(0);
  locked = false;
  expect(await invoke({ type: 'session/debugBundle' }, h.home))
    .toEqual({ ok: false, error: 'sessionId-required' });
  expect(await invoke({ type: 'session/debugBundle', sessionId: 'missing' }, h.home))
    .toEqual({ ok: false, error: 'session-not-found' });
  expect(await invoke({ type: 'agent/stop' }, h.home))
    .toEqual({ ok: false, error: 'goal-stop-persistence-failed' });
  expect(stopped).toEqual(['chat', 'actor']);
  expect(await invoke({ type: 'actor-isolation/retry', job: { code: 'forged' },
    capability: { status: 'available' } }, h.home)).toEqual(refusal);
  expect(probes).toEqual([[]]);
});
