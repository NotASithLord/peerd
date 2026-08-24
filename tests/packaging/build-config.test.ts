import { describe, expect, test } from 'bun:test';
import {
  backgroundEntryFromManifest,
  genBuildConfigSource,
} from '../../packaging/gen-build-config.ts';

describe('generated build identity', () => {
  test('stamps the exact Chrome and Firefox background entries', () => {
    expect(backgroundEntryFromManifest({
      background: { service_worker: 'background/vault-kernel.js' },
    })).toBe('background/vault-kernel.js');
    expect(backgroundEntryFromManifest({
      background: { scripts: ['background/vault-kernel.js'] },
    })).toBe('background/vault-kernel.js');
  });

  test('emits immutable version and background identity', () => {
    const source = genBuildConfigSource({
      version: '0.7.3',
      background: { service_worker: 'background/vault-kernel.js' },
    }, { dwebEnabled: true });
    expect(source).toContain('export const EXTENSION_VERSION = "0.7.3";');
    expect(source).toContain('export const BACKGROUND_MODULE_PATH = "background/vault-kernel.js";');
    expect(source).toContain('export const BROWSER = "chrome";');
    expect(source).toContain('export const CHANNEL = "preview";');
    expect(source).toContain('export const DWEB_ENABLED = true;');
    expect(source).toContain('export const CHANNEL_DEFAULTS = Object.freeze(');
    expect(source).toContain('"dwebEnabled":true');
    expect(genBuildConfigSource({
      version: '0.7.3',
      background: { service_worker: 'background/vault-kernel.js' },
    }, { channel: 'store', browser: 'chrome' }))
      .not.toContain('"dwebEnabled"');
  });

  test('fails closed without a complete manifest identity', () => {
    expect(() => genBuildConfigSource({
      version: '0.7.3', background: {},
    })).toThrow('manifest has no background module entry');
    expect(() => genBuildConfigSource({
      background: { service_worker: 'background/service-worker.js' },
    })).toThrow('manifest has no extension version');
  });
});
