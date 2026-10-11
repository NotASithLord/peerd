import { expect, test } from 'bun:test';
import { normalizeAppRuntime } from '../../extension/shared/app-runtime-contract.js';
import { appRuntimeVerdict, appRuntimeFromFiles, assertAppRuntimeAgreement, assertAppRuntime, probeAppRuntime } from '../../extension/shared/app-runtime.js';

const core = { schema: 1, target: 'browser-app', requires: ['wasm-core'] };

test('runtime declarations normalize without dropping unfamiliar prerequisites', () => {
  expect(normalizeAppRuntime({ ...core, requires: ['wasm-simd', 'wasm-core', 'wasm-simd'] }))
    .toEqual({ ...core, requires: ['wasm-core', 'wasm-simd'] });
  expect(appRuntimeVerdict(undefined, []).status).toBe('unspecified');
  expect(appRuntimeVerdict(core, ['wasm-core']).status).toBe('supported');
  expect(appRuntimeVerdict({ ...core, requires: ['wasm-threads'] }, ['wasm-core'])).toMatchObject({ status: 'unsupported', missing: ['wasm-threads'] });
  expect(appRuntimeVerdict({ ...core, target: 'wasi' }, ['wasm-core']).status).toBe('unsupported');
  expect(appRuntimeVerdict({ ...core, schema: 2 }, ['wasm-core']).status).toBe('unsupported');
});

test('malformed declarations fail instead of becoming legacy unspecified', () => {
  for (const value of [null, [], { ...core, requires: 'wasm-core' }, { ...core, requires: Array(17).fill('wasm-core') }, { ...core, grant: 'network' }]) {
    expect(() => normalizeAppRuntime(value)).toThrow();
  }
  expect(() => assertAppRuntime(core, [])).toThrow('unavailable');
});

test('runtime extraction comes from the actual peerd.json bytes', () => {
  const files = { 'peerd.json': new TextEncoder().encode(JSON.stringify({ runtime: core })) };
  expect(appRuntimeFromFiles(files)).toEqual(core);
  expect(appRuntimeFromFiles({ 'index.html': 'legacy' })).toBeUndefined();
  expect(() => appRuntimeFromFiles({ 'peerd.json': '{bad' })).toThrow('valid JSON');
  expect(() => appRuntimeFromFiles({ 'peerd.json': new Uint8Array([255]) })).toThrow('valid UTF-8');
  expect(() => assertAppRuntimeAgreement(undefined, core)).toThrow('signed version');
  expect(() => assertAppRuntimeAgreement(core, { ...core, requires: [] })).toThrow('signed version');
});

test('a visible namespace without compile support does not qualify the host', () => {
  const denied = { Module: class { constructor() { throw new Error('CSP'); } } } as unknown as typeof WebAssembly;
  expect(probeAppRuntime(denied)).toEqual([]);
  expect(probeAppRuntime()).toEqual(['wasm-core']);
});
