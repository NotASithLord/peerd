import { describe, expect, test } from 'bun:test';
import {
  assertLiveKernelAssembly,
  completeLiveKernelAssemblyFixture,
  liveKernelAssemblyProfile,
} from '../../scripts/acceptance/live-kernel-assembly.mjs';

describe('installed-artifact live kernel assembly contract', () => {
  test('pins the complete semantic, event, and Port inventories per target', () => {
    expect(liveKernelAssemblyProfile('store-chrome')).toMatchObject({
      semanticRoutes: 161, eventInventory: 16, portInventory: 6,
      semanticPlacements: { kernel: 143, split: 18 },
      requiredEvents: { length: 13 }, requiredPorts: { length: 4 },
    });
    expect(liveKernelAssemblyProfile('preview-chrome')).toMatchObject({
      semanticRoutes: 161, eventInventory: 16, portInventory: 6,
      requiredEvents: { length: 14 }, requiredPorts: { length: 5 },
    });
    expect(liveKernelAssemblyProfile('store-firefox')).toMatchObject({
      semanticRoutes: 161, eventInventory: 16, portInventory: 6,
      requiredEvents: { length: 15 }, requiredPorts: { length: 4 },
    });
    for (const target of ['store-chrome', 'preview-chrome', 'store-firefox'] as const) {
      const fixture = completeLiveKernelAssemblyFixture(target);
      expect(assertLiveKernelAssembly(fixture, target)).toBe(fixture);
    }
  });

  test('rejects boolean-only readiness and every cardinality/inventory forgery', () => {
    expect(() => assertLiveKernelAssembly({
      cutoverReady: true, semantic: { ready: true },
      missingRequiredEvents: [], incompletePorts: [],
    }, 'store-chrome')).toThrow('top-level shape');
    const mutations = [
      (value: any) => { value.semantic.extra = true; },
      (value: any) => { value.semantic.kernel += 1; },
      (value: any) => { value.semantic.kernel -= 1; value.semantic.split += 1; },
      (value: any) => { value.counts.ownedRequiredPorts -= 1; },
      (value: any) => { value.events[0].required = false; },
      (value: any) => { value.events[0].status = 'partial'; },
      (value: any) => { value.events.push(value.events[0]); },
      (value: any) => { value.events[4].status = 'owned'; value.events[4].owner = 'x'.repeat(129); },
      (value: any) => { value.ports[0].name = 'invented'; },
      (value: any) => { value.ports[0].status = 'fail-closed'; value.ports[0].reason = null; },
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

  test('rejects the stale partial-vertical-slice counts formerly accepted by physical lanes', () => {
    const stale = completeLiveKernelAssemblyFixture('store-chrome') as any;
    stale.counts.ownedRequiredEvents = 5;
    stale.counts.ownedRequiredPorts = 1;
    stale.semantic.migrated = 34;
    stale.semantic.unmigrated = stale.semantic.total - 34;
    stale.semantic.executable = 34;
    stale.semantic.unavailable = stale.semantic.total - 34;
    stale.semantic.ready = false;
    stale.cutoverReady = false;
    expect(() => assertLiveKernelAssembly(stale, 'store-chrome')).toThrow(
      'complete live kernel assembly',
    );
  });

  test('rejects fabricated self-consistent counts that disagree with the authoritative ledgers', () => {
    const fabricated = completeLiveKernelAssemblyFixture('store-firefox') as any;
    fabricated.events.pop();
    fabricated.counts.eventInventory = fabricated.events.length;
    fabricated.semantic.total += 1;
    fabricated.semantic.migrated = fabricated.semantic.total;
    fabricated.semantic.executable = fabricated.semantic.total;
    expect(() => assertLiveKernelAssembly(fabricated, 'store-firefox')).toThrow(
      'complete live kernel assembly',
    );
  });
});
