import { describe, test, expect } from 'bun:test';
import { makeLocalModelState } from '../../extension/background/local-model-state.js';
import { makeLocalModelRoutes } from '../../extension/background/routes/local-model.js';

describe('local-model-state', () => {
  test('available is false until set; coerces to boolean', () => {
    const s = makeLocalModelState();
    expect(s.available()).toBe(false);
    s.setModelAvailable('gemma-4-e2b', 1 as any);
    expect(s.available()).toBe(true);
    expect(s.available('gemma-4-e2b')).toBe(true);
  });
  test('residency is per model - one model down does not take the other with it', () => {
    const s = makeLocalModelState({ defaultModel: 'gemma-4-e2b' });
    s.setModelAvailable('gemma-4-e2b', true);
    s.setModelAvailable('muse-glimmer-30b', true);
    expect(s.availableModels().sort()).toEqual(['gemma-4-e2b', 'muse-glimmer-30b']);
    s.setModelAvailable('gemma-4-e2b', false);
    expect(s.available('gemma-4-e2b')).toBe(false);
    expect(s.available()).toBe(true); // another model is still usable
  });
  test('residentModel prefers the default among usable models when nothing is loaded', () => {
    const s = makeLocalModelState({ defaultModel: 'gemma-4-e2b' });
    expect(s.residentModel()).toBe('');
    s.setModelAvailable('muse-glimmer-30b', true);
    expect(s.residentModel()).toBe('muse-glimmer-30b');
    s.setModelAvailable('gemma-4-e2b', true);
    expect(s.residentModel()).toBe('gemma-4-e2b');
  });
  test('an actually-RESIDENT model outranks a merely-downloaded default', () => {
    // why: routing the runner to the cached default would evict the live
    // multi-GB model from GPU memory just to answer.
    const s = makeLocalModelState({ defaultModel: 'gemma-4-e2b' });
    s.setModelAvailable('gemma-4-e2b', true);       // cached, not loaded
    s.setModelResident('muse-glimmer-30b', true);   // loaded in the heap NOW
    expect(s.residentModel()).toBe('muse-glimmer-30b');
    // ...but a resident default wins over a resident non-default.
    s.setModelResident('gemma-4-e2b', true);
    expect(s.residentModel()).toBe('gemma-4-e2b');
    // Losing residency falls back to usability preference.
    s.setModelResident('gemma-4-e2b', false);
    s.setModelResident('muse-glimmer-30b', false);
    expect(s.residentModel()).toBe('gemma-4-e2b');
  });
  test('resident implies usable; un-usable clears residency', () => {
    const s = makeLocalModelState();
    s.setModelResident('muse-glimmer-30b', true);
    expect(s.available('muse-glimmer-30b')).toBe(true);
    s.setModelAvailable('muse-glimmer-30b', false);
    expect(s.residentModel()).toBe('');
  });
  test('setModelAvailable reports whether anything actually changed', () => {
    const s = makeLocalModelState();
    expect(s.setModelAvailable('gemma-4-e2b', false)).toBe(false); // already absent
    expect(s.setModelAvailable('gemma-4-e2b', true)).toBe(true);
    expect(s.setModelAvailable('gemma-4-e2b', true)).toBe(false);
  });
  test('hydration is an explicit full-seed claim, never a single-model side effect', () => {
    // why: one model\'s ready event latching `hydrated` would make the SW skip
    // the catalog seeding that surfaces every OTHER downloaded model.
    const s = makeLocalModelState();
    s.setModelAvailable('gemma-4-e2b', true);
    s.setModelResident('gemma-4-e2b', true);
    expect(s.hydrated()).toBe(false);
    s.markHydrated();
    expect(s.hydrated()).toBe(true);
  });
  test('progress round-trips', () => {
    const s = makeLocalModelState();
    expect(s.progress()).toBeNull();
    s.setProgress({ phase: 'download', pct: 42 });
    expect(s.progress()).toEqual({ phase: 'download', pct: 42 });
  });
});

const setup = (over: any = {}) => {
  const state = makeLocalModelState({ defaultModel: 'gemma-4-e2b' });
  const sent: any[] = [];
  return {
    state,
    sent,
    deps: {
      ensureOffscreen: async () => {},
      localModelHostAvailable: () => true,
      browser: { runtime: { sendMessage: async (m: any) => { sent.push(m); return over._reply ?? { available: false }; } } },
      localModelState: state,
      ...over,
    },
  };
};

