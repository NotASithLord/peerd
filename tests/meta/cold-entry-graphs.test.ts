import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  collectStaticModuleGraph,
  staticImportSpecifiers,
} from '../../packaging/static-module-graph.ts';
import {
  PACKAGED_LAZY_ASSET_ENTRIES,
  PACKAGED_LAZY_MODULE_ENTRIES,
} from '../../packaging/lazy-entry-manifest.ts';
import { SEMANTIC_HOST_CLUSTER_ENTRIES } from '../../packaging/semantic-host-entries.ts';
import {
  COLD_SOURCE_TARGETS,
  FIREFOX_KERNEL_SOURCE_CONTRACT,
  PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT,
  COLD_SOURCE_RATCHETS,
  OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT,
  PREVIEW_KERNEL_SOURCE_CONTRACT,
} from '../../scripts/bench/cold-start-policy.mjs';

const entries = {
  sidepanel: 'sidepanel/boot.js',
  home: 'home/boot.js',
  options: 'options/options.js',
  offscreen: 'offscreen/offscreen.js',
} as const;

const richUiEntries = {
  sidepanel: 'sidepanel/sidepanel.js',
  home: 'home/home.js',
} as const;

// Exact pre-Options-boundary graphs. The shared ui.js surfaces are first-paint
// contracts; Settings-only features must never widen either rich document.
const RICH_UI_GRAPH_CEILINGS = {
  sidepanel: { modules: 61, graphBytes: 670_963 },
  home: { modules: 68, graphBytes: 847_827 },
} as const;

const nativeKernelEntry = 'background/vault-kernel-chrome.js';
const previewKernelEntry = 'background/vault-kernel-preview.js';

// The prior exact ratchet remains a diagnostic baseline. These are the only
// cold inputs whose sizes changed since it: the authority hosts gained
// terminal outcome/audit and engine-loss custody, policy gained the Plan-safe
// page-program subset, quota gained its matching bound, a2a shed a stale
// prompt grant, the final dead-surface cleanup narrowed the authority graph,
// and credentialed repository egress regained its private-host guard.
// Computing from prior input sizes makes an unrelated offsetting edit fail too.
const KERNEL_SOURCE_DELTA_ACCOUNTING = Object.freeze({
  baselineGraphBytes: 4_035_518,
  priorInputBytes: Object.freeze({
    'background/controller-turn-bridge.js': 145_646,
    'background/execution-tool-authority.js': 19_738,
    'background/kernel-demand-plane.js': 18_505,
    'background/kernel-turn-authority-adapter.js': 170_225,
    'background/offscreen-actor-client.js': 162_659,
    'background/vault-kernel-core.js': 20_087,
    'background/vault-kernel.js': 45_777,
    'peerd-egress/fetch/origin-credentials.js': 8_776,
    'peerd-runtime/actor/a2a-api.js': 8_997,
    'peerd-runtime/browser-authority/dom-helpers.js': 18_857,
    'peerd-runtime/contacts/aggregate.js': 5_310,
    'peerd-runtime/contacts/contact.js': 4_498,
    'peerd-runtime/errors.js': 2_561,
    'peerd-runtime/kernel-turn-authority.js': 3_002,
    'peerd-runtime/lifecycle/engine-liveness.js': 3_997,
    'peerd-runtime/permissions/policy.js': 14_942,
    'peerd-runtime/skills/registry.js': 8_780,
    'peerd-runtime/tools/prompt-wrap.js': 5_778,
    'shared/controller-kernel-quota.js': 31_640,
    'shared/kernel-feature-policy.js': 28_696,
    'shared/kernel-feature-route-inventory.js': 4_180,
    'shared/util.js': 4_904,
  }),
});

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

