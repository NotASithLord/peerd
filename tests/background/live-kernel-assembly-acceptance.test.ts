import { describe, expect, test } from 'bun:test';
import {
  assertLiveKernelAssembly,
  completeLiveKernelAssemblyFixture,
  liveKernelAssemblyProfile,
} from '../../scripts/acceptance/live-kernel-assembly.mjs';

describe('installed-artifact live kernel assembly contract', () => {
  test('pins compact host admission and target-exact event and Port ownership', () => {
    const storeChrome = liveKernelAssemblyProfile('store-chrome');
    const storeFirefox = liveKernelAssemblyProfile('store-firefox');
    expect(storeFirefox.semanticHostRoutes).toEqual(storeChrome.semanticHostRoutes);
    for (const target of ['store-chrome', 'preview-chrome', 'store-firefox'] as const) {
      const fixture = completeLiveKernelAssemblyFixture(target);
      expect(assertLiveKernelAssembly(fixture, target)).toBe(fixture);
    }
  });

  test('rejects boolean-only readiness and every cardinality/inventory forgery', () => {
    expect(() => assertLiveKernelAssembly({
      ready: true,
      missingRequiredEvents: [], incompletePorts: [],
    }, 'store-chrome')).toThrow('top-level shape');
    const mutations = [
      (value: any) => { value.events[0].required = false; },
      (value: any) => { value.events[0].status = 'missing'; },
      (value: any) => { value.events[0].owner = 'wrong-owner'; },
      (value: any) => { value.events.push(value.events[0]); },
      (value: any) => { value.events[4].status = 'owned'; value.events[4].owner = 'wrong-owner'; },
      (value: any) => { value.ports[0].name = 'invented'; },
      (value: any) => { value.ports[0].reason = 'wrong-closed-reason'; },
      (value: any) => { value.ports[1].owner = 'wrong-owner'; },
      (value: any) => { value.ports[1].owner = null; },
      (value: any) => { value.target.extra = true; },
      (value: any) => { value.identity.kernelEpoch = value.identity.bootId; },
      (value: any) => { value.missingRequiredEvents = ['runtime.onMessage']; },
    ];
    for (const mutate of mutations) {
      const fixture = completeLiveKernelAssemblyFixture('store-chrome');
      mutate(fixture);
      expect(() => assertLiveKernelAssembly(fixture, 'store-chrome')).toThrow(
        'complete live kernel assembly',
      );
    }
  });

  test('rejects incomplete live ownership without consulting migration counters', () => {
    const stale = completeLiveKernelAssemblyFixture('store-chrome') as any;
    stale.events[0].status = 'missing';
    stale.events[0].owner = null;
    stale.missingRequiredEvents = [stale.events[0].key];
    stale.ready = false;
    expect(() => assertLiveKernelAssembly(stale, 'store-chrome')).toThrow(
      'complete live kernel assembly',
    );
  });

  test('rejects fabricated inventories that disagree with the live owner contract', () => {
    const fabricated = completeLiveKernelAssemblyFixture('store-firefox') as any;
    fabricated.events.pop();
    expect(() => assertLiveKernelAssembly(fabricated, 'store-firefox')).toThrow(
      'complete live kernel assembly',
    );
  });
});
