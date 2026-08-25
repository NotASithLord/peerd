import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertColdArtifactBudgets,
  COLD_GRAPH_BUDGETS,
  minifyColdArtifactModules,
} from '../../packaging/minify-artifact-js.ts';
import { COLD_START_TARGETS } from '../../scripts/bench/cold-start-budgets.js';
import {
  exportedNames,
  moduleImportSpecifiers,
  staticImportSpecifiers,
} from '../../packaging/static-module-graph.ts';

const temporaryRoots: string[] = [];
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'peerd-artifact-minify-'));
  temporaryRoots.push(root);
  return root;
};

const write = (root: string, rel: string, source: string): void => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
};

describe('release artifact JavaScript minification', () => {
  test('shrinks authored cold modules while retaining graph, names, lazy code, vendor, and policy bytes', async () => {
    const root = makeRoot();
    write(root, 'manifest.json', JSON.stringify({
      background: { service_worker: 'background/service-worker.js', type: 'module' },
    }));
    write(root, 'background/service-worker.js', `
      // removed from the staged artifact
      import { helperValue } from './helper.js';
      import { vendorValue } from '/vendor/library.js';
      import { CHANNEL } from '/shared/channel-config.js';
      import { loadDweb } from '/shared/dweb-loader.js';
      export async function keepReadableName(value) {
        const lazy = await import('./lazy.js');
        return value + helperValue + vendorValue + lazy.lazyValue + CHANNEL.length + typeof loadDweb;
      }
    `);
    write(root, 'background/helper.js', `
      // authored dependency comment
      export const helperValue = 2;
    `);
    const lazySource = '// lazy module stays readable\nexport const lazyValue = 5;\n';
    write(root, 'background/lazy.js', lazySource);
    const vendorSource = '// audited vendor bytes\nexport const vendorValue = 3;\n';
    write(root, 'vendor/library.js', vendorSource);
    const channelSource = '// generated policy bytes\nexport const CHANNEL = "preview";\n';
    write(root, 'shared/channel-config.js', channelSource);
    const loaderSource = '// committed swap bytes\nexport const loadDweb = () => import("/missing-lazy.js");\n';
    write(root, 'shared/dweb-loader.js', loaderSource);
    write(root, 'offscreen/offscreen.js', `
      // offscreen entry comment
      import { offscreenValue } from './support.js';
      globalThis.offscreenValue = offscreenValue;
    `);
    write(root, 'offscreen/support.js', 'export const offscreenValue = 9;\n');

    const swBefore = readFileSync(join(root, 'background/service-worker.js'), 'utf8');
    const report = await minifyColdArtifactModules(root, 'chrome', 'store');
    const swAfter = readFileSync(join(root, 'background/service-worker.js'), 'utf8');

    expect(report.graphs.serviceWorker.afterBytes).toBeLessThan(report.graphs.serviceWorker.beforeBytes);
    expect(report.graphs.offscreen?.afterBytes).toBeLessThan(report.graphs.offscreen!.beforeBytes);
    expect(report.transformedModules).toBeGreaterThan(0);
    expect(swAfter.length).toBeLessThan(swBefore.length);
    expect(swAfter).toContain('keepReadableName');
    expect(swAfter).not.toContain('removed from the staged artifact');
    expect(await staticImportSpecifiers(swAfter)).toEqual([
      './helper.js',
      '/vendor/library.js',
      '/shared/channel-config.js',
      '/shared/dweb-loader.js',
    ]);
    expect(await moduleImportSpecifiers(swAfter)).toContainEqual({
      kind: 'dynamic', specifier: './lazy.js',
    });
    expect(await exportedNames(swAfter)).toEqual(['keepReadableName']);
    expect(readFileSync(join(root, 'background/lazy.js'), 'utf8')).toBe(lazySource);
    expect(readFileSync(join(root, 'vendor/library.js'), 'utf8')).toBe(vendorSource);
    expect(readFileSync(join(root, 'shared/channel-config.js'), 'utf8')).toBe(channelSource);
    expect(readFileSync(join(root, 'shared/dweb-loader.js'), 'utf8')).toBe(loaderSource);
  });

  test('does not seed Chrome offscreen code into a Firefox package', async () => {
    const root = makeRoot();
    write(root, 'manifest.json', JSON.stringify({
      background: { scripts: ['background/service-worker.js'], type: 'module' },
    }));
    write(root, 'background/service-worker.js', '// shrink me\nexport const workerName = "worker";\n');
    const offscreen = '// Firefox does not load this host\nexport const untouched = true;\n';
    write(root, 'offscreen/offscreen.js', offscreen);

    const report = await minifyColdArtifactModules(root, 'firefox', 'store');

    expect(report.graphs.offscreen).toBeUndefined();
    expect(readFileSync(join(root, 'offscreen/offscreen.js'), 'utf8')).toBe(offscreen);
  });

  test('keeps exported names and runtime behavior', async () => {
    const root = makeRoot();
    write(root, 'manifest.json', JSON.stringify({
      background: { service_worker: 'background/service-worker.js', type: 'module' },
    }));
    write(root, 'background/service-worker.js', `
      import { increment, NamedFailure } from './support.js';
      export { NamedFailure } from './support.js';
      export const run = (value) => ({ value: increment(value), name: NamedFailure.name });
    `);
    write(root, 'background/support.js', `
      export class NamedFailure extends Error {}
      export const increment = (value) => value + 1;
    `);

    await minifyColdArtifactModules(root, 'firefox', 'store');
    const module = await import(`${pathToFileURL(join(
      root, 'background', 'service-worker.js',
    )).href}?${crypto.randomUUID()}`);
    expect(module.run(4)).toEqual({ value: 5, name: 'NamedFailure' });
    expect(module.NamedFailure.name).toBe('NamedFailure');
  });

  test('parses one-line static imports without following dynamic imports', async () => {
    const source = 'import{x}from"./a.js";export{y}from"./b.js";const z=import("./lazy.js");';
    expect(await staticImportSpecifiers(source)).toEqual(['./a.js', './b.js']);
  });

  test('fails when an optimized cold graph exceeds its release budget', () => {
    const budget = COLD_GRAPH_BUDGETS.store.chrome.serviceWorker.graphBytes;
    expect(() => assertColdArtifactBudgets({
      browser: 'chrome',
      channel: 'store',
      transformedModules: 1,
      preservedModules: 0,
      beforeBytes: budget + 2,
      afterBytes: budget + 1,
      graphs: {
        serviceWorker: {
          entry: 'background/service-worker.js',
          entryBytes: 1,
          modules: 1,
          beforeBytes: budget + 2,
          afterBytes: budget + 1,
        },
      },
    })).toThrow(/budget/);
  });

  test('fails before browser launch when module or exact entry ratchets grow', () => {
    const budget = COLD_GRAPH_BUDGETS.store.chrome.serviceWorker;
    const report = {
      browser: 'chrome' as const,
      channel: 'store' as const,
      transformedModules: 1,
      preservedModules: 0,
      beforeBytes: budget.graphBytes,
      afterBytes: budget.graphBytes - 1,
      graphs: {
        serviceWorker: {
          entry: 'background/service-worker.js',
          entryBytes: budget.entryBytes + 1,
          modules: Number(budget.modules),
          beforeBytes: budget.graphBytes,
          afterBytes: budget.graphBytes - 1,
        },
      },
    };
    expect(() => assertColdArtifactBudgets(report)).toThrow(/cold entry/);
    report.graphs.serviceWorker.entryBytes = budget.entryBytes;
    report.graphs.serviceWorker.modules = budget.modules + 1;
    expect(() => assertColdArtifactBudgets(report)).toThrow(/modules/);
  });

  test('an exact native entry can use the final target without weakening legacy ratchets', () => {
    const report = {
      browser: 'chrome' as const,
      channel: 'store' as const,
      transformedModules: 73,
      preservedModules: 0,
      beforeBytes: 500_000,
      afterBytes: 340_000,
      graphs: {
        serviceWorker: {
          entry: 'background/vault-kernel.js', entryBytes: 25_000,
          modules: 73, beforeBytes: 447_000, afterBytes: 287_000,
        },
        offscreen: {
          entry: 'offscreen/offscreen.js', entryBytes: 15_000,
          modules: 12, beforeBytes: 84_000, afterBytes: 53_000,
        },
      },
    };
    expect(() => assertColdArtifactBudgets(report)).toThrow();
    expect(() => assertColdArtifactBudgets(report, COLD_START_TARGETS.chrome)).not.toThrow();
  });
});
