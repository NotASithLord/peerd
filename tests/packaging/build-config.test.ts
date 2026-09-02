import { describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backgroundEntryFromManifest,
  genBuildConfigSource,
  writeDevBuildConfig,
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

  test('writes build config before stamping both identity leaves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-dev-build-config-'));
    try {
      const manifestFile = join(root, 'manifest.json');
      const out = join(root, 'extension', 'shared', 'build-config.js');
      const controllerBuild = join(root, 'extension', 'shared', 'controller-build.js');
      mkdirSync(join(root, 'extension', 'shared'), { recursive: true });
      mkdirSync(join(root, 'extension', 'offscreen'), { recursive: true });
      writeFileSync(manifestFile, JSON.stringify({
        version: '0.7.3',
        background: { service_worker: 'background/vault-kernel-preview.js' },
      }));
      writeFileSync(
        controllerBuild,
        `export const CONTROLLER_BUILD_DIGEST = '${'0'.repeat(64)}';\n`,
      );
      writeFileSync(
        join(root, 'extension', 'offscreen', 'offscreen.js'),
        "import '../shared/build-config.js';\nimport '../shared/controller-build.js';\n",
      );
      const digest = await writeDevBuildConfig({
        manifestFile,
        out,
      });
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(digest).not.toBe('0'.repeat(64));
      for (const file of [out, controllerBuild]) {
        expect(readFileSync(file, 'utf8')).toContain(
          `CONTROLLER_BUILD_DIGEST = '${digest}'`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
