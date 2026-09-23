import { describe, expect, test } from 'bun:test';
import { createDwebBridgeLifecycle } from '../../extension/engine-tabs/app-tab/dweb-bridge-lifecycle.js';

describe('App tab required-actor and runtime lifecycle contracts', () => {
  test('concurrent bridge attach and detach share one lifecycle', async () => {
    let releaseCreate!: () => void;
    let releaseLeave!: () => void;
    const creating = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const leaving = new Promise<void>((resolve) => { releaseLeave = resolve; });
    let creates = 0;
    let disposes = 0;
    const lifecycle = createDwebBridgeLifecycle();
    lifecycle.allow();
    const create = async () => {
      await creating;
      creates += 1;
      return { dispose: async () => { disposes += 1; await leaving; } };
    };
    const firstAttach = lifecycle.attach(create);
    const secondAttach = lifecycle.attach(create);
    expect(secondAttach).toBe(firstAttach);
    releaseCreate();
    await firstAttach;
    expect(creates).toBe(1);

    const firstDispose = lifecycle.dispose();
    const secondDispose = lifecycle.dispose();
    expect(secondDispose).toBe(firstDispose);
    await Promise.resolve();
    expect(disposes).toBe(1);
    releaseLeave();
    await firstDispose;

    let retries = 0;
    const retained = createDwebBridgeLifecycle();
    retained.allow();
    await retained.attach(async () => ({
      dispose: async () => { if (++retries === 1) throw new Error('leave-failed'); },
    }));
    await expect(retained.invalidate()).rejects.toThrow('leave-failed');
    retained.allow();
    let recreated = false;
    await retained.attach(async () => { recreated = true; return null; });
    expect(recreated).toBe(false);
    await retained.invalidate();
    expect(retries).toBe(2);
  });

  test('authority invalidation bypasses a generic dispose that waits for a join', async () => {
    let disposeStarted!: () => void;
    let releaseDispose!: () => void;
    const started = new Promise<void>((resolve) => { disposeStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseDispose = resolve; });
    let invalidated = 0;
    const lifecycle = createDwebBridgeLifecycle();
    lifecycle.allow();
    await lifecycle.attach(async () => ({
      dispose: async () => { disposeStarted(); await blocked; },
      invalidate: async () => { invalidated += 1; },
    }));
    const disposing = lifecycle.dispose();
    await started;
    await lifecycle.invalidate();
    expect(invalidated).toBe(1);
    releaseDispose();
    await disposing;

    let fallbackDispose = 0;
    const synchronous = createDwebBridgeLifecycle();
    synchronous.allow();
    await synchronous.attach(async () => ({
      dispose: () => { fallbackDispose += 1; },
      invalidate: () => { invalidated += 1; },
    }));
    await synchronous.invalidate();
    expect(fallbackDispose).toBe(0);
  });

  test('document loss retires authority after a lost page leave and a cold worker', async () => {
    const tracker = await Bun.file('./extension/background/app-tab-tracker.js').text();
    const worker = await Bun.file('./extension/background/service-worker.js').text();
    expect(tracker).toContain('purgeDwebOwners(appId, await advanceDwebGeneration(appId))');
    expect(worker).toContain('retireAppDweb(closedAppId)');
    expect(worker).toContain("engineLiveness.findByTab('app', tabId)");
    expect(worker).toContain('retireAppDweb(entry.id)');
    expect(worker).toContain("changeInfo.discarded === true || typeof changeInfo.url === 'string'");
    expect(worker).toContain('await appRetirements.get(sender.tab.id)');
    expect(worker).toContain('retireAppDocument(tabId, changeInfo.url, trackedAppId)');
    expect(worker).toContain('await retireAppDweb(appId)');
    expect(worker).toContain('await trackAppRetirement(tabId, () => retireAppDweb(appId))');
  });

  test('the host binds owner from its URL, exposes retry, and never delivers owner to App launch data', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const html = await Bun.file('./extension/engine-tabs/app-tab/index.html').text();
    expect(source).toContain("const ownerSessionId = hashParams.get('owner')");
    expect(source).toContain('browser.runtime.sendMessage({ type, appId, ownerSessionId })');
    expect(source).toContain("attachRequiredActor('app/tab-ready')");
    expect(source).toContain("attachRequiredActor('app/actor-retry')");
    expect(source).toContain('launch: launchParams');
    expect(source).not.toContain('launch: { ...launchParams, ownerSessionId }');
    expect(html).toContain('id="actor-retry"');
  });

  test('the App tab owns the direct actor conversation while App code can only reveal it', async () => {
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const html = await Bun.file('./extension/engine-tabs/app-tab/index.html').text();
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    const attachIndex = host.indexOf("await attachRequiredActor('app/tab-ready')");
    const directRouteIndex = host.indexOf("type: 'app/actor-chat'");
    expect(attachIndex).toBeGreaterThan(-1);
    expect(directRouteIndex).toBeGreaterThan(-1);
    expect(html).toContain('id="actor-chat-drawer"');
    expect(html).toContain('Direct conversation · scoped to this App');
    expect(host).toContain("message.textContent = text");
    expect(host).not.toContain('message.innerHTML =');

    const agentApiStart = runner.indexOf('const agentApi = Object.freeze({');
    const peerdGlobalStart = runner.indexOf("Object.defineProperty(window, 'peerd'", agentApiStart);
    const agentApi = runner.slice(agentApiStart, peerdGlobalStart);
    expect(agentApi).toContain('open()');
    expect(agentApi).toContain('navigator.userActivation?.isActive');
    expect(agentApi).toContain("{ peerd: 'app:agent:open' }");
    expect(agentApi).toContain('expose(definition)');
    expect(agentApi).not.toContain('request(');
    expect(agentApi).not.toContain('provider');
  });

  test('edit mode replaces the runner and manifest runtime methods gate playtesting', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    expect(source).toContain("mode !== 'render' || runnerPhase !== 'delivered'");
    expect(source).toContain("appMeta?.agent?.runtime?.includes('observe')");
    expect(source).toContain("appMeta?.agent?.runtime?.includes('act')");
    expect(source).toContain("frame.src = 'about:blank'");
    expect(source).toContain("rejectAgentCalls('app_runtime_suspended_for_editing')");
    expect(source).toContain('appMeta = null;');
  });

  test('a timed-out runner generation poisons queued work and requests replacement', async () => {
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    expect(runner).toContain('let agentRuntimePoisoned = false');
    expect(runner).toContain('if (agentRuntimePoisoned)');
    expect(runner).toContain('agentRuntimePoisoned = true');
    expect(runner).toContain("poisoned: request.op === 'act' || error?.poisoned === true");
    expect(host).toContain('recoverPoisonedRunner()');
  });

  test('every rejected post-dispatch act is unknown and retires its runner generation', async () => {
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    expect(host).toContain("const postDispatchActFailure = pending.op === 'act'");
    expect(host).toContain("? { outcomeKnown: false, outcomeKind: 'transport-lost' }");
    expect(host).toContain('if (outcomeUnknown) recoverPoisonedRunner()');
    expect(runner).toContain("if (request.op === 'act') agentRuntimePoisoned = true");
    expect(runner).toContain("poisoned: request.op === 'act' || error?.poisoned === true");
  });

  test('the app_code relay derives the exact App from a live owner-bound run', async () => {
    const source = await Bun.file('./extension/background/service-worker.js').text();
    expect(source).toContain("if (!isOffscreenSender(sender)) return { ok: false, error: 'app_call_unauthorized_relay' }");
    expect(source).toContain("scriptRuns.ownerFor(runId) !== ownerSessionId");
    expect(source).toContain("scriptRuns.allows(runId, 'app') !== true");
    expect(source).toContain("owner.actorSurface !== 'code'");
    expect(source).toContain('appId: owner.instanceId');
  });
});
