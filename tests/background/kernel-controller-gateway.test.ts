import { describe, expect, test } from 'bun:test';
import { createKernelControllerGateway } from '../../extension/background/kernel-controller-gateway.js';

const makeState = () => {
  let creates = 0;
  let closed = 0;
  let deps: any;
  let releaseHeld = () => {};
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let releaseFeature = () => {};
  const heldFeature = new Promise<void>((resolve) => { releaseFeature = resolve; });
  let featureStarted = () => {};
  const startedFeature = new Promise<void>((resolve) => { featureStarted = resolve; });
  let featureGrant: any = null;
  let promptCalls = 0;
  const calls: any[] = [];
  const gateway = createKernelControllerGateway({
    controller: { fixed: true },
    makeController: (value) => {
      creates += 1;
      deps = value;
      return {
        callSemantic: async (payload: any) => {
          calls.push(['semantic', payload]);
          if (payload.route === 'held') await held;
          return { ok: true };
        },
        callTurn: async (payload: any) => { calls.push(['turn', payload]); return { ok: true }; },
        callRuntime: async (payload: any) => { calls.push(['runtime', payload]); return { ok: true }; },
        callFeature: async (payload: any) => {
          calls.push(['feature', payload]);
          featureGrant = deps.authorizeFeatureCall(payload);
          if (payload.held) { featureStarted(); await heldFeature; }
          return deps.handleFeatureKernelCall('read', {}, { authority: featureGrant });
        },
        callFeatureEvent: async (payload: any) => {
          calls.push(['event', payload]);
          const grant = deps.authorizeFeatureCall(payload);
          return deps.handleFeatureKernelCall('event', {}, { authority: grant });
        },
        renderSystemPrompt: async () => { promptCalls += 1; return 'prompt'; },
        withRun: async (operation: () => Promise<any>) => operation(),
        close: () => { closed += 1; },
      };
    },
  });
  return {
    gateway, calls, releaseHeld, releaseFeature, startedFeature,
    featureGrant: () => featureGrant, promptCalls: () => promptCalls,
    creates: () => creates, closed: () => closed, deps: () => deps,
  };
};

const owner = (family: string) => ({
  authorize: (payload: any) => {
    const cluster = family.startsWith('feature-') ? family.slice(8) : null;
    if (cluster && payload.route !== cluster) return null;
    return { target: cluster ? `kernel-feature:${cluster}:${payload.route}` : `${family}:${payload.route}` };
  },
  handle: async () => ({ ok: true, family }),
});

