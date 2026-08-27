import { describe, expect, test } from 'bun:test';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genBuildConfigSource } from '../../packaging/gen-build-config.ts';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertNativeChromeBundleRatchet,
  bundleChromeNativeKernel,
  isChromeNativeKernelEntry,
  NATIVE_CHROME_BUNDLE_RATCHETS,
  NATIVE_CHROME_PRUNED_IMPORTS,
} from '../../packaging/bundle-chrome-native-kernel.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { FIREFOX_BACKGROUND_ENTRY } from '../../packaging/gen-manifest.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  assertVaultKernelArtifactShape,
  vaultKernelManifest,
} from '../../scripts/cdp/vault-kernel-artifact.mjs';

describe('test-only vault kernel package target', () => {
  test('release bundling recognizes only the two native Chrome entries', () => {
    expect(isChromeNativeKernelEntry('background/vault-kernel-chrome.js')).toBe(true);
    expect(isChromeNativeKernelEntry('background/vault-kernel-preview.js')).toBe(true);
    expect(isChromeNativeKernelEntry('background/service-worker.js')).toBe(false);
    expect(isChromeNativeKernelEntry('background/vault-kernel-chrome.js?forged')).toBe(false);
  });

  test('release bundling pins the exact staged input closure and byte ceiling', () => {
    const inputs = Object.freeze(Array.from({ length: 396 }, (_, index) => `input-${index}.js`));
    const exact = {
      bytes: NATIVE_CHROME_BUNDLE_RATCHETS['background/vault-kernel-chrome.js'].bytes,
      inputs,
      inputSha256: 'c51755505453e1384498f571772bc006dd27253881da630c9f1de7b2035e84bf',
    };
    expect(() => assertNativeChromeBundleRatchet(
      'background/vault-kernel-chrome.js', exact,
    )).not.toThrow();
    expect(() => assertNativeChromeBundleRatchet(
      'background/vault-kernel-chrome.js', { ...exact, bytes: exact.bytes + 1 },
    )).toThrow('native Chrome bundle grew');
    expect(() => assertNativeChromeBundleRatchet(
      'background/vault-kernel-chrome.js', { ...exact, inputSha256: '0'.repeat(64) },
    )).toThrow('input closure changed');
  });

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

  test('release-minified floor validates metrics and the bundled module shape', () => {
    expect(() => assertVaultKernelArtifactShape({
      modules: 76, graphBytes: 900_000, entryBytes: 30_000,
    })).not.toThrow();
    expect(() => assertVaultKernelArtifactShape({
      modules: 0, graphBytes: 1, entryBytes: 1,
    })).toThrow('invalid native modules');
    expect(() => assertVaultKernelArtifactShape({
      modules: 1, graphBytes: 1_300_000, entryBytes: 1_300_000,
      bundled: true,
    })).not.toThrow();
    expect(() => assertVaultKernelArtifactShape({
      modules: 2, graphBytes: 190_000, entryBytes: 190_000,
      bundled: true,
    })).toThrow('exactly one static module');
    expect(() => assertVaultKernelArtifactShape({
      modules: 1, graphBytes: 1_300_000, entryBytes: 1_299_999,
      bundled: true,
    })).toThrow('exactly one static module');
  });

  test('Chrome ships one module bundle and prunes both Firefox runtime edges', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'peerd-native-kernel-bundle-'));
    const background = join(staging, 'background');
    mkdirSync(background, { recursive: true });
    writeFileSync(join(background, 'dep.js'), 'export const answer = 42;\n');
    writeFileSync(join(background, 'vault-kernel-chrome.js'), [
      "import { answer } from './dep.js';",
      "const kernelFirefox = 'chrome' === 'firefox';",
      "class ExactNamedError extends Error { constructor() { super(); this.name = 'ExactNamedError'; } }",
      'globalThis.__peerdBundleErrorName = new ExactNamedError().name;',
      'globalThis.__peerdBundleValue = answer;',
      "globalThis.__peerdBundleFirefox = kernelFirefox ? () => import('./firefox-storage-keepalive.js') : undefined;",
      "globalThis.__peerdBundleRepository = kernelFirefox ? () => import('./repository-local-client.js') : undefined;",
      "globalThis.__peerdBundleActor = kernelFirefox ? () => import('./direct-actor-host.js') : undefined;",
      '',
    ].join('\n'));
    try {
      const result = await bundleChromeNativeKernel(staging, 'background/vault-kernel-chrome.js');
      const output = readFileSync(join(background, 'vault-kernel-chrome.js'), 'utf8');
      expect(NATIVE_CHROME_PRUNED_IMPORTS).toHaveLength(3);
      expect(result.inputs).toEqual([
        'background/dep.js',
        'background/vault-kernel-chrome.js',
      ]);
      expect(output).toContain('peerd.kernel.bundle-start.v1');
      expect(output.trimStart().startsWith('(()=>')).toBe(false);
      expect(output).not.toContain('export{');
      expect(output).not.toContain("from'./dep.js'");
      expect(output).not.toContain('from"./dep.js"');
      expect([...output.matchAll(/\bimport\((['"])([^'"]+)\1\)/g)]
        .map((match) => match[2]).sort()).toEqual([]);
      Function(output)();
      expect((globalThis as any).__peerdBundleErrorName).toBe('ExactNamedError');
      expect((globalThis as any).__peerdBundleValue).toBe(42);
      expect((globalThis as any)[Symbol.for('peerd.kernel.bundle-start.v1')])
        .toBeGreaterThanOrEqual(0);
      delete (globalThis as any).__peerdBundleErrorName;
      delete (globalThis as any).__peerdBundleValue;
      delete (globalThis as any).__peerdBundleFirefox;
      delete (globalThis as any).__peerdBundleRepository;
      delete (globalThis as any).__peerdBundleActor;
      delete (globalThis as any)[Symbol.for('peerd.kernel.bundle-start.v1')];
      expect(result.bytes).toBeLessThan(2_000);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test('Chrome rejects a distributed implementation edge in the worker bundle', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'peerd-native-kernel-dweb-'));
    mkdirSync(join(staging, 'background'), { recursive: true });
    mkdirSync(join(staging, 'shared'), { recursive: true });
    mkdirSync(join(staging, 'peerd-distributed'), { recursive: true });
    writeFileSync(
      join(staging, 'background', 'vault-kernel-preview.js'),
      "void import('/shared/dweb-loader.js');\n",
    );
    writeFileSync(
      join(staging, 'shared', 'dweb-loader.js'),
      "export const loadDweb = () => import('/peerd-distributed/index.js');\n",
    );
    writeFileSync(join(staging, 'peerd-distributed', 'index.js'), 'export const live = true;\n');
    try {
      await expect(bundleChromeNativeKernel(
        staging, 'background/vault-kernel-preview.js',
      )).rejects.toThrow('native Chrome kernel hosted distributed inputs');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  test('Chrome bundles only staged Store and Preview target identity', async () => {
    const targets = [
      {
        channel: 'store' as const,
        entry: 'background/vault-kernel-chrome.js',
        digest: 'a'.repeat(64),
        dwebEnabled: false,
        advancedAutomationEnabled: false,
        webActorActionSurface: 'tools',
      },
      {
        channel: 'preview' as const,
        entry: 'background/vault-kernel-preview.js',
        digest: 'b'.repeat(64),
        dwebEnabled: true,
        advancedAutomationEnabled: true,
        webActorActionSurface: 'code',
      },
    ];
    for (const target of targets) {
      const staging = mkdtempSync(join(tmpdir(), `peerd-native-${target.channel}-bundle-`));
      const background = join(staging, 'background');
      const shared = join(staging, 'shared');
      mkdirSync(background, { recursive: true });
      mkdirSync(shared, { recursive: true });
      const manifest = {
        version: '0.7.3',
        background: { service_worker: target.entry, type: 'module' },
      };
      const buildConfig = genBuildConfigSource(manifest, {
        browser: 'chrome', channel: target.channel,
        dwebEnabled: target.dwebEnabled,
      }).replace('0'.repeat(64), target.digest);
      writeFileSync(join(shared, 'build-config.js'), buildConfig);
      writeFileSync(join(staging, target.entry), [
        'import {',
        '  BACKGROUND_MODULE_PATH, BROWSER, CHANNEL, CHANNEL_DEFAULTS,',
        '  CONTROLLER_BUILD_DIGEST, DWEB_ENABLED,',
        "} from '/shared/build-config.js';",
        'globalThis.__peerdNativeBundleTarget = {',
        '  background: BACKGROUND_MODULE_PATH, browser: BROWSER, channel: CHANNEL,',
        '  digest: CONTROLLER_BUILD_DIGEST, dwebEnabled: DWEB_ENABLED,',
        '  advancedAutomationEnabled: CHANNEL_DEFAULTS.advancedAutomationEnabled,',
        '  webActorActionSurface: CHANNEL_DEFAULTS.webActorActionSurface,',
        '};',
        '',
      ].join('\n'));
      try {
        const result = await bundleChromeNativeKernel(staging, target.entry);
        expect(result.inputs).toEqual([
          target.entry,
          'shared/build-config.js',
        ].sort());
        Function(readFileSync(join(staging, target.entry), 'utf8'))();
        expect((globalThis as any).__peerdNativeBundleTarget).toEqual({
          background: target.entry,
          browser: 'chrome',
          channel: target.channel,
          digest: target.digest,
          dwebEnabled: target.dwebEnabled,
          advancedAutomationEnabled: target.advancedAutomationEnabled,
          webActorActionSurface: target.webActorActionSurface,
        });
      } finally {
        delete (globalThis as any).__peerdNativeBundleTarget;
        delete (globalThis as any)[Symbol.for('peerd.kernel.bundle-start.v1')];
        rmSync(staging, { recursive: true, force: true });
      }
    }
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
    expect(source).toContain('bundleChromeNativeKernel(staging, nativeEntry(browser, channel))');
    expect(source).toContain('assertVaultKernelArtifactShape({');
    expect(source).toContain('dwebEnabled: dwebEnabledForTarget(channel, browser), channel, browser');
    expect(source).toContain('writeControllerBuildIdentity(staging)');
    expect(source).not.toContain('generateManifest(');
  });

  test('bundled kernel timing keeps the worker-origin reply marker', () => {
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
    const bundleAt = source.indexOf('await bundleChromeNativeKernel(staging, chromeBackgroundEntry)');
    const packageAt = source.indexOf('// Package. AMO takes .xpi');
    expect(source).toContain(
      'const nativeChromeKernel = isChromeNativeKernelEntry(chromeBackgroundEntry)',
    );
    expect(source).toContain('if (minify && nativeChromeKernel)');
    expect(source).toContain('assertColdArtifactBudgets(report)');
    expect(stampAt).toBeGreaterThan(0);
    expect(bundleAt).toBeGreaterThan(stampAt);
    expect(packageAt).toBeGreaterThan(bundleAt);
  });

  test('release packaging bundles native Chrome and leaves native Firefox modular', async () => {
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
        expect(graph.size > 1).toBe(browser === 'firefox');
        if (browser === 'chrome') {
          expect(graph.size).toBe(1);
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
    expect(source).toContain('scripts: [FIREFOX_BACKGROUND_ENTRY]');
    expect(source).toContain('FIREFOX_BACKGROUND_ENTRY');
    expect(source).toContain("HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html");
    expect(source).toContain('EVENT_PAGE_IDLE_MS = 45_000');
    expect(source).toContain('afterIdleBoot.bootId === initialBoot.bootId');
    expect(source).toContain('afterIdleBoot.kernelEpoch === initialBoot.kernelEpoch');
    expect(source).toContain("ordinaryPage !== 'ordinary-firefox-tab'");
    expect(source).toContain('FIREFOX_DRIVEN_CHILD_IDS_KEY');
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
