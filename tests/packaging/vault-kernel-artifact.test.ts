import { describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertVaultKernelReleaseTarget,
  bundleChromeVaultKernel,
  NATIVE_CHROME_PRUNED_IMPORTS,
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
      background: { service_worker: 'background/vault-kernel.js', type: 'module' },
    });
    expect(preview.background).toEqual({
      service_worker: 'background/vault-kernel-preview.js', type: 'module',
    });
    expect(firefox).toMatchObject({
      name: 'peerd vault kernel store floor',
      permissions: ['storage'],
      background: { scripts: ['background/vault-kernel.js'], type: 'module' },
    });
    expect(source.background.service_worker).toBe('background/service-worker.js');
  });

  test('release-minified floor cannot exceed the native service-worker target', () => {
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 76, graphBytes: 300_000, entryBytes: 30_000,
    })).not.toThrow();
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 76, graphBytes: 300_001, entryBytes: 30_000,
    })).toThrow('graphBytes 300001 exceeds 300000');
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 0, graphBytes: 1, entryBytes: 1,
    })).toThrow('invalid native modules');
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 1, graphBytes: 300_000, entryBytes: 300_000,
      bundled: true,
    })).not.toThrow();
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 2, graphBytes: 190_000, entryBytes: 190_000,
      bundled: true,
    })).toThrow('exactly one static module');
    expect(() => assertVaultKernelReleaseTarget({
      browser: 'chrome', modules: 1, graphBytes: 300_001, entryBytes: 300_001,
      bundled: true,
    })).toThrow('graphBytes 300001 exceeds 300000');
  });

  test('Chrome ships one module bundle and prunes both Firefox runtime edges', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'peerd-native-kernel-bundle-'));
    const background = join(staging, 'background');
    mkdirSync(background, { recursive: true });
    writeFileSync(join(background, 'dep.js'), 'export const answer = 42;\n');
    writeFileSync(join(background, 'vault-kernel.js'), [
      "import { answer } from './dep.js';",
      "const kernelFirefox = 'chrome' === 'firefox';",
      "class ExactNamedError extends Error { constructor() { super(); this.name = 'ExactNamedError'; } }",
      'globalThis.__peerdBundleErrorName = new ExactNamedError().name;',
      'globalThis.__peerdBundleValue = answer;',
      "globalThis.__peerdBundleFirefox = kernelFirefox ? () => import('./firefox-storage-keepalive.js') : undefined;",
      "globalThis.__peerdBundleRepository = kernelFirefox ? () => import('./repository-local-client.js') : undefined;",
      '',
    ].join('\n'));
    try {
      const result = await bundleChromeVaultKernel(staging, 'background/vault-kernel.js');
      const output = readFileSync(join(background, 'vault-kernel.js'), 'utf8');
      expect(NATIVE_CHROME_PRUNED_IMPORTS).toHaveLength(2);
      expect(result.runtimeImports).toEqual([]);
      expect(output.trimStart().startsWith('(()=>')).toBe(false);
      expect(output).not.toContain('export{');
      expect(output).not.toContain("from'./dep.js'");
      expect(output).not.toContain('from"./dep.js"');
      expect([...output.matchAll(/\bimport\((['"])([^'"]+)\1\)/g)]
        .map((match) => match[2]).sort()).toEqual([]);
      Function(output)();
      expect((globalThis as any).__peerdBundleErrorName).toBe('ExactNamedError');
      expect((globalThis as any).__peerdBundleValue).toBe(42);
      delete (globalThis as any).__peerdBundleErrorName;
      delete (globalThis as any).__peerdBundleValue;
      delete (globalThis as any).__peerdBundleFirefox;
      delete (globalThis as any).__peerdBundleRepository;
      expect(result.bytes).toBeLessThan(2_000);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test('live manifest and release artifact inventory remain on the legacy entry', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'manifests/base.json'), 'utf8'));
    const release = readFileSync(join(REPO_ROOT, 'packaging/release.ts'), 'utf8');
    expect(manifest.background).toEqual({
      service_worker: 'background/service-worker.js', type: 'module',
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
    expect(source).toContain('bundleChromeVaultKernel(staging, nativeEntry(browser, channel))');
    expect(source).toContain('assertVaultKernelReleaseTarget({');
    expect(source).toContain('dwebEnabled: dwebEnabledForTarget(channel, browser), channel, browser');
    expect(source).toContain('writeControllerBuildIdentity(staging)');
    expect(source).not.toContain('generateManifest(');
  });

  test('release packaging requires the actual controller identity leaf before stamping', () => {
    const source = readFileSync(join(REPO_ROOT, 'packaging/package.ts'), 'utf8');
    const stampGuard = source.slice(
      source.indexOf('const canStampController'),
      source.indexOf('if (canStampController)'),
    );
    expect(stampGuard).toContain("join(staging, 'shared', 'controller-build.js')");
    expect(stampGuard).not.toContain("join(staging, 'shared', 'structured-clone-size.js')");
  });

  test('Chrome passphrase floor proves demand-owned vault authority custody', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/cdp/run-vault-kernel-passphrase.mjs'), 'utf8',
    );
    expect(source).toContain("claim: 'test-only-packaged-vault-authority-demand-floor'");
    expect(source).toContain('offscreenContextsBeforeDemand');
    expect(source).toContain('maxOffscreenContexts !== 1');
    expect(source).toContain('retainedWhileUnlocked !== true');
    expect(source).toContain('vault authority host survived lock');
    expect(source).toContain("type: 'vault/initialize'");
    expect(source).toContain("type: 'vault/unlock'");
    expect(source).toContain(
      "assertLiveKernelAssembly(bootstrap.assembly, 'store-chrome')",
    );
    expect(source).toContain('assembly.identity.bootId !== bootstrap.bootId');
  });

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

  test('Firefox physical floor packages only in tmp and pins the native route contract', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/firefox/vault-kernel-physical.mjs'), 'utf8',
    );
    expect(source).toContain("mkdtempSync(join(tmpdir(), 'peerd-vault-kernel-firefox-'))");
    expect(source).toContain("scripts: ['background/vault-kernel.js']");
    expect(source).toContain("HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html");
    expect(source).toContain('EVENT_PAGE_IDLE_MS = 45_000');
    expect(source).toContain('afterIdleBoot.bootId === initialBoot.bootId');
    expect(source).toContain('afterIdleBoot.kernelEpoch === initialBoot.kernelEpoch');
    expect(source).toContain(
      "assertLiveKernelAssembly(initialBoot?.assembly, 'store-firefox')",
    );
    expect(source).toContain(
      "assertLiveKernelAssembly(afterIdleBoot?.assembly, 'store-firefox')",
    );
    expect(source).toContain('assembly.identity.bootId === value.bootId');
    expect(source).not.toContain('ownedRequiredEvents === 5');
    expect(source).not.toContain('semantic?.migrated === 34');
    expect(source).not.toContain("join(ROOT, 'artifacts'");
    expect(source).not.toContain('ARTIFACTS_DIR');
    expect(source).not.toContain('packageArtifact(');
  });
});
