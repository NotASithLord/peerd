import { describe, test, expect } from 'bun:test';
import { makeLocalModelState } from '../../extension/background/local-model-state.js';
import { makeLocalModelRoutes } from '../../extension/background/routes/local-model.js';

describe('local-model-state', () => {
  test('available is false until set; coerces to boolean', () => {
    const s = makeLocalModelState();
    expect(s.available()).toBe(false);
    s.setAvailable(1 as any);
    expect(s.available()).toBe(true);
  });
  test('progress round-trips', () => {
    const s = makeLocalModelState();
    expect(s.progress()).toBeNull();
    s.setProgress({ phase: 'download', pct: 42 });
    expect(s.progress()).toEqual({ phase: 'download', pct: 42 });
  });
});

const setup = (over: any = {}) => {
  const state = makeLocalModelState();
  return {
    state,
    deps: {
      ensureOffscreen: async () => {},
      browser: { runtime: { sendMessage: async (_m: any) => over._reply ?? { available: false } } },
      localModelState: state,
      ...over,
    },
  };
};

describe('local-model routes', () => {
  test('status sets availability from available|downloaded and attaches progress', async () => {
    const { deps, state } = setup({ _reply: { downloaded: true, ok: true } });
    state.setProgress({ pct: 80 });
    const res = await makeLocalModelRoutes(deps)['local-model/status']();
    expect(res).toEqual({ downloaded: true, ok: true, progress: { pct: 80 } });
    expect(state.available()).toBe(true);
  });
  test('status with no reply → { ok: false }', async () => {
    const { deps } = setup({ browser: { runtime: { sendMessage: async () => null } } });
    expect(await makeLocalModelRoutes(deps)['local-model/status']()).toEqual({ ok: false });
  });
  test('probe passes the host reply through', async () => {
    const { deps } = setup({ browser: { runtime: { sendMessage: async () => ({ gpu: 'webgpu' }) } } });
    expect(await makeLocalModelRoutes(deps)['local-model/probe']()).toEqual({ gpu: 'webgpu' });
  });
  test('init flips availability', async () => {
    const { deps, state } = setup({ _reply: { available: true } });
    await makeLocalModelRoutes(deps)['local-model/init']();
    expect(state.available()).toBe(true);
  });
});