describe('local-model routes', () => {
  test('status sets availability from available|downloaded and attaches progress', async () => {
    const { deps, state } = setup({ _reply: { downloaded: true, ok: true, model: 'gemma-4-e2b' } });
    state.setProgress({ pct: 80 });
    const res = await makeLocalModelRoutes(deps)['local-model/status']();
    expect(res).toEqual({ downloaded: true, ok: true, model: 'gemma-4-e2b', progress: { pct: 80 } });
    expect(state.available('gemma-4-e2b')).toBe(true);
  });
  test('status forwards the requested model id to the host', async () => {
    const { deps, sent } = setup({ _reply: { ok: true, model: 'muse-glimmer-30b' } });
    await makeLocalModelRoutes(deps)['local-model/status']({ model: 'muse-glimmer-30b', includeSupport: true });
    expect(sent[0]).toEqual({ type: 'local-model/host/status', model: 'muse-glimmer-30b', includeSupport: true });
  });
  test('availability is recorded against the model the HOST names, not the one asked for', async () => {
    // An absent id makes the engine answer for its default; recording the
    // request's id would mark the wrong model resident.
    const { deps, state } = setup({ _reply: { ok: true, available: true, model: 'gemma-4-e2b' } });
    await makeLocalModelRoutes(deps)['local-model/status']({ model: undefined });
    expect(state.available('gemma-4-e2b')).toBe(true);
    expect(state.availableModels()).toEqual(['gemma-4-e2b']);
  });
  test('a status reply distinguishes RESIDENT from merely downloaded', async () => {
    const { deps, state } = setup({ _reply: { ok: true, available: true, model: 'muse-glimmer-30b' } });
    state.setModelAvailable('gemma-4-e2b', true); // cached default
    await makeLocalModelRoutes(deps)['local-model/status']({ model: 'muse-glimmer-30b' });
    // The live model wins runner resolution over the cached default.
    expect(state.residentModel()).toBe('muse-glimmer-30b');
  });
  test('catalog seeds residency for every model in one pass', async () => {
    const { deps, state } = setup({
      _reply: {
        ok: true,
        models: [
          { model: 'gemma-4-e2b', downloaded: true, supportState: 'supported' },
          { model: 'muse-glimmer-30b', downloaded: false, supportState: 'unsupported' },
        ],
      },
    });
    const res = await makeLocalModelRoutes(deps)['local-model/catalog']();
    expect(res.models).toHaveLength(2);
    expect(state.available('gemma-4-e2b')).toBe(true);
    expect(state.available('muse-glimmer-30b')).toBe(false);
    // A full-catalog seed is the one event allowed to mark the store hydrated.
    expect(state.hydrated()).toBe(true);
  });
  test('status with no reply → { ok: false }', async () => {
    const { deps } = setup({ browser: { runtime: { sendMessage: async () => null } } });
    expect(await makeLocalModelRoutes(deps)['local-model/status']()).toEqual({ ok: false });
  });
  test('probe passes the host reply through', async () => {
    const { deps } = setup({ browser: { runtime: { sendMessage: async () => ({ gpu: 'webgpu' }) } } });
    expect(await makeLocalModelRoutes(deps)['local-model/probe']()).toEqual({ gpu: 'webgpu' });
  });
  test('init flips availability for the requested model', async () => {
    const { deps, state, sent } = setup({ _reply: { available: true, model: 'muse-glimmer-30b' } });
    await makeLocalModelRoutes(deps)['local-model/init']({ model: 'muse-glimmer-30b' });
    expect(sent[0]).toEqual({ type: 'local-model/host/init', model: 'muse-glimmer-30b' });
    expect(state.available('muse-glimmer-30b')).toBe(true);
  });
  test('a refused init leaves the model un-resident', async () => {
    const { deps, state } = setup({ _reply: { ok: false, error: 'This device cannot run Muse Glimmer 30B.', model: 'muse-glimmer-30b', supportState: 'unsupported' } });
    const res = await makeLocalModelRoutes(deps)['local-model/init']({ model: 'muse-glimmer-30b' });
    expect(res.ok).toBe(false);
    expect(state.available('muse-glimmer-30b')).toBe(false);
    expect(state.available()).toBe(false);
  });
  test('unsupported hosts refuse before starting the offscreen document', async () => {
    let starts = 0;
    const { deps } = setup({
      localModelHostAvailable: () => false,
      ensureOffscreen: async () => { starts += 1; },
    });
    for (const route of ['local-model/init', 'local-model/status', 'local-model/catalog'] as const) {
      expect(await makeLocalModelRoutes(deps)[route]()).toEqual({
        ok: false,
        error: 'runtime_capability_unavailable',
        performed: false,
        facility: 'localWebGpuHost',
        reasonCode: 'host_unsupported',
        retryable: false,
        alternative: 'use_ollama',
      });
    }
    expect(starts).toBe(0);
  });
});
