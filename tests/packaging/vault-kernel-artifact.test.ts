import { describe, expect, test } from 'bun:test';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { FIREFOX_BACKGROUND_ENTRY } from '../../packaging/gen-manifest.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  assertVaultKernelArtifactShape,
  vaultKernelManifest,
} from '../../scripts/cdp/vault-kernel-artifact.mjs';

describe('test-only vault kernel package target', () => {
  test('changes only the copied background entry for each browser', () => {
    const source = {
      manifest_version: 3,
      name: 'peerd',
      permissions: ['storage'],
      background: { service_worker: 'background/service-worker.js', type: 'module' },
    };
    const chrome = vaultKernelManifest(source, 'chrome', 'store');
    const preview = vaultKernelManifest(source, 'chrome', 'preview');
    const firefox = vaultKernelManifest(source, 'firefox');
    expect(chrome).toMatchObject({
      name: 'peerd vault kernel store floor',
      permissions: ['storage'],
      background: { service_worker: 'background/vault-kernel-chrome.js', type: 'module' },
    });
    expect(preview.background).toEqual({
      service_worker: 'background/vault-kernel-preview.js', type: 'module',
    });
    expect(firefox).toMatchObject({
      name: 'peerd vault kernel store floor',
      permissions: ['storage'],
      background: { scripts: [FIREFOX_BACKGROUND_ENTRY], type: 'module' },
    });
    expect(source.background.service_worker).toBe('background/service-worker.js');
  });

  test('release-minified floor validates positive graph metrics', () => {
    expect(() => assertVaultKernelArtifactShape({
      modules: 76, graphBytes: 900_000, entryBytes: 30_000,
    })).not.toThrow();
    expect(() => assertVaultKernelArtifactShape({
      modules: 0, graphBytes: 1, entryBytes: 1,
    })).toThrow('invalid native modules');
  });

  test('live manifest owns the native kernel entry', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifests/base.json'), 'utf8'));
    const release = readFileSync(join(REPO_ROOT, 'packaging/release.ts'), 'utf8');
    expect(manifest.background).toEqual({
      service_worker: 'background/vault-kernel-chrome.js', type: 'module',
    });
    expect(release).not.toContain('peerd-vault-kernel');
  });

  test('builder permits small controller adapters but excludes every feature implementation', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/cdp/vault-kernel-artifact.mjs'), 'utf8',
    );
    expect(source).toContain("`vault-kernel-${channel}-${browser}`");
    expect(source).toContain("path.startsWith('offscreen/')");
    expect(source).toContain("path.includes('controller-turn')");
    expect(source).toContain("path.includes('agent-loop')");
    expect(source).toContain("path.includes('semantic-route-host')");
    expect(source).toContain("`peerd-vault-kernel-${channel}-${browser}.${extension}`");
    expect(source).toContain("verify: channel === 'store', minify: false");
    expect(source).toContain('minifyColdArtifactModules(staging, browser, channel)');
    expect(source).toContain('assertVaultKernelArtifactShape({');
    expect(source).toContain('dwebEnabled: dwebEnabledForTarget(channel, browser), channel, browser');
    expect(source).toContain('writeControllerBuildIdentity(staging)');
    expect(source).not.toContain('generateManifest(');
  });

  test('kernel timing keeps the worker-origin reply marker', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'extension/background/vault-kernel.js'), 'utf8',
    );
    expect(source).toContain('replyFromWorkerTimeOriginMs');
  });

  test('release packaging requires the actual controller identity leaf before stamping', () => {
    const source = readFileSync(join(REPO_ROOT, 'packaging/package.ts'), 'utf8');
    const stampGuard = source.slice(
      source.indexOf('const canStampController'),
      source.indexOf('if (canStampController)'),
    );
    expect(stampGuard).toContain("join(staging, 'shared', 'controller-build.js')");
    expect(stampGuard).not.toContain("join(staging, 'shared', 'structured-clone-size.js')");
    const stampAt = source.indexOf('await writeControllerBuildIdentity(staging)');
    const packageAt = source.indexOf('// Package. AMO takes .xpi');
    expect(source).toContain('assertColdArtifactBudgets(report)');
    expect(source).not.toContain('bundleChromeNativeKernel');
    expect(stampAt).toBeGreaterThan(0);
    expect(packageAt).toBeGreaterThan(stampAt);
  });

  test('release packaging preserves modular Chrome and Firefox entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-native-package-path-'));
    const sourceRoot = join(root, 'source');
    const artifactRoot = join(root, 'artifacts');
    try {
      mkdirSync(sourceRoot, { recursive: true });
      cpSync(join(REPO_ROOT, 'extension'), join(sourceRoot, 'extension'), { recursive: true });
      cpSync(join(REPO_ROOT, 'manifests'), join(sourceRoot, 'manifests'), { recursive: true });
      mkdirSync(join(sourceRoot, 'packaging'), { recursive: true });
      cpSync(
        join(REPO_ROOT, 'packaging', 'default-settings.mjs'),
        join(sourceRoot, 'packaging', 'default-settings.mjs'),
      );
      const basePath = join(sourceRoot, 'manifests', 'base.json');
      const base = JSON.parse(readFileSync(basePath, 'utf8'));
      base.background.service_worker = 'background/vault-kernel-chrome.js';
      writeFileSync(basePath, `${JSON.stringify(base, null, 2)}\n`);

      for (const browser of ['chrome', 'firefox'] as const) {
        await packageArtifact({
          sourceRoot, artifactRoot, channel: 'store', browser,
          version: '0.7.3', sign: false, verify: false, minify: true,
        });
        const staging = join(artifactRoot, 'staging', `store-${browser}`);
        const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
        const entryRelative = browser === 'chrome'
          ? manifest.background.service_worker : manifest.background.scripts[0];
        const graph = await collectStaticModuleGraph(staging, join(staging, entryRelative));
        expect(entryRelative).toBe(browser === 'firefox'
          ? FIREFOX_BACKGROUND_ENTRY : 'background/vault-kernel-chrome.js');
        expect(graph.size).toBeGreaterThan(1);
        if (browser === 'chrome') {
          expect(statSync(join(staging, entryRelative)).size).toBeGreaterThan(0);
        } else {
          expect(graph.has(join(staging, 'background/driven-child-request-guard.js'))).toBe(true);
          for (const leaf of [
            'background/direct-controller-client.js',
            'background/offscreen-controller-client.js',
            'background/firefox-storage-keepalive.js',
            'background/repository-local-client.js',
          ]) {
            expect(existsSync(join(staging, leaf)), leaf).toBe(true);
            expect(graph.has(join(staging, leaf)), leaf).toBe(false);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('physical floor is explicit about controller and recycle non-claims', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/cdp/run-vault-kernel-passkey.mjs'), 'utf8',
    );
    expect(source).toContain("claim: 'test-only-packaged-vault-kernel-floor'");
    expect(source).toContain('offscreenContextsAtCta');
    expect(source).toContain('offscreenContextsAfterInitialize');
    expect(source).toContain('controllerReadyClaimed: false');
    expect(source).toContain('recycleClaimed: false');
    expect(source).toContain("clock: 'host-monotonic-ms'");
    expect(source).toContain(
      "assertLiveKernelAssembly(bootstrap.assembly, 'store-chrome')",
    );
    expect(source).toContain('assembly.identity.bootId !== bootstrap.bootId');
    expect(source).not.toContain('ownedRequiredEvents !== 5');
    expect(source).not.toContain('semantic?.migrated !== 34');
    expect(source).not.toContain('terminateServiceWorker');
    expect(source).not.toContain('Target.closeTarget');
  });

});
