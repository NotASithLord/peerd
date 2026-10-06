import { expect, test } from 'bun:test';
import { supportsWasmer } from '../../../extension/engine-tabs/pod-tab/wasmer-capability.js';

test('Wasmer requires both browser isolation and working shared-memory support', () => {
  expect(supportsWasmer({ crossOriginIsolated: true, SharedArrayBuffer })).toBe(true);
  // Firefox packaging strips the Chromium isolation policies. Merely exposing
  // the constructor must not advertise a runnable local-file action there.
  expect(supportsWasmer({ crossOriginIsolated: false, SharedArrayBuffer })).toBe(false);
  expect(supportsWasmer({ crossOriginIsolated: true })).toBe(false);
  expect(supportsWasmer({})).toBe(false);
  expect(supportsWasmer({ crossOriginIsolated: true, SharedArrayBuffer: {} })).toBe(false);
});
