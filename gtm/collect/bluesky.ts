// gtm/collect/bluesky.ts - map the Bluesky neighborhood around seed actors.
//
// why Bluesky and not Twitter/X: the follow graph here is a PUBLIC, free,
// unauthenticated API (the AppView) - no scraping, no ToS gray zone - and
// the local-first / dweb community peerd's `d` module speaks to genuinely
// lives here. This is the closest 2026 analog to the graph Figma mapped.
//
// Edge model: follower → followee ("endorses"). Same in-community trick as
// the GitHub collector: after harvesting the seeds' neighborhoods we crawl
// follow lists of discovered actors and keep only edges that stay inside
// the collected set.

import { addEdge, addNode, createGraph, type Graph } from '../lib/graph.ts';
import { fetchJson, type FetchJsonOptions } from '../lib/http.ts';

export interface BlueskyCollectOptions {
  /** followers/follows fetched per seed actor (100 per page) */
  neighborhoodCap?: number;
  /** discovered actors whose follow lists we then crawl */
  followCrawlCap?: number;
  followCapPerActor?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

interface BskyActor { did: string; handle: string; }
interface FollowPage { cursor?: string; followers?: BskyActor[]; follows?: BskyActor[]; }

const appView = 'https://public.api.bsky.app/xrpc';

const actorId = (actor: BskyActor): string => `bsky:${actor.handle}`;

export const collectBluesky = async (
  seedActors: string[],
  {
    neighborhoodCap = 3000,
    followCrawlCap = 1000,
    followCapPerActor = 300,
    fetchImpl,
    log = console.error,
  }: BlueskyCollectOptions = {},
): Promise<Graph> => {
  const graph = createGraph();
  const request: FetchJsonOptions = { fetchImpl };

  const ensureActor = (actor: BskyActor): string => {
    const id = actorId(actor);
    addNode(graph, {
      id,
      label: actor.handle,
      kind: 'bluesky',
      person: true,
      url: `https://bsky.app/profile/${actor.handle}`,
    });
    return id;
  };

  const page = async (endpoint: string, actor: string, cap: number): Promise<BskyActor[]> => {
    const collected: BskyActor[] = [];
    let cursor: string | undefined;
    while (collected.length < cap) {
      const url = `${appView}/${endpoint}?actor=${encodeURIComponent(actor)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = await fetchJson<FollowPage>(url, request);
      const batch = data.followers ?? data.follows ?? [];
      collected.push(...batch);
      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;
    }
    return collected.slice(0, cap);
  };

  const discovered = new Set<string>(); // handles seen anywhere near the seeds

  for (const seed of seedActors) {
    log(`  neighborhood of @${seed}…`);
    const seedId = ensureActor({ did: '', handle: seed });
    discovered.add(seed);
    for (const follower of await page('app.bsky.graph.getFollowers', seed, neighborhoodCap)) {
      addEdge(graph, ensureActor(follower), seedId);
      discovered.add(follower.handle);
    }
    for (const followed of await page('app.bsky.graph.getFollows', seed, neighborhoodCap)) {
      addEdge(graph, seedId, ensureActor(followed));
      discovered.add(followed.handle);
    }
  }

  const crawlOrder = [...discovered].sort().slice(0, followCrawlCap);
  log(`  in-community follow lists for ${crawlOrder.length} actors…`);
  let crawled = 0;
  for (const handle of crawlOrder) {
    for (const followed of await page('app.bsky.graph.getFollows', handle, followCapPerActor)) {
      if (graph.nodes.has(actorId(followed))) {
        addEdge(graph, `bsky:${handle}`, actorId(followed));
      }
    }
    if (++crawled % 100 === 0) log(`    ${crawled}/${crawlOrder.length}`);
  }

  return graph;
};
