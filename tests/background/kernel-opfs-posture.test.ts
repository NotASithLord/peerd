import { describe, expect, test } from 'bun:test';
import { makeKernelOpfsPostureRoute } from '../../extension/background/kernel-local-routes.js';

describe('native kernel OPFS posture route', () => {
  test('refuses provenance before readiness or storage authority', async () => {
    const calls: string[] = [];
    const route = makeKernelOpfsPostureRoute({
      ready: { then: (resolve: () => void) => { calls.push('ready'); resolve(); } } as any,
      assertWritable: () => { calls.push('writable'); },
      isAllowed: (sender) => sender === 'notebook' || sender === 'offscreen',
    });
    await expect(route({}, 'forged')).resolves.toEqual({
      ok: false, error: 'unauthorized OPFS posture request',
    });
    expect(calls).toEqual([]);
    await expect(route({}, 'notebook')).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['ready', 'writable']);
  });

  test('surfaces read-only posture without attempting feature work', async () => {
    const route = makeKernelOpfsPostureRoute({
      ready: Promise.resolve(), isAllowed: () => true,
      assertWritable: () => { throw new Error("store 'opfs-workspaces' is read-only"); },
    });
    await expect(route({}, 'offscreen')).resolves.toEqual({
      ok: false, error: "store 'opfs-workspaces' is read-only",
    });
  });
});
