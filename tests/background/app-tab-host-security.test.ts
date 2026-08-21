import { describe, expect, test } from 'bun:test';

describe('App tab required-actor and runtime lifecycle contracts', () => {
  test('the host binds owner from its URL, exposes retry, and never delivers owner to App launch data', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const html = await Bun.file('./extension/engine-tabs/app-tab/index.html').text();
    expect(source).toContain("const ownerSessionId = hashParams.get('owner')");
    expect(source).toContain('makeAppActorAttachRecovery');
    expect(source).toContain('request: (type) => uiRuntime.send({ type, appId, ownerSessionId })');
    expect(source).toContain('await actorAttachment.start()');
    expect(source).toContain('await actorAttachment.retry()');
    expect(source).toContain("actorRetry.textContent = unknown ? 'Recheck actor' : 'Retry actor'");
    expect(source).toContain('Recheck the exact attachment without reopening the App.');
    expect(source).toContain('launch: launchParams');
    expect(source).not.toContain('launch: { ...launchParams, ownerSessionId }');
    expect(html).toContain('id="actor-retry"');
  });

  test('the App tab owns the direct actor conversation while App code can only reveal it', async () => {
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const html = await Bun.file('./extension/engine-tabs/app-tab/index.html').text();
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    const attachIndex = host.indexOf('await actorAttachment.start()');
    const directRouteIndex = host.indexOf("type: 'app/actor-chat'");
    expect(attachIndex).toBeGreaterThan(-1);
    expect(directRouteIndex).toBeGreaterThan(-1);
    expect(html).toContain('id="actor-chat-drawer"');
    expect(html).toContain('Direct conversation · scoped to this App');
    expect(host).toContain("message.textContent = text");
    expect(host).toContain('actorChatUnconfirmed = true');
    expect(host).toContain('Delivery unconfirmed · inspect the actor in peerd');
    expect(host).toContain('makeUiRuntimeClient({ browser })');
    expect(host).toContain("saveRetry.textContent = saveOutcomeUnknown ? 'Reload to reconcile' : 'Retry'");
    expect(host).toContain('if (saveOutcomeUnknown)');
    expect(host).not.toContain('browser.runtime.sendMessage');
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
