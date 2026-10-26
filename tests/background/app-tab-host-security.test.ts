import { describe, expect, test } from 'bun:test';
import { createDwebBridgeLifecycle } from '../../extension/engine-tabs/app-tab/dweb-bridge-lifecycle.js';
import { runInNewContext } from 'node:vm';
import { mapError } from '../../extension/sidepanel/error-display.js';

describe('App tab required-actor and runtime lifecycle contracts', () => {
  test('the actual drawer keeps fixed guidance, drafts and unknown custody', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const send = source.slice(source.indexOf('const sendActorChatMessage ='), source.indexOf("actorChatToggle.addEventListener"));
    for (const [reply, expected, unknown] of [
      [{ ok: false, error: "Provider 'ollama' HTTP 401: SECRET-PROVIDER-TEXT" }, mapError('provider-http-401'), false],
      [{ ok: false, error: "Provider 'ollama' HTTP 429: SECRET-PROVIDER-TEXT" }, mapError('provider-http-429').replace(/\p{Dash_Punctuation}/gu, '-'), false],
      [{ ok: false, error: 'credit balance SECRET-PROVIDER-TEXT' }, mapError('insufficient_quota').replace(/\p{Dash_Punctuation}/gu, '-'), false],
      [{ ok: false, error: 'provider-usage-limit:SECRET-PROVIDER-TEXT' }, 'The App actor did not reply. Try again.', false],
      [{ ok: false, error: 'provider-http-500:SECRET-PROVIDER-TEXT' }, 'The App actor did not reply. Try again.', false],
      [{ ok: false, error: 'vault-locked', outcomeKnown: true }, 'Vault is locked. Unlock it in the peerd panel, then send again.', false],
      [{ ok: false, error: 'vault-locked', outcomeKnown: false }, 'Peerd could not confirm whether the App actor received that message.', true],
    ] as const) {
      const lines: string[] = [];
      let calls = 0;
      const input = { value: 'keep this prompt', disabled: false, focus() {} };
      const context = { Error, mapError, appId: 'app-1', actorChatInput: input,
        actorChatBusy: false, actorChatUnconfirmed: false,
        actorChatSend: { disabled: false }, actorChatStatus: { textContent: '' },
        appendActorChatMessage: (_role: string, text: string) => lines.push(text),
        uiRuntime: { send: async () => { calls += 1; return reply; } } };
      const run = runInNewContext(`${send}; sendActorChatMessage`, context);
      await run();
      expect(lines.at(-1)).toContain(expected);
      expect(lines.at(-1)).not.toContain('SECRET-PROVIDER-TEXT');
      expect(lines.at(-1)?.match(/\p{Dash_Punctuation}/gu)?.every((value) => value === '-') ?? true).toBe(true);
      expect(input.disabled).toBe(unknown);
      expect(context.actorChatSend.disabled).toBe(unknown);
      if (unknown) { input.value = 'do not replay'; await run(); expect(calls).toBe(1); }
      else expect(input.value).toBe('keep this prompt');
    }
  });

  test('the actual Save banner keeps unknown first, then names JSON and lock refusals', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const show = source.slice(source.indexOf('const showSaveFailure ='), source.indexOf('const clearSaveFailure ='));
    const context = { saveStatus: { hidden: false }, saveReturnFocus: null, saveOutcomeUnknown: false,
      saveMessage: { textContent: '' }, saveRetry: { disabled: true, textContent: '' } };
    const run = runInNewContext(`${show}; showSaveFailure`, context);
    run('data/state.json', { code: 'app-file-invalid-json' });
    expect(context.saveMessage.textContent).toBe('data/state.json is not valid JSON, so it is not saved yet. Fix the JSON to save it.');
    run('index.html', { error: 'vault-locked' });
    expect(context.saveMessage.textContent).toContain('Unlock it in the peerd panel, then retry.');
    expect(context.saveMessage.textContent).not.toContain('free browser storage');
    run('index.html', { error: 'vault-locked', outcomeKnown: false });
    expect(context.saveMessage.textContent).toContain('could not confirm');
    expect(context.saveRetry.textContent).toBe('Download edits');
    run('data/state.json', { code: 'app-file-invalid-json' });
    expect(context.saveMessage.textContent).toContain('could not confirm');
    expect(context.saveRetry.textContent).toBe('Download edits');
  });
  test('the consent sentence adds only missing final punctuation', async () => {
    const source = await Bun.file('./extension/engine-tabs/app-tab/consent-bar.js').text();
    const expression = /text\.textContent = (`[^\n]+`);/.exec(source)?.[1];
    expect(expression).toBeDefined();
    for (const detail of ['share this version.', 'install this App?', 'open this link!', 'join this room']) {
      expect(runInNewContext(expression!, { appName: 'Notes', detail }))
        .toBe(`“Notes” wants to ${detail}${/[.?!]$/.test(detail) ? '' : '.'}`);
    }
  });
  test('a saved code edit reopens the trusted host instead of rearming its retired bridge', async () => {
    const lifecycle = createDwebBridgeLifecycle();
    expect(lifecycle.isInvalidated()).toBe(false);
    lifecycle.allow();
    await lifecycle.dispose();
    expect(lifecycle.isInvalidated()).toBe(false);
    await lifecycle.invalidate();
    lifecycle.allow();
    expect(lifecycle.isInvalidated()).toBe(true);
    let recreated = false;
    await lifecycle.attach(async () => { recreated = true; return null; });
    expect(recreated).toBe(false);

    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    const view = host.slice(host.indexOf('// When leaving edit mode,'));
    const flushAt = view.indexOf('await editorApi.flushSave?.()');
    const retiredAt = view.indexOf('dwebBridgeLifecycle.isInvalidated()');
    const reloadAt = view.indexOf('location.reload()');
    expect(flushAt).toBeGreaterThanOrEqual(0);
    expect(retiredAt).toBeGreaterThan(flushAt);
    expect(reloadAt).toBeGreaterThan(retiredAt);
    expect(view.indexOf('await actorAttachment.retry()')).toBeGreaterThan(reloadAt);
  });

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
    const worker = await Bun.file('./extension/background/kernel-turn-authority-adapter.js').text();
    const authority = await Bun.file('./extension/background/app-dweb-authority.js').text();
    expect(tracker).toContain('const retireDwebTab = dwebAuthority.retire');
    expect(authority).toContain('await purgeOwners(appId, next)');
    expect(worker).toContain('retireAppDweb(instanceId, tabId)');
    expect(worker).toContain("engineLiveness.findByTab('app', tabId)");
    expect(worker).toContain('retireAppDweb(entry.id, tabId)');
    expect(worker).toContain("change?.discarded === true || typeof change?.url === 'string'");
    expect(worker).toContain('await appRetirements.get(sender.tab.id)');
    expect(worker).toContain('retireAppDocument(tabId, change.url, trackedAppId)');
    expect(worker).toContain('await retireAppDweb(appId, tabId)');
    expect(worker).toContain('await trackAppRetirement(tabId, () => retireAppDweb(appId, tabId))');
  });

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
    expect(host).toContain('actorChatInput.disabled = failure?.outcomeKnown === false');
    expect(host).toContain('Delivery unconfirmed · inspect the actor in peerd');
    expect(host).toContain('makeUiRuntimeClient({ browser })');
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

  test('the sandbox announces its exact generation before receiving a channel', async () => {
    const runner = await Bun.file('./extension/engine-tabs/app-tab/runner.html').text();
    const host = await Bun.file('./extension/engine-tabs/app-tab/app-tab.js').text();
    expect(runner).toContain("type: 'runner-loaded', generation: location.hash.slice(1)");
    expect(host).toContain("e.data?.type === 'runner-loaded'");
    expect(host).toContain("e.data.generation === String(runnerGeneration)");
    expect(host).toContain("if (runnerPhase === 'awaiting-ready') return;");
    expect(host).not.toContain('expectingRunnerLoad');
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

});
