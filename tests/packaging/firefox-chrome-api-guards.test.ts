import { describe, expect, test } from 'bun:test';
import {
  FIREFOX_BUILD_NAMES,
  GUARDED_CHROME_ONLY,
} from '../../packaging/check-firefox.ts';

const NATIVE_KERNEL_GUARDS = [
  'offscreen.createDocument|background/kernel-feature-host.js',
  'offscreen.closeDocument|background/kernel-feature-host.js',
  'sidePanel.open|background/kernel-front-door.js',
  'sidePanel.setPanelBehavior|background/kernel-front-door.js',
  'runtime.requestUpdateCheck|background/vault-kernel.js',
  'runtime.requestUpdateCheck|background/service-worker.js',
];

describe('Firefox Chrome-only API guard inventory', () => {
  test('the static package gate requires both Store and Preview Firefox artifacts', () => {
    expect(FIREFOX_BUILD_NAMES).toEqual(['store-firefox', 'preview-firefox']);
  });

  test('the native/legacy kernel exceptions are exact and carry executable guard proof', () => {
    const entries = GUARDED_CHROME_ONLY.filter((entry) => entry.proof);
    expect(entries.map((entry) => `${entry.api}|${entry.file}`)).toEqual(NATIVE_KERNEL_GUARDS);
    expect(new Set(entries.map((entry) => `${entry.api}|${entry.file}`)).size)
      .toBe(NATIVE_KERNEL_GUARDS.length);
    for (const entry of entries) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.proof?.length).toBeGreaterThanOrEqual(2);
    }
  });
});
