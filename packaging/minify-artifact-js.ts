// Release-artifact-only JavaScript optimization. Modules stay separate and
// imports stay exact; lazy, vendor, and generated policy bytes stay untouched.

import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Browser, Channel } from './lib.ts';
import {
  collectStaticModuleGraph,
  exportedNames,
  moduleImportSpecifiers,
} from './static-module-graph.ts';
import { dwebEnabledForTarget } from './gen-channel-config.ts';
import { PACKAGE_COLD_GRAPH_RATCHETS } from '../scripts/bench/cold-start-budgets.js';

export interface ColdGraphStats {
  entry: string;
  entryBytes: number;
  modules: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface ArtifactMinifyReport {
  browser: Browser;
  channel: Channel;
  transformedModules: number;
  preservedModules: number;
  beforeBytes: number;
  afterBytes: number;
  graphs: {
    serviceWorker: ColdGraphStats;
    offscreen?: ColdGraphStats;
  };
}

export type ColdGraphBudgets = Partial<Record<'serviceWorker' | 'offscreen', Readonly<{
  modules: number;
  graphBytes: number;
  entryBytes: number;
}>>>;

// These are artifact byte budgets for the complete static graphs, including
// byte-identical vendor modules. Values come from the executable cold-start
// policy; packaging cannot maintain a looser shadow budget.
// Transitional no-growth fences from the v0.7.3 artifacts. The thin kernel
// cutover replaces these with the target ceilings. Every channel/browser cell
// gets its own exact fence so Preview cannot borrow Store headroom or vice versa.
export const COLD_GRAPH_BUDGETS = PACKAGE_COLD_GRAPH_RATCHETS;

const PRESERVE_EXACT = new Set([
  'shared/channel-config.js',
  'shared/dweb-loader.js',
]);
const DWEB_DISABLED_PRESERVE_EXACT = new Set([
  'background/routes/dweb.js',
  'background/routes/dweb-self.js',
]);
const STORE_PRESERVE_EXACT = new Set([
  'offscreen/actor-worker.js',
  'offscreen/semantic-route-host.js',
  'options/components/options-app.js',
]);

const byteLength = (source: string): number => Buffer.byteLength(source, 'utf8');

const shouldTransform = (
  staging: string,
  file: string,
  browser: Browser,
  channel: Channel,
): boolean => {
  const rel = relative(staging, file).split('\\').join('/');
  return ['.js', '.mjs'].includes(extname(file))
    && !rel.startsWith('vendor/')
    && !PRESERVE_EXACT.has(rel)
    && (channel !== 'store' || !STORE_PRESERVE_EXACT.has(rel))
    && (dwebEnabledForTarget(channel, browser) || !DWEB_DISABLED_PRESERVE_EXACT.has(rel));
};

const unionInto = (target: Set<string>, source: Set<string>): void => {
  for (const file of source) target.add(file);
};

const graphStats = (
  staging: string,
  entry: string,
  graph: Set<string>,
  beforeSizes: Map<string, number>,
  afterSizes: Map<string, number>,
): ColdGraphStats => ({
  entry: relative(staging, entry).split('\\').join('/'),
  entryBytes: afterSizes.get(entry) ?? 0,
  modules: graph.size,
  beforeBytes: [...graph].reduce((total, file) => total + (beforeSizes.get(file) ?? 0), 0),
  afterBytes: [...graph].reduce((total, file) => total + (afterSizes.get(file) ?? 0), 0),
});

export const minifyColdArtifactModules = async (
  staging: string,
  browser: Browser,
  channel: Channel,
): Promise<ArtifactMinifyReport> => {
  const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as {
    background?: { service_worker?: string; scripts?: string[] };
  };
  const backgroundEntries = [
    ...(typeof manifest.background?.service_worker === 'string'
      ? [manifest.background.service_worker]
      : []),
    ...(Array.isArray(manifest.background?.scripts) ? manifest.background.scripts : []),
  ];
  if (backgroundEntries.length < 1) {
    throw new Error('artifact manifest declares no background module entry');
  }

  const serviceWorkerGraph = new Set<string>();
  for (const rel of backgroundEntries) {
    unionInto(serviceWorkerGraph, await collectStaticModuleGraph(staging, join(staging, rel)));
  }
  const serviceWorkerEntry = join(staging, backgroundEntries[0]);

  const offscreenEntry = join(staging, 'offscreen', 'offscreen.js');
  const offscreenGraph = browser === 'chrome'
    ? await collectStaticModuleGraph(staging, offscreenEntry)
    : undefined;

  const allModules = new Set(serviceWorkerGraph);
  if (offscreenGraph) unionInto(allModules, offscreenGraph);

  const beforeSource = new Map<string, string>();
  const beforeSizes = new Map<string, number>();
  for (const file of allModules) {
    const source = readFileSync(file, 'utf8');
    beforeSource.set(file, source);
    beforeSizes.set(file, byteLength(source));
  }

  const outputs = new Map<string, string>();
  let transformedModules = 0;
  const compactWhitespace = new Bun.Transpiler({
    loader: 'js', target: 'browser', minifyWhitespace: true,
    deadCodeElimination: false, inline: false, treeShaking: false,
    trimUnusedImports: false,
  });

  for (const file of allModules) {
    if (!shouldTransform(staging, file, browser, channel)) continue;
    const source = beforeSource.get(file) as string;
    const built = await Bun.build({
      entrypoints: [file],
      target: 'browser',
      format: 'esm',
      external: ['*'],
      minify: {
        whitespace: true,
        syntax: true,
        identifiers: false,
      },
    });
    if (!built.success || built.outputs.length !== 1) {
      throw new Error(`release minification failed for ${relative(staging, file)}`);
    }
    const candidate = `${(await built.outputs[0].text()).trimEnd()}\n`;
    const whitespace = `${compactWhitespace.transformSync(source).trimEnd()}\n`;
    const output = [source, whitespace, candidate]
      .reduce((smallest, value) => byteLength(value) < byteLength(smallest) ? value : smallest);
    const beforeImports = await moduleImportSpecifiers(source, relative(staging, file));
    const afterImports = await moduleImportSpecifiers(output, relative(staging, file));
    if (JSON.stringify(afterImports) !== JSON.stringify(beforeImports)) {
      throw new Error(
        `release minification changed imports in ${relative(staging, file)}`,
      );
    }
    const beforeExports = await exportedNames(source, relative(staging, file));
    const afterExports = await exportedNames(output, relative(staging, file));
    if (JSON.stringify([...afterExports].sort()) !== JSON.stringify([...beforeExports].sort())) {
      throw new Error(
        `release minification changed exports in ${relative(staging, file)}`,
      );
    }
    outputs.set(file, output);
    if (output !== source) transformedModules++;
  }

  // Validate the whole batch before mutating staging, then write only there.
  for (const [file, output] of outputs) writeFileSync(file, output);

  const afterSizes = new Map(beforeSizes);
  for (const [file, output] of outputs) afterSizes.set(file, byteLength(output));
  const beforeBytes = [...allModules]
    .reduce((total, file) => total + (beforeSizes.get(file) ?? 0), 0);
  const afterBytes = [...allModules]
    .reduce((total, file) => total + (afterSizes.get(file) ?? 0), 0);

  return {
    browser,
    channel,
    transformedModules,
    preservedModules: allModules.size - outputs.size,
    beforeBytes,
    afterBytes,
    graphs: {
      serviceWorker: graphStats(
        staging,
        serviceWorkerEntry,
        serviceWorkerGraph,
        beforeSizes,
        afterSizes,
      ),
      ...(offscreenGraph ? {
        offscreen: graphStats(
          staging,
          offscreenEntry,
          offscreenGraph,
          beforeSizes,
          afterSizes,
        ),
      } : {}),
    },
  };
};

export const assertColdArtifactBudgets = (
  report: ArtifactMinifyReport,
  budgets: ColdGraphBudgets = COLD_GRAPH_BUDGETS[report.channel][report.browser],
): void => {
  for (const [name, stats] of Object.entries(report.graphs) as Array<
    ['serviceWorker' | 'offscreen', ColdGraphStats]
  >) {
    if (stats.afterBytes >= stats.beforeBytes) {
      throw new Error(
        `${name} cold graph did not shrink (${stats.beforeBytes} -> ${stats.afterBytes} bytes)`,
      );
    }
    const budget = budgets[name];
    if (!budget) {
      throw new Error(`${report.browser} has no reviewed ${name} cold-graph budget`);
    }
    if (stats.modules > budget.modules) {
      throw new Error(
        `${name} cold graph has ${stats.modules} modules; budget is ${budget.modules}`,
      );
    }
    if (stats.afterBytes > budget.graphBytes) {
      throw new Error(
        `${name} cold graph is ${stats.afterBytes} bytes after release minification; budget is ${budget.graphBytes}`,
      );
    }
    if (stats.entryBytes > budget.entryBytes) {
      throw new Error(
        `${name} cold entry is ${stats.entryBytes} bytes after release minification; budget is ${budget.entryBytes}`,
      );
    }
  }
};

export const formatArtifactMinifyReport = (report: ArtifactMinifyReport): string => {
  const percent = report.beforeBytes > 0
    ? Math.round((1 - report.afterBytes / report.beforeBytes) * 1000) / 10
    : 0;
  const graphBytes = [
    `service worker ${report.graphs.serviceWorker.afterBytes}`,
    ...(report.graphs.offscreen ? [`offscreen ${report.graphs.offscreen.afterBytes}`] : []),
  ].join(', ');
  return `optimized cold JS ${report.beforeBytes} -> ${report.afterBytes} bytes (-${percent}%; `
    + `${report.transformedModules} authored modules; ${graphBytes})`;
};