const richUiStats = async (name: keyof typeof richUiEntries) => {
  const entry = join(EXTENSION_DIR, richUiEntries[name]);
  const graph = await collectStaticModuleGraph(EXTENSION_DIR, entry);
  return {
    modules: graph.size,
    graphBytes: [...graph].reduce((total, file) => total + statSync(file).size, 0),
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
  test('Options links only document UI policy, never universal or execution owners', async () => {
    const measured = await stats('options');
    const modules = [...measured.modulesSet];
    const forbidden = modules.filter((module) =>
      [
        'peerd-runtime/index.js',
        'peerd-provider/index.js',
        'peerd-egress/index.js',
        'peerd-engine/index.js',
        'peerd-runtime/loop/agent-loop.js',
        'peerd-runtime/tools/metadata/catalog.js',
        'peerd-egress/vault/vault.js',
        'peerd-egress/vault/argon2.js',
        'peerd-engine/editor.js',
        'peerd-engine/repository/repository-service.js',
        'peerd-runtime/transfer/transfer.js',
        'peerd-runtime/observability/contributor-metrics.js',
        'peerd-runtime/observability/contributor-store.js',
        'peerd-engine/export.js',
        'shared/backup-passphrase.js',
        'shared/argon2id.js',
        'vendor/codemirror/cm.js',
        'vendor/acorn/acorn.mjs',
      ].includes(module)
      || module.startsWith('peerd-runtime/controller')
      || module.startsWith('peerd-provider/adapters/')
      || module.startsWith('peerd-egress/storage/')
      || module.startsWith('peerd-egress/fetch/')
      || module.startsWith('shared/bundle/')
      || module.startsWith('vendor/argon2/'));
    expect(forbidden, 'Options acquired execution or authority modules').toEqual([]);
  });

  test('Options-only surfaces do not widen Sidepanel or Home rich graphs', async () => {
    for (const name of ['sidepanel', 'home'] as const) {
      const measured = await richUiStats(name);
      const ceiling = RICH_UI_GRAPH_CEILINGS[name];
      expect(measured.modules, `${name} rich modules`).toBeLessThanOrEqual(ceiling.modules);
      expect(measured.graphBytes, `${name} rich graph bytes`)
        .toBeLessThanOrEqual(ceiling.graphBytes);
      expect(measured.modulesSet.has('peerd-provider/options.js')).toBe(false);
      expect(measured.modulesSet.has('peerd-runtime/options.js')).toBe(false);
    }
  });

  test('every cold graph stays at or below its achieved no-growth ratchet', async () => {
    const kernel = await nativeKernelStats();
    const accountedGraphBytes = KERNEL_SOURCE_DELTA_ACCOUNTING.baselineGraphBytes
      + Object.entries(KERNEL_SOURCE_DELTA_ACCOUNTING.priorInputBytes)
        .reduce((delta, [file, priorBytes]) =>
          delta + statSync(join(EXTENSION_DIR, file)).size - priorBytes, 0);
    expect(kernel.graphBytes, 'kernel graph delta has an unaccounted input')
      .toBe(accountedGraphBytes);
    expect(kernel.modules, 'kernel modules')
      .toBeLessThanOrEqual(COLD_SOURCE_RATCHETS.kernel.modules);
    expect(kernel.graphBytes, 'kernel graph bytes')
      .toBeLessThanOrEqual(COLD_SOURCE_RATCHETS.kernel.graphBytes);
    expect(kernel.entryBytes, 'kernel entry bytes')
      .toBeLessThanOrEqual(COLD_SOURCE_RATCHETS.kernel.entryBytes);
    expect(kernel.directImports, 'kernel direct imports')
      .toBeLessThanOrEqual(COLD_SOURCE_RATCHETS.kernel.directImports);
    for (const name of ['sidepanel', 'home'] as const) {
      const measured = await stats(name);
      const ratchet = COLD_SOURCE_RATCHETS[name];
      expect(measured.modules, `${name} modules`).toBeLessThanOrEqual(ratchet.modules);
      expect(measured.graphBytes, `${name} graph bytes`).toBeLessThanOrEqual(ratchet.graphBytes);
      expect(measured.entryBytes, `${name} entry bytes`).toBeLessThanOrEqual(ratchet.entryBytes);
      expect(measured.directImports, `${name} direct imports`).toBeLessThanOrEqual(ratchet.directImports);
    }
  });

  test('the offscreen supervisor preserves its proven deletion and architectural ceiling', async () => {
    const measured = await stats('offscreen');
    const { baseline, minimumReduction } = OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT;
    expect(baseline.modules - measured.modules)
      .toBeGreaterThanOrEqual(minimumReduction.modules);
    expect(baseline.graphBytes - measured.graphBytes)
      .toBeGreaterThanOrEqual(minimumReduction.graphBytes);
    expect(measured.entryBytes).toBeLessThanOrEqual(baseline.entryBytes);
    expect(measured.directImports)
      .toBeLessThanOrEqual(OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT.directImportsCeiling);
    expect(measured.modules).toBeLessThanOrEqual(COLD_SOURCE_TARGETS.offscreen.modules);
    expect(measured.graphBytes).toBeLessThanOrEqual(COLD_SOURCE_TARGETS.offscreen.graphBytes);
    expect(measured.entryBytes).toBeLessThanOrEqual(COLD_SOURCE_TARGETS.offscreen.entryBytes);
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

  test('the honest native closure excludes growing controller owners and Firefox-only hosts', async () => {
    const measured = await nativeKernelStats();
    expect(existsSync(join(EXTENSION_DIR, 'background/kernel-control-plane.js'))).toBe(false);
    for (const forbidden of [
      'background/kernel-control-plane.js',
      'offscreen/controller-runtime.js',
      'offscreen/controller-turn-runtime.js',
      'offscreen/semantic-route-host.js',
      'offscreen/artifact-host.js',
      'offscreen/artifact-worker.js',
      'peerd-engine/repository/repository-service.js',
      'vendor/isomorphic-git/index.js',
      'background/direct-actor-host.js',
      'offscreen/actor-runner.js',
      'peerd-runtime/controller-tool-projection.js',
      'peerd-runtime/controller-actor-tools.js',
      'peerd-runtime/controller-schedule-tools.js',
      'peerd-provider/adapters/anthropic.js',
    ]) {
      expect(measured.modulesSet.has(forbidden), `native kernel imports ${forbidden}`).toBe(false);
    }
    // Firefox storage-heartbeat ownership remains a true background-page
    // first-demand branch. Chrome repository custody is part of the fixed
    // authority shell and therefore belongs in the honest static closure.
    expect(measured.modulesSet.has('background/firefox-storage-keepalive.js')).toBe(false);
    expect(measured.modulesSet.has('background/vault-authority-client.js')).toBe(true);
    expect(measured.modulesSet.has('shared/cold-util.js')).toBe(true);
    expect(measured.modulesSet.has('shared/util.js')).toBe(true);
    expect(measured.modulesSet.has('background/kernel-semantic-demand.js')).toBe(false);
    expect(measured.modulesSet.has('background/semantic-demand-client.js')).toBe(false);
    // Contacts and semantic-demand policy remain finite storage/route custody,
    // while their controller-owned tool semantics stay outside this graph.
    expect(measured.modulesSet.has('background/routes/contacts.js')).toBe(true);
    expect(measured.modulesSet.has('shared/semantic-demand-policy.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-engine/app-manifest.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/semantic.js')).toBe(false);
    expect(measured.modulesSet.has('peerd-runtime/contacts/aggregate.js')).toBe(true);
  });

  test('demand runtimes do not inherit the composer policy family', async () => {
    for (const entry of [
      'background/kernel-semantic-runtime.js',
      'background/kernel-administrative-control.js',
      'background/kernel-executable-runtime.js',
      'background/kernel-executable-live.js',
      'background/kernel-executable-transfer-live.js',
      'background/kernel-dweb-route-runtime.js',
      'background/kernel-browser-network-authority.js',
    ]) {
      const measured = await nativeKernelStats(entry);
      for (const forbidden of [
        'background/kernel-composer-routes.js',
        'background/kernel-denylist-policy.js',
        'background/kernel-app-file-reader.js',
      ]) expect(measured.modulesSet.has(forbidden), `${entry} imports ${forbidden}`).toBe(false);
    }
  });

  test('the full Preview worker never hosts the distributed implementation', async () => {
    const measured = await nativeKernelStats(previewKernelEntry);
    expect(measured.modulesSet.has('shared/dweb-loader.js')).toBe(false);
    expect([...measured.modulesSet].some((file) => file.startsWith('peerd-distributed/')))
      .toBe(false);
  });

  test('Firefox never carries the unavailable custody host', async () => {
    const measured = await nativeKernelStats('background/vault-kernel-firefox.js');
    expect(measured.modules).toBeLessThanOrEqual(FIREFOX_KERNEL_SOURCE_CONTRACT.modules);
    expect(measured.graphBytes).toBeLessThanOrEqual(FIREFOX_KERNEL_SOURCE_CONTRACT.graphBytes);
    expect(measured.entryBytes).toBeLessThanOrEqual(FIREFOX_KERNEL_SOURCE_CONTRACT.entryBytes);
    expect(measured.directImports)
      .toBeLessThanOrEqual(FIREFOX_KERNEL_SOURCE_CONTRACT.directImports);
    for (const file of [
      'background/kernel-preview-addon.js',
      'background/kernel-dweb-route-runtime.js',
      'shared/dweb-loader.js',
    ]) expect(measured.modulesSet.has(file), `Firefox imports ${file}`).toBe(false);
  });

  test('Preview Firefox adds only the contributor registration shell', async () => {
    const measured = await nativeKernelStats('background/vault-kernel-firefox-preview.js');
    expect(measured.modules)
      .toBeLessThanOrEqual(PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT.modules);
    expect(measured.graphBytes)
      .toBeLessThanOrEqual(PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT.graphBytes);
    expect(measured.entryBytes)
      .toBeLessThanOrEqual(PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT.entryBytes);
    expect(measured.directImports)
      .toBeLessThanOrEqual(PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT.directImports);
    expect(measured.modulesSet.has('background/kernel-firefox-contributor-addon.js'))
      .toBe(true);
    expect(measured.modulesSet.has('background/vault-kernel-firefox.js')).toBe(true);
    expect(measured.modulesSet.has('background/kernel-firefox-runtime-modules.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/observability/contributor-metrics.js'))
      .toBe(false);
  });

  test('browser network custody is static and reaches exact kernel surfaces', async () => {
    const measured = await nativeKernelStats();
    expect(PACKAGED_LAZY_MODULE_ENTRIES)
      .not.toContain('background/kernel-browser-network-runtime.js');
    expect(measured.modulesSet.has('background/kernel-browser-network-runtime.js')).toBe(false);
    expect(measured.modulesSet.has('background/kernel-browser-network-authority.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-egress/kernel-network.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/kernel-network.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-egress/denylist/dnr-rules.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/tools/browser-automation-policy.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-runtime/actor/idp-registry.js')).toBe(true);
    expect(measured.modulesSet.has('peerd-egress/background.js')).toBe(true);
  });

  test('Preview Chrome alone owns the downloaded-update graph', async () => {
    const common = await nativeKernelStats();
    const preview = await nativeKernelStats(previewKernelEntry);
    const exclusive = [...preview.modulesSet]
      .filter((file) => !common.modulesSet.has(file)).sort();
    const storeExclusive = [...common.modulesSet]
      .filter((file) => !preview.modulesSet.has(file)).sort();
    const exclusiveBytes = exclusive.reduce((total, file) =>
      total + statSync(join(EXTENSION_DIR, file)).size, 0);
    expect(common.modules).toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.shared.modules);
    expect(common.graphBytes)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.shared.graphBytes);
    expect(preview.modules).toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.target.modules);
    expect(preview.graphBytes)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.target.graphBytes);
    expect(exclusive.length)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.exclusive.modules);
    expect(exclusiveBytes)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.exclusive.graphBytes);
    expect(preview.entryBytes)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.entryBytesCeiling);
    expect(preview.directImports)
      .toBeLessThanOrEqual(PREVIEW_KERNEL_SOURCE_CONTRACT.directImportsCeiling);
    expect(preview.modules).toBe(common.modules - storeExclusive.length + exclusive.length);
    const storeExclusiveBytes = storeExclusive.reduce((total, file) =>
      total + statSync(join(EXTENSION_DIR, file)).size, 0);
    expect(preview.graphBytes)
      .toBe(common.graphBytes - storeExclusiveBytes + exclusiveBytes);
    expect(storeExclusive).toEqual(['background/vault-kernel-chrome.js']);
    expect(exclusive).toEqual([
      'background/kernel-contributor-owner.js',
      'background/kernel-preview-addon.js',
      'background/vault-kernel-preview.js',
      'shared/contributor-channel.js',
    ]);
    expect(common.modulesSet.has('background/kernel-preview-addon.js')).toBe(false);
    const source = readFileSync(join(EXTENSION_DIR, previewKernelEntry), 'utf8');
    expect(source.indexOf("import './kernel-preview-addon.js'"))
      .toBeLessThan(source.indexOf("from './vault-kernel.js'"));
  });

  test('the native Chrome authority entry has no reachable runtime module import', async () => {
    const measured = await nativeKernelStats();
    await init;
    const offenders = [];
    for (const relativePath of measured.modulesSet) {
      const source = readFileSync(join(EXTENSION_DIR, relativePath), 'utf8');
      const [imports] = parse(source);
      if (imports.some((entry) => entry.d >= 0)) offenders.push(relativePath);
    }
    // Target-specific direct Workers stay behind exact Firefox-only branches.
    // The Chrome semantic path is a static private-channel client; it contains
    // no runtime import expression of its own.
    expect(offenders.sort()).toEqual([]);
    expect(readFileSync(join(EXTENSION_DIR, 'background/vault-kernel.js'), 'utf8'))
      .not.toContain('createKernelSemanticDemand');
    const kernelSource = readFileSync(join(EXTENSION_DIR, 'background/vault-kernel.js'), 'utf8');
    expect(kernelSource).toContain('const createKernelDemandPlane = await runtimeModules.demandPlane();');
    expect(measured.modulesSet.has('background/kernel-chrome-runtime-modules.js')).toBe(true);
    expect(measured.modulesSet.has('background/kernel-demand-plane.js')).toBe(true);
    expect(measured.modulesSet.has('background/kernel-turn-authority-adapter.js')).toBe(true);
    expect(kernelSource).not.toContain('createDeferredRepositoryClient');
    expect(measured.modulesSet.has('background/kernel-demand-support.js')).toBe(true);
    expect(readFileSync(
      join(EXTENSION_DIR, 'background/kernel-demand-support.js'), 'utf8',
    )).toContain('createDeferredRepositoryClient(async () => {');
    expect(kernelSource).not.toContain("import('./firefox-storage-keepalive.js')");
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

  test('the offscreen supervisor does not cold-load operation-owned feature graphs', async () => {
    const { modulesSet } = await stats('offscreen');
    const forbidden = [
      'offscreen/actor-channel-host.js',
      'offscreen/actor-runner.js',
      'offscreen/job-runner.js',
      'offscreen/artifact-host.js',
      'offscreen/artifact-worker.js',
      'offscreen/document-conversion-host.js',
      'offscreen/document-conversion-worker.js',
      'offscreen/local-model.js',
      'offscreen/pdf-extract.js',
      'offscreen/doc-extract.js',
      'offscreen/web-extract.js',
      'offscreen/web-extract-core.js',
      'offscreen/dweb-base.js',
      'shared/repository-channel.js',
      'shared/cold-util.js',
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

  test('the document supervisor is light and only its disposable Worker reaches conversion', async () => {
    const hostGraph = await collectStaticModuleGraph(
      EXTENSION_DIR,
      join(EXTENSION_DIR, 'offscreen/document-conversion-host.js'),
    );
    const workerGraph = await collectStaticModuleGraph(
      EXTENSION_DIR,
      join(EXTENSION_DIR, 'offscreen/document-conversion-worker.js'),
    );
    const relativeSet = (graph: Set<string>) => new Set(
      [...graph].map((file) => relative(EXTENSION_DIR, file)),
    );
    expect(relativeSet(hostGraph).has('peerd-runtime/doc/convert.js')).toBe(false);
    expect(relativeSet(workerGraph).has('peerd-runtime/offscreen.js')).toBe(false);
    expect(relativeSet(workerGraph).has('peerd-runtime/tools/metadata/catalog.js')).toBe(false);
    expect(relativeSet(workerGraph).has('peerd-runtime/doc/convert.js')).toBe(true);
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

  test('the cold vault shell validates authoritative kernel snapshots', () => {
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
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/kernel-runtime-host.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/controller-turn-runtime.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/semantic-route-host.js');
    for (const entry of SEMANTIC_HOST_CLUSTER_ENTRIES) {
      expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain(entry);
    }
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/artifact-host.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/repository-app-files.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/artifact-worker.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('peerd-engine/artifact.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/document-conversion-worker.js');
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