describe('kernel controller gateway', () => {
  test('offers the full capability mux through one controller from every first-owner order', async () => {
    for (const first of ['semantic', 'turn', 'runtime', 'repository'] as const) {
      const state = makeState();
      const bindings = {
        semantic: () => state.gateway.bindSemantic(owner('semantic')),
        turn: () => state.gateway.bindTurn(owner('turn')),
        runtime: () => state.gateway.bindRuntime(owner('runtime')),
        repository: () => state.gateway.bindFeature('repository', owner('feature-repository')),
      };
      const ordered = [first, ...Object.keys(bindings).filter((name) => name !== first)]
        .map((name) => bindings[name as keyof typeof bindings]());
      const firstBinding = ordered[0] as any;
      await (first === 'semantic' ? firstBinding.callSemantic({ route: first })
        : first === 'turn' ? firstBinding.callTurn({ route: first })
          : first === 'runtime' ? firstBinding.callRuntime({ route: first })
            : firstBinding.callFeature({ route: first }));
      expect(state.creates()).toBe(1);
      expect(state.deps().fixed).toBe(true);
      for (const name of [
        'authorizeSemanticCall', 'handleSemanticKernelCall',
        'authorizeTurnCall', 'handleTurnKernelCall',
        'authorizeRuntimeCall', 'handleRuntimeKernelCall',
        'authorizeFeatureCall', 'handleFeatureKernelCall',
      ]) expect(state.deps()[name], `${first}:${name}`).toBeFunction();
      state.gateway.close();
      expect(state.closed()).toBe(1);
    }
  });

  test('isolates feature clusters and denies cross-cluster effects', async () => {
    const state = makeState();
    const repository = state.gateway.bindFeature('repository', owner('feature-repository'));
    const local = state.gateway.bindFeature('local', {
      authorize: (payload: any) => payload.route === 'local'
        ? { target: 'kernel-feature:local:local' } : null,
      handle: async () => ({ ok: true, family: 'local' }),
    });
    await expect(repository.callFeature({ route: 'repository' }))
      .resolves.toEqual({ ok: true, family: 'feature-repository' });
    await expect(local.callFeature({ route: 'local' }))
      .resolves.toEqual({ ok: true, family: 'local' });
    await expect(repository.callFeature({ route: 'unknown' }))
      .resolves.toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    expect(state.deps().authorizeFeatureCall({ route: 'unknown' })).toBeNull();
    expect(state.deps().handleFeatureKernelCall('read', {}, {
      authority: { target: 'kernel-feature:administrative:forged' },
    })).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
  });

  test('pins and drains the exact feature binding through reverse effects', async () => {
    const state = makeState();
    const binding = state.gateway.bindFeature('repository', owner('feature-repository'));
    const payload = { route: 'repository', held: true };
    const pending = binding.callFeature(payload);
    await state.startedFeature;
    binding.release();
    expect(() => state.gateway.bindFeature('repository', owner('feature-repository')))
      .toThrow('kernel-feature-owner-conflict');
    await expect(state.deps().handleFeatureKernelCall('read', {}, {
      authority: state.featureGrant(),
    })).resolves.toEqual({ ok: true, family: 'feature-repository' });
    state.releaseFeature();
    await expect(pending).resolves.toEqual({ ok: true, family: 'feature-repository' });
    expect(state.deps().handleFeatureKernelCall('read', {}, {
      authority: state.featureGrant(),
    })).toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    await expect(binding.callFeature({ route: 'repository' }))
      .resolves.toMatchObject({ ok: false, code: 'kernel-feature-repository-owner-unavailable' });
    state.gateway.bindFeature('repository', owner('feature-repository'));
  });

  test('fences turn prompt and run lifetime with the binding', async () => {
    const state = makeState();
    const binding = state.gateway.bindTurn(owner('turn'));
    let releaseRun = () => {};
    const heldRun = new Promise<void>((resolve) => { releaseRun = resolve; });
    const running = binding.withRun(() => heldRun);
    await Promise.resolve();
    binding.release();
    expect(() => state.gateway.bindTurn(owner('turn'))).toThrow('kernel-turn-owner-conflict');
    await expect(binding.renderSystemPrompt({})).rejects.toMatchObject({
      code: 'kernel-turn-owner-unavailable', outcomeKnown: true,
    });
    releaseRun();
    await running;
    state.gateway.bindTurn(owner('turn'));
    expect(state.promptCalls()).toBe(0);
    state.gateway.close();
    let ran = false;
    await expect(binding.withRun(async () => { ran = true; })).rejects.toMatchObject({
      code: 'kernel-turn-owner-unavailable', outcomeKnown: true,
    });
    expect(ran).toBe(false);
  });

  test('drains an in-flight binding before release and refuses a conflicting replacement', async () => {
    const state = makeState();
    const binding = state.gateway.bindSemantic(owner('semantic'));
    const pending = binding.callSemantic({ route: 'held' });
    await Promise.resolve();
    binding.release();
    expect(() => state.gateway.bindSemantic(owner('semantic')))
      .toThrow('kernel-semantic-owner-conflict');
    state.releaseHeld();
    await pending;
    const successor = state.gateway.bindSemantic(owner('semantic'));
    await expect(successor.callSemantic({ route: 'next' })).resolves.toMatchObject({ ok: true });
  });

  test('only the kernel closes the shared controller', () => {
    const state = makeState();
    state.gateway.bindSemantic(owner('semantic')).release();
    state.gateway.bindTurn(owner('turn')).release();
    expect(state.closed()).toBe(0);
    state.gateway.close();
    state.gateway.close();
    expect(state.closed()).toBe(1);
  });
});
