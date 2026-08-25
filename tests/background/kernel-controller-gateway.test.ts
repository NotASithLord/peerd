import { describe, expect, test } from 'bun:test';
import { createKernelControllerGateway } from '../../extension/background/kernel-controller-gateway.js';

describe('kernel controller gateway', () => {
  test('coalesces one client and keeps ordered events inside a run', async () => {
    let connects = 0;
    const calls: any[] = [];
    const gateway = createKernelControllerGateway({
      connect: async () => {
        connects += 1;
        return {
          call: async (...args: any[]) => {
            calls.push(args);
            return { ok: true, outcomeKnown: true, value: { accepted: true } };
          },
          close() {},
        };
      },
    });
    expect(await gateway.call('feature.event', {}, { event: true })).toMatchObject({
      value: { accepted: false, inactive: true },
    });
    await gateway.withRun(async () => {
      await Promise.all([
        gateway.call('feature.event', { sequence: 1 }, { event: true }),
        gateway.call('feature.event', { sequence: 2 }, { event: true }),
      ]);
    });
    expect(connects).toBe(1);
    expect(calls.map((call) => call[1].sequence)).toEqual([1, 2]);
  });

  test('classifies startup, post-dispatch, and lifetime loss without hanging', async () => {
    let closeCount = 0;
    const startup = createKernelControllerGateway({
      connect: async () => { throw new Error('load hung or failed'); },
    });
    expect(await startup.call('semantic.dispatch', {})).toMatchObject({
      ok: false, code: 'controller-startup-failed', outcomeKnown: true, phase: 'startup',
    });
    const transport = createKernelControllerGateway({
      connect: async () => ({
        call: async () => { throw new Error('lost'); },
        close: () => { closeCount += 1; },
      }),
    });
    expect(await transport.call('turn.run', {})).toMatchObject({
      ok: false, code: 'controller-transport-failed', outcomeKnown: false, phase: 'run',
    });
    expect(closeCount).toBe(1);
    const lifetime = createKernelControllerGateway({
      connect: async () => ({ call: async () => ({ ok: true }), close() {} }),
      withLifetime: async () => {
        throw Object.assign(new Error('recycled'), {
          code: 'controller-lifetime-lost', outcomeKnown: false, phase: 'run',
        });
      },
    });
    expect(await lifetime.call('turn.run', {})).toMatchObject({
      ok: false, code: 'controller-lifetime-lost', outcomeKnown: false, phase: 'run',
    });
  });

  test('retires only after the last overlapping leased user exits', async () => {
    let closed = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gateway = createKernelControllerGateway({
      retireWhenIdle: true,
      connect: async () => ({
        call: async () => { await gate; return { ok: true, outcomeKnown: true }; },
        close: () => { closed += 1; },
      }),
    });
    const first = gateway.call('turn.run', {});
    const second = gateway.call('turn.run', {});
    await Promise.resolve();
    expect(closed).toBe(0);
    release();
    await Promise.all([first, second]);
    expect(closed).toBe(1);
  });
});
