// gtm/run.ts - the CLI. Run with Bun (never shipped in the extension):
//
//   bun gtm/run.ts collect [--source=github,bluesky,hn] [--fresh]
//   bun gtm/run.ts analyze [--top=150]
//   bun gtm/run.ts all
//
// collect  → crawls each source and caches it as gtm/data/<source>.json
//            (cached sources are skipped unless --fresh; a crawl you can
//            resume per-source beats one monolithic run that dies at 90%)
// analyze  → merges caches, scores the graph, writes gtm/out/:
//              graph.gexf   - open in Gephi (color by community, size by pagerank)
//              nodes.csv    - the same table for a spreadsheet
//              outreach.md  - the ranked worksheet to actually work through
//
// Strategy + etiquette: gtm/README.md. Seeds: gtm/seeds.ts (edit them!).

import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { collectBluesky } from './collect/bluesky.ts';
import { collectGithub } from './collect/github.ts';
import { collectHn } from './collect/hn.ts';
import {
  computeScores, createGraph, deserializeGraph, mergeGraphs, pruneDanglingEdges,
  serializeGraph, toGexf, toNodesCsv, type Graph,
} from './lib/graph.ts';
import { rankOutreach, toOutreachMarkdown } from './lib/rank.ts';
import { DEFAULT_SEEDS } from './seeds.ts';

const gtmDir = new URL('.', import.meta.url).pathname;
const dataDir = `${gtmDir}data`;
const outDir = `${gtmDir}out`;

const argValue = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const COLLECTORS: Record<string, () => Promise<Graph>> = {
  github: () => collectGithub(DEFAULT_SEEDS.githubRepos),
  bluesky: () => collectBluesky(DEFAULT_SEEDS.blueskyActors),
  hn: () => collectHn(DEFAULT_SEEDS.hnQueries),
};

const collect = async (): Promise<void> => {
  await mkdir(dataDir, { recursive: true });
  const requested = (argValue('source') ?? 'github,bluesky,hn').split(',');
  for (const source of requested) {
    const collector = COLLECTORS[source.trim()];
    if (!collector) throw new Error(`unknown source "${source}" (expected: ${Object.keys(COLLECTORS).join(', ')})`);
    const cachePath = `${dataDir}/${source.trim()}.json`;
    // why attempt-then-handle: the cache probe is only a fast skip. The
    // atomic publish below decides which concurrent crawl keeps its result.
    const fresh = hasFlag('fresh');
    if (!fresh && await stat(cachePath).then(() => true, () => false)) {
      console.error(`${source}: cached at ${cachePath} (use --fresh to recrawl)`);
      continue;
    }
    console.error(`${source}: collecting…`);
    const graph = await collector();
    const temporaryPath = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(serializeGraph(graph)), { flag: 'wx' });
      // why link when not fresh: link publishes the complete file and fails
      // if another process won. Rename atomically replaces a fresh cache.
      if (fresh) await rename(temporaryPath, cachePath);
      else await link(temporaryPath, cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      console.error(`${source}: cache appeared mid-crawl; kept the existing ${cachePath}`);
      continue;
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    console.error(`${source}: ${graph.nodes.size} nodes, ${graph.edges.size} edges → ${cachePath}`);
  }
};

const analyze = async (): Promise<void> => {
  const merged = createGraph();
  let sources = 0;
  // attempt-then-handle: a missing data dir is just "nothing collected yet"
  const files = await readdir(dataDir).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    mergeGraphs(merged, deserializeGraph(JSON.parse(await readFile(`${dataDir}/${file}`, 'utf8'))));
    sources++;
  }
  if (sources === 0) {
    console.error('no collected data in gtm/data/ - run `bun gtm/run.ts collect` first');
    process.exitCode = 1;
    return;
  }
  pruneDanglingEdges(merged);
  console.error(`merged ${sources} source(s): ${merged.nodes.size} nodes, ${merged.edges.size} edges`);

  console.error('scoring (pagerank, betweenness, communities)…');
  const scores = computeScores(merged);
  const ranked = rankOutreach(merged, scores);

  await mkdir(outDir, { recursive: true });
  const top = Number(argValue('top') ?? 150);
  await writeFile(`${outDir}/graph.gexf`, toGexf(merged, scores));
  await writeFile(`${outDir}/nodes.csv`, toNodesCsv(merged, scores));
  await writeFile(`${outDir}/outreach.md`, toOutreachMarkdown(ranked, top));
  console.error(`wrote gtm/out/graph.gexf, nodes.csv, outreach.md (top ${top} of ${ranked.length} accounts)`);
};

const command = process.argv[2];
if (command === 'collect') await collect();
else if (command === 'analyze') await analyze();
else if (command === 'all') { await collect(); await analyze(); }
else {
  console.error('usage: bun gtm/run.ts <collect|analyze|all> [--source=github,bluesky,hn] [--fresh] [--top=N]');
  process.exitCode = 1;
}
