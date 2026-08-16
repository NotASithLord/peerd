// Release-artifact-only JavaScript optimization.
//
// Source in extension/ remains browser-loadable as written. This helper runs
// only against the disposable package staging tree and preserves the ES-module
// graph: no bundling, identifier mangling, syntax folding, or dependency
// injection. It removes whitespace/comments from authored modules that are in
// the static service-worker or Chrome offscreen cold graphs. Lazy modules stay
// readable and lazy. Vendored and generated policy-boundary bytes are retained
// exactly so their provenance and artifact assertions remain meaningful.

import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Browser } from './lib.ts';
import {
  collectStaticModuleGraph,
  staticImportSpecifiers,
} from './static-module-graph.ts';

export interface ColdGraphStats {
  entry: string;
  modules: number;
  beforeBytes: number;
  afterBytes: number;
}

export interface ArtifactMinifyReport {
  transformedModules: number;
  preservedModules: number;
  beforeBytes: number;
  afterBytes: number;
  graphs: {
    serviceWorker: ColdGraphStats;
    offscreen?: ColdGraphStats;
  };
}

// These are artifact byte budgets for the complete static graphs, including
// byte-identical vendor modules. They provide headroom for normal maintenance
// while preventing silent cold-path growth from undoing this optimization.
export const COLD_GRAPH_BUDGETS = Object.freeze({
  serviceWorker: 2_200_000,
  offscreen: 600_000,
});

const PRESERVE_EXACT = new Set([
  'shared/channel-config.js',
  'shared/dweb-loader.js',
]);

const byteLength = (source: string): number => Buffer.byteLength(source, 'utf8');

const shouldTransform = (staging: string, file: string): boolean => {
  const rel = relative(staging, file).split('\\').join('/');
  return ['.js', '.mjs'].includes(extname(file))
    && !rel.startsWith('vendor/')
    && !PRESERVE_EXACT.has(rel);
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
  modules: graph.size,
  beforeBytes: [...graph].reduce((total, file) => total + (beforeSizes.get(file) ?? 0), 0),
  afterBytes: [...graph].reduce((total, file) => total + (afterSizes.get(file) ?? 0), 0),
});

export const minifyColdArtifactModules = async (
  staging: string,
  browser: Browser,
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

  const transpiler = new Bun.Transpiler({
    loader: 'js',
    target: 'browser',
    minifyWhitespace: true,
    // Bun's Transpiler enables some syntax optimization independently of
    // whitespace compaction. Disable each one explicitly: this release pass
    // must not fold constants, remove code/imports, or tree-shake modules.
    deadCodeElimination: false,
    inline: false,
    treeShaking: false,
    trimUnusedImports: false,
  });
  const outputs = new Map<string, string>();
  let transformedModules = 0;

  for (const file of allModules) {
    if (!shouldTransform(staging, file)) continue;
    const source = beforeSource.get(file) as string;
    const output = `${transpiler.transformSync(source).trimEnd()}\n`;
    const beforeImports = await staticImportSpecifiers(source, relative(staging, file));
    const afterImports = await staticImportSpecifiers(output, relative(staging, file));
    if (JSON.stringify(afterImports) !== JSON.stringify(beforeImports)) {
      throw new Error(
        `release minification changed static imports in ${relative(staging, file)}`,
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

export const assertColdArtifactBudgets = (report: ArtifactMinifyReport): void => {
  for (const [name, stats] of Object.entries(report.graphs) as Array<
    ['serviceWorker' | 'offscreen', ColdGraphStats]
  >) {
    if (stats.afterBytes >= stats.beforeBytes) {
      throw new Error(
        `${name} cold graph did not shrink (${stats.beforeBytes} -> ${stats.afterBytes} bytes)`,
      );
    }
    const budget = COLD_GRAPH_BUDGETS[name];
    if (stats.afterBytes > budget) {
      throw new Error(
        `${name} cold graph is ${stats.afterBytes} bytes after release minification; budget is ${budget}`,
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
