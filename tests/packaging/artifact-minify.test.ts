import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertColdArtifactBudgets,
  COLD_GRAPH_BUDGETS,
  minifyColdArtifactModules,
} from '../../packaging/minify-artifact-js.ts';
import { staticImportSpecifiers } from '../../packaging/static-module-graph.ts';

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
    const report = await minifyColdArtifactModules(root, 'chrome');
    const swAfter = readFileSync(join(root, 'background/service-worker.js'), 'utf8');

    expect(report.graphs.serviceWorker.afterBytes).toBeLessThan(report.graphs.serviceWorker.beforeBytes);
    expect(report.graphs.offscreen?.afterBytes).toBeLessThan(report.graphs.offscreen!.beforeBytes);
    expect(report.transformedModules).toBeGreaterThan(2);
    expect(swAfter.length).toBeLessThan(swBefore.length);
    expect(swAfter).toContain('keepReadableName');
    expect(swAfter).not.toContain('removed from the staged artifact');
    expect(await staticImportSpecifiers(swAfter)).toEqual([
      './helper.js',
      '/vendor/library.js',
      '/shared/channel-config.js',
      '/shared/dweb-loader.js',
    ]);
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

    const report = await minifyColdArtifactModules(root, 'firefox');

    expect(report.graphs.offscreen).toBeUndefined();
    expect(readFileSync(join(root, 'offscreen/offscreen.js'), 'utf8')).toBe(offscreen);
  });

  test('parses one-line static imports without following dynamic imports', async () => {
    const source = 'import{x}from"./a.js";export{y}from"./b.js";const z=import("./lazy.js");';
    expect(await staticImportSpecifiers(source)).toEqual(['./a.js', './b.js']);
  });

  test('fails when an optimized cold graph exceeds its release budget', () => {
    const budget = COLD_GRAPH_BUDGETS.serviceWorker;
    expect(() => assertColdArtifactBudgets({
      transformedModules: 1,
      preservedModules: 0,
      beforeBytes: budget + 2,
      afterBytes: budget + 1,
      graphs: {
        serviceWorker: {
          entry: 'background/service-worker.js',
          modules: 1,
          beforeBytes: budget + 2,
          afterBytes: budget + 1,
        },
      },
    })).toThrow(/budget/);
  });
});
