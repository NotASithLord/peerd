import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  collectStaticModuleGraph,
  staticImportSpecifiers,
} from '../../packaging/static-module-graph.ts';
import {
  PACKAGED_LAZY_ASSET_ENTRIES,
  PACKAGED_LAZY_MODULE_ENTRIES,
} from '../../packaging/lazy-entry-manifest.ts';
import {
  COLD_SOURCE_TARGETS,
  LEGACY_COLD_SOURCE_RATCHETS,
  PREVIEW_KERNEL_SOURCE_RATCHET,
} from '../../scripts/bench/cold-start-policy.mjs';

const entries = {
  kernel: 'background/service-worker.js',
  sidepanel: 'sidepanel/boot.js',
  home: 'home/boot.js',
  offscreen: 'offscreen/offscreen.js',
} as const;

const nativeKernelEntry = 'background/vault-kernel.js';
const previewKernelEntry = 'background/vault-kernel-preview.js';

const stats = async (name: keyof typeof entries) => {
  const entry = join(EXTENSION_DIR, entries[name]);
  const graph = await collectStaticModuleGraph(EXTENSION_DIR, entry);
  return {
    modules: graph.size,
    graphBytes: [...graph].reduce((total, file) => total + statSync(file).size, 0),
    entryBytes: statSync(entry).size,
    directImports: (await staticImportSpecifiers(
      readFileSync(entry, 'utf8'),
      relative(EXTENSION_DIR, entry),
    )).length,
    modulesSet: new Set([...graph].map((file) => relative(EXTENSION_DIR, file))),
  };
};

const nativeKernelStats = async (entryName = nativeKernelEntry) => {
  const entry = join(EXTENSION_DIR, entryName);
  const graph = await collectStaticModuleGraph(EXTENSION_DIR, entry);
  return {
    modules: graph.size,
    graphBytes: [...graph].reduce((total, file) => total + statSync(file).size, 0),
    entryBytes: statSync(entry).size,
    directImports: (await staticImportSpecifiers(
      readFileSync(entry, 'utf8'),
      relative(EXTENSION_DIR, entry),
    )).length,
    modulesSet: new Set([...graph].map((file) => relative(EXTENSION_DIR, file))),
  };
};

