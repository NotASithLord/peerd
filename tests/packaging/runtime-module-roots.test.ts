import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import {
  CONTROLLER_BUILD_ASSETS, CONTROLLER_BUILD_ENTRIES, CONTROLLER_OPTIONAL_BUILD_ENTRIES,
} from '../../packaging/controller-build-identity.ts';
import {
  PACKAGED_LAZY_MODULE_ENTRIES,
  PACKAGED_LAZY_ASSET_ENTRIES,
  PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES,
  PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES,
  PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES,
  packagedLazyModuleEntries,
  packagedUnavailableRuntimeModuleEdges,
} from '../../packaging/lazy-entry-manifest.ts';
import {
  assertPackagedRuntimeModuleRoots,
  fixedRuntimeModuleEdges,
  relativeRuntimeModuleTarget,
  uninventoriedRuntimeModuleEdges,
} from '../../packaging/runtime-module-roots.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const EXTENSION = join(process.cwd(), 'extension');
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixed runtime module roots', () => {
  test('parses literal dynamic imports and each explicit module Worker spelling', async () => {
    const source = [
      "import('./lazy.js');",
      "new Worker(new URL('./nested-worker.js', import.meta.url), { type: 'module' });",
      "new Worker(browser.runtime.getURL('offscreen/root-worker.js'), { type: 'module' });",
      "const options = { workerUrl: browser.runtime.getURL('offscreen/factory-worker.js') };",
      "new Worker('/classic.js');",
    ].join('\n');
    expect(await fixedRuntimeModuleEdges(source, 'fixture.js')).toEqual([
      { kind: 'dynamic-import', specifier: './lazy.js', rootRelative: false },
      { kind: 'module-worker', specifier: './nested-worker.js', rootRelative: false },
      { kind: 'module-worker', specifier: 'offscreen/root-worker.js', rootRelative: true },
      { kind: 'module-worker', specifier: 'offscreen/factory-worker.js', rootRelative: true },
    ]);
  });

  test('rejects a relative string module Worker URL', async () => {
    await expect(fixedRuntimeModuleEdges(
      "new Worker('./ambiguous.js', { type: 'module' });", 'fixture.js',
    )).rejects.toThrow('relative string module Worker URL is document-relative');
  });

  test('the source-wide inventory covers every authored fixed runtime edge', async () => {
    expect(await uninventoriedRuntimeModuleEdges(
      EXTENSION, PACKAGED_LAZY_MODULE_ENTRIES,
    )).toEqual([]);
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('vendor/tesseract/tesseract.esm.min.js');
    expect(readFileSync(join(EXTENSION, 'offscreen/pdf-extract.js'), 'utf8'))
      .toContain("import('/vendor/tesseract/tesseract.esm.min.js')");
  });

  test('the Notebook linker exposes its fixed Rollup root to packaging', async () => {
    const file = join(EXTENSION, 'peerd-engine/single-module-linker.js');
    const source = readFileSync(file, 'utf8');
    const edges = await fixedRuntimeModuleEdges(source, 'peerd-engine/single-module-linker.js');
    expect(edges).toContainEqual({
      kind: 'dynamic-import', specifier: '/vendor/rollup/rollup.browser.js',
      rootRelative: true,
    });
    expect(PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES)
      .toContain('vendor/rollup/rollup.browser.js');
    expect(source).not.toContain('import(rollupUrl)');
  });

  test('supported runtime-selected children are explicit package assets', () => {
    const requirements = [
      {
        selector: 'vendor/cheerpx/cx_esm.js',
        assets: [
          'vendor/cheerpx/cheerpOS.js',
          'vendor/cheerpx/cxbridge.js',
          'vendor/cheerpx/cxcore.js',
          'vendor/cheerpx/cxcore-no-return-call.js',
          'vendor/cheerpx/workerclock.js',
          'vendor/cheerpx/tun/direct.js',
          'vendor/cheerpx/tun/tailscale_tun_auto.js',
        ],
      },
      {
        selector: 'vendor/cheerpx/cxcore.js',
        assets: ['vendor/cheerpx/cxcore.wasm'],
      },
      {
        selector: 'vendor/cheerpx/cxcore-no-return-call.js',
        assets: ['vendor/cheerpx/cxcore-no-return-call.wasm'],
      },
      {
        selector: 'engine-tabs/app-tab/app-tab.js',
        assets: ['vendor/mithril/mithril.global.js'],
      },
      {
        selector: 'vendor/rollup/rollup.browser.js',
        assets: ['vendor/rollup/bindings_wasm_bg.wasm'],
      },
      {
        selector: 'vendor/transformers/transformers.js',
        assets: [
          'vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs',
          'vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm',
        ],
      },
      {
        selector: 'vendor/moonshine-js/moonshine.js',
        assets: [
          'vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
          'vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
          'vendor/vad-web/vad.worklet.bundle.min.js',
          'vendor/vad-web/silero_vad_legacy.onnx',
          'vendor/vad-web/silero_vad_v5.onnx',
        ],
      },
    ] as const;
    for (const { selector, assets } of requirements) {
      const source = readFileSync(join(EXTENSION, selector), 'utf8');
      for (const asset of assets) {
        expect(source, `${selector} selects ${asset}`).toContain(basename(asset));
        expect(PACKAGED_LAZY_ASSET_ENTRIES, asset).toContain(asset as any);
        expect(readFileSync(join(EXTENSION, asset)).byteLength, asset).toBeGreaterThan(0);
      }
    }
  });

  test('target-only engines and model data stay outside controller identity', () => {
    const identity = new Set<string>([
      ...CONTROLLER_BUILD_ENTRIES,
      ...CONTROLLER_OPTIONAL_BUILD_ENTRIES,
      ...CONTROLLER_BUILD_ASSETS,
    ]);
    for (const entry of [
      'vendor/cheerpx/cheerpOS.js',
      'vendor/cheerpx/cxbridge.js',
      'vendor/cheerpx/cxcore.js',
      'vendor/cheerpx/cxcore.wasm',
      'vendor/cheerpx/cxcore-no-return-call.js',
      'vendor/cheerpx/cxcore-no-return-call.wasm',
      'vendor/cheerpx/workerclock.js',
      'vendor/cheerpx/tun/direct.js',
      'vendor/cheerpx/tun/tailscale_tun_auto.js',
      'vendor/mithril/mithril.global.js',
      'vendor/rollup/bindings_wasm_bg.wasm',
      'vendor/vad-web/silero_vad_legacy.onnx',
      'vendor/vad-web/silero_vad_v5.onnx',
      'engine-tabs/pod-tab/pod-realm-seal.js',
    ]) {
      expect(PACKAGED_LAZY_ASSET_ENTRIES.includes(entry as any)
        || PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES.includes(entry as any), entry).toBe(true);
      expect(identity, entry).not.toContain(entry);
    }
  });

  test('generated sealed Worker imports are explicit package and identity roots', () => {
    const source = readFileSync(
      join(EXTENSION, 'engine-tabs/notebook-tab/worker-source.js'), 'utf8',
    );
    for (const entry of [
      'engine-tabs/notebook-tab/realm-seal.js',
      'engine-tabs/notebook-tab/notebook-std.js',
      'engine-tabs/notebook-tab/notebook-wasi.js',
    ]) {
      expect(source, entry).toContain(basename(entry));
      expect(PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES).toContain(entry as any);
      expect(CONTROLLER_BUILD_ENTRIES).toContain(entry as any);
    }
    const podSeal = 'engine-tabs/pod-tab/pod-realm-seal.js';
    expect(source, podSeal).toContain(basename(podSeal));
    expect(PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES).toContain(podSeal);
    expect(CONTROLLER_BUILD_ENTRIES).not.toContain(podSeal as any);
  });

  test('the sealed controller runtime import remains a scanner-visible fixed edge', async () => {
    const file = join(EXTENSION, 'offscreen/controller-worker.js');
    const source = readFileSync(file, 'utf8');
    expect(await fixedRuntimeModuleEdges(source, 'offscreen/controller-worker.js'))
      .toContainEqual({
        kind: 'dynamic-import', specifier: '/offscreen/controller-runtime.js',
        rootRelative: true,
      });
    expect(source).not.toContain('import(CONTROLLER_RUNTIME_URL)');
  });

  test('target selection is mandatory plus Preview and Preview-Chrome additions', () => {
    const storeChrome = packagedLazyModuleEntries(false, false);
    const storeFirefox = packagedLazyModuleEntries(false, false);
    const previewFirefox = packagedLazyModuleEntries(false, true);
    const previewChrome = packagedLazyModuleEntries(true, true);
    for (const target of [storeChrome, storeFirefox, previewFirefox, previewChrome]) {
      for (const entry of PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES) {
        expect(target).toContain(entry);
      }
    }
    for (const entry of PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES) {
      expect(storeChrome).not.toContain(entry);
      expect(storeFirefox).not.toContain(entry);
      expect(previewFirefox).toContain(entry);
      expect(previewChrome).toContain(entry);
    }
    for (const entry of PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES) {
      expect(storeChrome).not.toContain(entry);
      expect(storeFirefox).not.toContain(entry);
      expect(previewFirefox).not.toContain(entry);
      expect(previewChrome).toContain(entry);
    }
    expect(packagedUnavailableRuntimeModuleEdges('store', 'chrome')).toEqual([
      {
        from: 'home/home.js', kind: 'dynamic-import', target: 'home/eval-section.js',
        targetCell: 'store/chrome',
      },
      {
        from: 'offscreen/offscreen.js', kind: 'dynamic-import',
        target: 'offscreen/contributor-channel-addon.js', targetCell: 'store/chrome',
      },
      {
        from: 'offscreen/offscreen.js', kind: 'dynamic-import',
        target: 'offscreen/dweb-base.js', targetCell: 'store/chrome',
      },
    ]);
  });

  test('an unavailable edge exemption never transfers to a second caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-runtime-exemption-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, 'home'), { recursive: true });
    writeFileSync(join(root, 'home/home.js'), "import('./eval-section.js');\n");
    writeFileSync(join(root, 'home/second.js'), "import('./eval-section.js');\n");
    const exception = [{
      from: 'home/home.js', kind: 'dynamic-import' as const,
      target: 'home/eval-section.js', targetCell: 'store/chrome',
    }];
    expect(await uninventoriedRuntimeModuleEdges(root, [], exception)).toEqual([{
      from: 'home/second.js', kind: 'dynamic-import', target: 'home/eval-section.js',
    }]);
  });

  test('a target-specific runtime root cannot be omitted or point at a missing graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-runtime-root-'));
    temporaryRoots.push(root);
    mkdirSync(join(root, 'offscreen'), { recursive: true });
    writeFileSync(join(root, 'offscreen/source.js'), "import('./preview-only.js');\n");
    expect(await uninventoriedRuntimeModuleEdges(root, [])).toEqual([{
      from: 'offscreen/source.js', kind: 'dynamic-import', target: 'offscreen/preview-only.js',
    }]);
    await expect(assertPackagedRuntimeModuleRoots(
      root, ['offscreen/preview-only.js'],
    )).rejects.toThrow('static module missing from artifact: offscreen/preview-only.js');
    writeFileSync(join(root, 'offscreen/preview-only.js'), 'export {};\n');
    await expect(assertPackagedRuntimeModuleRoots(
      root, ['offscreen/preview-only.js'],
    )).resolves.toBeUndefined();
  });

  test('controller identity has a fixed point over authored runtime roots', async () => {
    const bound = new Set<string>([
      ...CONTROLLER_BUILD_ENTRIES, ...CONTROLLER_OPTIONAL_BUILD_ENTRIES,
    ]);
    const queue = [...bound];
    const scannedFiles = new Set<string>();
    const unbound: Array<{ from: string; target: string }> = [];
    while (queue.length > 0) {
      const entry = queue.shift() as string;
      const graph = await collectStaticModuleGraph(EXTENSION, join(EXTENSION, entry));
      for (const file of graph) {
        const from = relative(EXTENSION, file).split('\\').join('/');
        if (scannedFiles.has(from) || from.startsWith('vendor/')
            || !['.js', '.mjs'].includes(extname(file))) continue;
        scannedFiles.add(from);
        for (const edge of await fixedRuntimeModuleEdges(readFileSync(file, 'utf8'), from)) {
          const target = relativeRuntimeModuleTarget(edge, file, EXTENSION);
          if (!bound.has(target)) unbound.push({ from, target });
        }
      }
    }
    expect(unbound).toEqual([]);
  });
});
