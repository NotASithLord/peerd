import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import {
  CONTROLLER_BUILD_ENTRIES, CONTROLLER_OPTIONAL_BUILD_ENTRIES,
} from '../../packaging/controller-build-identity.ts';
import {
  PACKAGED_LAZY_MODULE_ENTRIES,
  PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES,
  PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES,
  PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES,
  packagedLazyModuleEntries,
  packagedUnavailableRuntimeModuleEntries,
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

  test('the source-wide inventory covers every authored fixed runtime edge', async () => {
    expect(await uninventoriedRuntimeModuleEdges(
      EXTENSION, PACKAGED_LAZY_MODULE_ENTRIES,
    )).toEqual([]);
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('vendor/tesseract/tesseract.esm.min.js');
    expect(readFileSync(join(EXTENSION, 'offscreen/pdf-extract.js'), 'utf8'))
      .toContain("import('/vendor/tesseract/tesseract.esm.min.js')");
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
    expect(packagedUnavailableRuntimeModuleEntries(false, false))
      .toEqual([
        'home/eval-section.js', 'offscreen/contributor-channel-addon.js',
        'offscreen/dweb-base.js',
      ]);
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
