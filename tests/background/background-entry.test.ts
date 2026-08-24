import { describe, expect, test } from 'bun:test';
import {
  backgroundModulePath,
  backgroundModuleUrl,
} from '../../extension/shared/background-entry.js';

describe('packaged background entry provenance', () => {
  test('derives Chrome and Firefox background modules from the manifest', () => {
    expect(backgroundModulePath({
      background: { service_worker: 'background/vault-kernel.js' },
    })).toBe('background/vault-kernel.js');
    expect(backgroundModulePath({
      background: { scripts: ['background/vault-kernel.js'] },
    })).toBe('background/vault-kernel.js');
    expect(backgroundModulePath({ background: {} })).toBeNull();
  });

  test('builds the exact browser-owned URL and fails closed without an entry', () => {
    const runtime = {
      getManifest: () => ({ background: { service_worker: 'background/vault-kernel.js' } }),
      getURL: (path: string) => `chrome-extension://id/${path}`,
    };
    expect(backgroundModuleUrl({ runtime }))
      .toBe('chrome-extension://id/background/vault-kernel.js');
    expect(backgroundModuleUrl({
      runtime: { ...runtime, getManifest: () => ({}) },
    })).toBe('chrome-extension://id/background/service-worker.js');
  });

  test('uses the package-stamped entry when an offscreen realm has no getManifest', () => {
    expect(backgroundModuleUrl({
      runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    })).toBe('chrome-extension://id/background/service-worker.js');
  });
});