describe('cold entry graphs', () => {
  test('every cold graph stays at or below its achieved no-growth ratchet', async () => {
    for (const name of Object.keys(entries) as Array<keyof typeof entries>) {
      const measured = await stats(name);
      const ratchet = LEGACY_COLD_SOURCE_RATCHETS[name];
      expect(measured.modules, `${name} modules`).toBeLessThanOrEqual(ratchet.modules);
      expect(measured.graphBytes, `${name} graph bytes`).toBeLessThanOrEqual(ratchet.graphBytes);
      expect(measured.entryBytes, `${name} entry bytes`).toBeLessThanOrEqual(ratchet.entryBytes);
      expect(measured.directImports, `${name} direct imports`).toBeLessThanOrEqual(ratchet.directImports);
    }
  });

  test('the new first-paint shells already meet the final source targets', async () => {
    for (const name of ['sidepanel', 'home'] as const) {
      const measured = await stats(name);
      const target = COLD_SOURCE_TARGETS[name];
      expect(measured.modules).toBeLessThanOrEqual(target.modules);
      expect(measured.graphBytes).toBeLessThanOrEqual(target.graphBytes);
      expect(measured.entryBytes).toBeLessThanOrEqual(target.entryBytes);
    }
  });

  test('the native authority kernel meets the final target without loading a controller for local routes', async () => {
    const measured = await nativeKernelStats();
    const target = COLD_SOURCE_TARGETS.kernel;
    expect(measured.modules).toBeLessThanOrEqual(target.modules);
    expect(measured.graphBytes).toBeLessThanOrEqual(target.graphBytes);
    expect(measured.entryBytes).toBeLessThanOrEqual(target.entryBytes);
    expect(measured.directImports).toBeLessThanOrEqual(target.directImports);
    for (const forbidden of [
      'background/service-worker.js',
      'peerd-runtime/loop/agent-loop.js',
      'offscreen/controller-runtime.js',
      'offscreen/controller-turn-runtime.js',
      'offscreen/semantic-route-host.js',
      'offscreen/artifact-host.js',
      'offscreen/artifact-worker.js',
      'background/offscreen-artifact-client.js',
      'background/actor-live-projection.js',
      'peerd-engine/repository/repository-service.js',
      'vendor/isomorphic-git/index.js',
      'background/direct-actor-host.js',
      'offscreen/actor-runner.js',
      'shared/argon2id.js',
      'vendor/argon2/argon2.js',
      'peerd-egress/vault/vault.js',
      'peerd-egress/vault/keys.js',
    ]) {
      expect(measured.modulesSet.has(forbidden), `native kernel imports ${forbidden}`).toBe(false);
    }
    // Chrome retains only the operation facades. Firefox repository and
    // storage-heartbeat implementations are first-demand branches in the
    // shared entry and never enter Chrome's static graph.
    expect(measured.modulesSet.has('background/repository-client.js')).toBe(true);
    expect(measured.modulesSet.has('background/firefox-storage-keepalive.js')).toBe(false);
    expect(measured.modulesSet.has('background/vault-authority-client.js')).toBe(true);
    expect(measured.modulesSet.has('shared/cold-util.js')).toBe(true);
    expect(measured.modulesSet.has('shared/util.js')).toBe(false);
    expect(measured.modulesSet.has('background/routes/contacts.js')).toBe(true);
    expect(measured.modulesSet.has('background/routes/toolbox.js')).toBe(true);
    expect(measured.modulesSet.has('background/kernel-semantic-demand.js')).toBe(false);
    expect(measured.modulesSet.has('background/semantic-demand-client.js')).toBe(false);
    expect(measured.modulesSet.has('shared/semantic-demand-policy.js')).toBe(false);
    expect(measured.modulesSet.has('peerd-engine/app-manifest.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/semantic.js')).toBe(true);
  });

  test('Preview Chrome alone owns the downloaded-update graph', async () => {
    const common = await nativeKernelStats();
    const preview = await nativeKernelStats(previewKernelEntry);
    expect({
      modules: preview.modules, graphBytes: preview.graphBytes,
      entryBytes: preview.entryBytes, directImports: preview.directImports,
    }).toEqual(PREVIEW_KERNEL_SOURCE_RATCHET);
    expect([...preview.modulesSet].filter((file) => !common.modulesSet.has(file)).sort()).toEqual([
      'background/kernel-controller-call.js',
      'background/kernel-update-addon.js',
      'background/vault-kernel-preview.js',
    ]);
    expect(common.modulesSet.has('background/kernel-update-addon.js')).toBe(false);
    const source = readFileSync(join(EXTENSION_DIR, previewKernelEntry), 'utf8');
    expect(source.indexOf("import './kernel-update-addon.js'"))
      .toBeLessThan(source.indexOf("import './vault-kernel.js'"));
  });

  test('the native Chrome authority entry has no reachable runtime module import', async () => {
    const measured = await nativeKernelStats();
    const offenders = [];
    for (const relativePath of measured.modulesSet) {
      const source = readFileSync(join(EXTENSION_DIR, relativePath), 'utf8');
      const executable = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (/\bimport\(\s*(['"])[^'"]+\1\s*\)/.test(executable)) offenders.push(relativePath);
    }
    // Target-specific direct Workers stay behind exact Firefox-only branches.
    // The Chrome semantic path is a static private-channel client; it contains
    // no runtime import expression of its own.
    expect(offenders.sort()).toEqual([
      'background/vault-kernel.js',
    ]);
    expect(readFileSync(join(EXTENSION_DIR, 'background/vault-kernel.js'), 'utf8'))
      .not.toContain('createKernelSemanticDemand');
    const kernelSource = readFileSync(join(EXTENSION_DIR, 'background/vault-kernel.js'), 'utf8');
    const executableKernel = kernelSource.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const runtimeImports = [...executableKernel.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)]
      .map((match) => match[2]);
    expect(runtimeImports).toEqual([
      './firefox-storage-keepalive.js',
      './repository-local-client.js',
    ]);
    expect(kernelSource)
      .toContain("kernelFirefox\n  ? createDeferredRepositoryClient");
    expect(kernelSource)
      .toContain("kernelFirefox\n    ? () => import('./firefox-storage-keepalive.js')");
    expect(kernelSource)
      .not.toContain("import('./direct-controller-client.js')");
    expect(measured.modulesSet.has('background/repository-local-client.js')).toBe(false);
  });

  test('pinned modern runtimes do not cold-load the compatibility shim', async () => {
    for (const name of Object.keys(entries) as Array<keyof typeof entries>) {
      const { modulesSet } = await stats(name);
      expect(modulesSet.has('vendor/browser-polyfill.js'), `${name} loads browser-polyfill`)
        .toBe(false);
      expect(modulesSet.has('shared/browser-api.js'), `${name} uses the native API surface`)
        .toBe(true);
    }
  });

  test('vault shells cannot pull semantic or privileged feature graphs into first paint', async () => {
    const forbidden = [
      'peerd-runtime/loop/',
      'peerd-runtime/tools/',
      'peerd-runtime/actor/',
      'peerd-provider/adapters/',
      'peerd-engine/repository/',
      'vendor/isomorphic-git/',
      'peerd-runtime/doc/',
      'peerd-runtime/pdf/',
      'peerd-distributed/',
    ];
    for (const name of ['sidepanel', 'home'] as const) {
      const { modulesSet } = await stats(name);
      for (const prefix of forbidden) {
        expect([...modulesSet].some((file) => file.startsWith(prefix)), `${name} imports ${prefix}`)
          .toBe(false);
      }
    }
  });

  test('the cold authority graph cannot regain the agent loop', async () => {
    const measured = await stats('kernel');
    expect(measured.modulesSet.has('peerd-runtime/loop/agent-loop.js')).toBe(false);
    expect(measured.modulesSet.has('offscreen/controller-turn-runtime.js')).toBe(false);
  });

  test('Chrome authority never relies on unsupported runtime module imports', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');
    // A JSDoc `import('...')` is type metadata, not a runtime module load.
    // Strip comments before enforcing Chrome's no-runtime-import boundary.
    const executable = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    const dynamicSpecifiers = [...executable.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)]
      .map((match) => match[2]);
    expect(dynamicSpecifiers).toEqual([
      '/peerd-engine/module-resolver.js',
      './repository-local-client.js',
    ]);
    expect(source).toContain('const toolboxParseCheck = offscreenAvailable');
    expect(source).toContain('const repositories = offscreenAvailable');
    expect(source).not.toContain("import('./routes/");
    expect(source).not.toContain("import('./offscreen-artifact-client.js')");
    expect(source).not.toContain("import('./repository-client.js')");
  });

  test('the offscreen supervisor does not cold-load operation-owned feature graphs', async () => {
    const { modulesSet } = await stats('offscreen');
    const forbidden = [
      'offscreen/actor-channel-host.js',
      'offscreen/actor-runner.js',
      'offscreen/job-runner.js',
      'offscreen/artifact-host.js',
      'offscreen/artifact-worker.js',
      'offscreen/toolbox-parse.js',
      'offscreen/local-model.js',
      'offscreen/pdf-extract.js',
      'offscreen/doc-extract.js',
      'offscreen/web-extract.js',
      'offscreen/web-extract-core.js',
      'offscreen/dweb-base.js',
      'peerd-engine/export.js',
      'peerd-engine/repository/repository-service.js',
      'vendor/isomorphic-git/index.js',
    ];
    for (const file of forbidden) {
      expect(modulesSet.has(file), `offscreen cold-loads ${file}`).toBe(false);
    }
  });

  test('the artifact supervisor is light and only its cancellable Worker reaches the codec', async () => {
    const hostGraph = await collectStaticModuleGraph(
      EXTENSION_DIR,
      join(EXTENSION_DIR, 'offscreen/artifact-host.js'),
    );
    const workerGraph = await collectStaticModuleGraph(
      EXTENSION_DIR,
      join(EXTENSION_DIR, 'offscreen/artifact-worker.js'),
    );
    const relativeSet = (graph: Set<string>) => new Set(
      [...graph].map((file) => relative(EXTENSION_DIR, file)),
    );
    expect(relativeSet(hostGraph).has('peerd-engine/export.js')).toBe(false);
    expect(relativeSet(workerGraph).has('peerd-engine/export.js')).toBe(true);
  });

  test('HTML boots through the measured shell entries and exposes a static visible status', () => {
    for (const [page, script] of [
      ['sidepanel/sidepanel.html', './boot.js'],
      ['home/home.html', './boot.js'],
    ]) {
      const source = readFileSync(join(EXTENSION_DIR, page), 'utf8');
      expect(source).toContain('class="boot-shell"');
      expect(source).toContain('Starting secure vault…');
      expect(source).toContain(`type="module" src="${script}"`);
    }
  });

  test('the cold vault shell validates authoritative legacy and kernel snapshots', () => {
    const shell = readFileSync(join(EXTENSION_DIR, 'sidepanel/vault-shell.js'), 'utf8');
    expect(shell).toContain('normalizeColdStateSnapshot(next)');
    expect(shell).toContain('coldStateIsCurrent(');
    expect(shell).toContain('snapshot, normalized, retiredAuthorityEpochs');
    expect(shell).not.toContain('hydrated: true');
  });

  test('packaged-page smoke requires an actionable vault gate, not a placeholder stage', () => {
    const probe = readFileSync(join(EXTENSION_DIR, '../scripts/cdp/check-packaged-pages.mjs'), 'utf8');
    expect(probe).toContain("peerdBootStage === 'vault-ready'");
    expect(probe).toContain(".gate-card button:not([disabled])");
    expect(probe).not.toContain('&& !!document.documentElement.dataset.peerdBootStage');
  });

  test('every fixed lazy module and worker asset is explicitly inventoried and resolves', async () => {
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/controller-worker.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/controller-runtime.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/controller-turn-runtime.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/semantic-route-host.js');
    for (const cluster of ['actors', 'contacts', 'toolbox'] as const) {
      expect(PACKAGED_LAZY_MODULE_ENTRIES)
        .toContain(`offscreen/semantic-routes/${cluster}.js`);
    }
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/artifact-host.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/repository-app-files.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/artifact-worker.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('background/repository-local-client.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('peerd-egress/ui.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES.filter((entry) =>
      entry === 'offscreen/artifact-host.js')).toHaveLength(1);
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/dweb-base.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('sidepanel/sidepanel.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('home/home.js');
    for (const entry of PACKAGED_LAZY_MODULE_ENTRIES) {
      const absolute = join(EXTENSION_DIR, entry);
      expect(existsSync(absolute), entry).toBe(true);
      expect((await collectStaticModuleGraph(EXTENSION_DIR, absolute)).size, entry)
        .toBeGreaterThan(0);
    }
    for (const entry of PACKAGED_LAZY_ASSET_ENTRIES) {
      expect(existsSync(join(EXTENSION_DIR, entry)), entry).toBe(true);
    }
  });
});
