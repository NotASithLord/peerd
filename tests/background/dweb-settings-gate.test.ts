import { describe, expect, test } from 'bun:test';
import { createDwebSettingsGate } from '../../extension/background/dweb-settings-gate.js';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('dweb persisted-settings boot gate', () => {
  test('an early resume cannot start before persisted OFF hydrates', async () => {
    const settings = deferred();
    let enabled = true;
    let starts = 0;
    const gate = createDwebSettingsGate({
      ready: settings.promise,
      available: true,
      active: () => enabled,
    });
    const start = gate.startWhenEnabled(() => { starts += 1; });
    await Promise.resolve();
    expect(starts).toBe(0);
    enabled = false;
    settings.resolve();
    expect(await start).toBe(false);
    expect(starts).toBe(0);
  });

  test('preview stops one surviving host after persisted OFF hydrates', async () => {
    const settings = deferred();
    let enabled = true;
    let stops = 0;
    const gate = createDwebSettingsGate({
      ready: settings.promise,
      available: true,
      active: () => enabled,
    });
    const stop = gate.stopWhenDisabled(() => { stops += 1; });
    await Promise.resolve();
    expect(stops).toBe(0);
    enabled = false;
    settings.resolve();
    expect(await stop).toBe(true);
    expect(stops).toBe(1);
  });

  test('preview leaves an enabled network running', async () => {
    let stops = 0;
    const gate = createDwebSettingsGate({
      ready: Promise.resolve(),
      available: true,
      active: () => true,
    });
    expect(await gate.stopWhenDisabled(() => { stops += 1; })).toBe(false);
    expect(stops).toBe(0);
  });

  test('preview starts once persisted ON has hydrated', async () => {
    const settings = deferred();
    let starts = 0;
    const gate = createDwebSettingsGate({
      ready: settings.promise,
      available: true,
      active: () => true,
    });
    const start = gate.startWhenEnabled(() => { starts += 1; });
    await Promise.resolve();
    expect(starts).toBe(0);
    settings.resolve();
    expect(await start).toBe(true);
    expect(starts).toBe(1);
  });

  test('store and Firefox packages never touch an unrelated offscreen host', async () => {
    let starts = 0;
    let stops = 0;
    const gate = createDwebSettingsGate({
      ready: Promise.resolve(),
      available: false,
      active: () => false,
    });
    expect(await gate.startWhenEnabled(() => { starts += 1; })).toBe(false);
    expect(await gate.stopWhenDisabled(() => { stops += 1; })).toBe(false);
    expect({ starts, stops }).toEqual({ starts: 0, stops: 0 });
  });

  test('settings load failures fail closed', async () => {
    const settings = deferred();
    let starts = 0;
    const gate = createDwebSettingsGate({
      ready: settings.promise,
      available: true,
      active: () => true,
    });
    const start = gate.startWhenEnabled(() => { starts += 1; });
    settings.reject(new Error('storage unavailable'));
    await expect(start).rejects.toThrow('storage unavailable');
    expect(starts).toBe(0);
  });
});
