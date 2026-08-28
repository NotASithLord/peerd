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
  minimumIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

interface BskyActor { did: string; handle: string; }
interface FollowPage { cursor?: string; subject?: BskyActor; followers?: BskyActor[]; follows?: BskyActor[]; }
interface CollectedPage { actors: BskyActor[]; subject?: BskyActor; }

const appView = 'https://public.api.bsky.app/xrpc';

const actorId = (actor: BskyActor): string => `bsky:${actor.did || actor.handle}`;

export const collectBluesky = async (
  seedActors: string[],
  {
    neighborhoodCap = 3000,
    followCrawlCap = 1000,
    followCapPerActor = 300,
    minimumIntervalMs = 100,
    fetchImpl,
    log = console.error,
  }: BlueskyCollectOptions = {},
): Promise<Graph> => {
  const graph = createGraph();
  const request: FetchJsonOptions = { fetchImpl, minimumIntervalMs };

  const ensureActor = (actor: BskyActor): string => {
    const id = actorId(actor);
    const existing = graph.nodes.get(id);
    const url = `https://bsky.app/profile/${actor.handle}`;
    addNode(graph, {
      id,
      label: actor.handle,
      kind: 'bluesky',
      person: true,
      url,
    });
    if (existing && actor.did) graph.nodes.set(id, { ...existing, label: actor.handle, url });
    return id;
  };

  const page = async (endpoint: string, actor: string, cap: number): Promise<CollectedPage> => {
    const collected: BskyActor[] = [];
    let subject: BskyActor | undefined;
    let cursor: string | undefined;
    while (collected.length < cap) {
      const url = `${appView}/${endpoint}?actor=${encodeURIComponent(actor)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = await fetchJson<FollowPage>(url, request);
      subject ??= data.subject;
      const batch = data.followers ?? data.follows ?? [];
      collected.push(...batch);
      cursor = data.cursor;
      if (!cursor || batch.length === 0) break;
    }
    return { actors: collected.slice(0, cap), subject };
  };

  const discovered = new Map<string, BskyActor>();
  const discoveryCount = new Map<string, number>();
  const rememberActor = (actor: BskyActor): string => {
    const id = ensureActor(actor);
    discovered.set(id, actor);
    discoveryCount.set(id, (discoveryCount.get(id) ?? 0) + 1);
    return id;
  };

  for (const seed of seedActors) {
    log(`  neighborhood of @${seed}…`);
    const followers = await page('app.bsky.graph.getFollowers', seed, neighborhoodCap);
    const follows = await page('app.bsky.graph.getFollows', seed, neighborhoodCap);
    const subject = follows.subject ?? followers.subject ?? await fetchJson<BskyActor>(
      `${appView}/app.bsky.actor.getProfile?actor=${encodeURIComponent(seed)}`,
      request,
    );
    const seedId = rememberActor(subject);
    for (const follower of followers.actors) {
      addEdge(graph, rememberActor(follower), seedId);
    }
    for (const followed of follows.actors) {
      addEdge(graph, seedId, rememberActor(followed));
    }
  }

  const crawlOrder = [...discovered.entries()]
    .sort((a, b) => (discoveryCount.get(b[0]) ?? 0) - (discoveryCount.get(a[0]) ?? 0)
      || a[0].localeCompare(b[0]))
    .slice(0, followCrawlCap);
  log(`  in-community follow lists for ${crawlOrder.length} actors…`);
  let crawled = 0;
  for (const [, actor] of crawlOrder) {
    const follows = await page('app.bsky.graph.getFollows', actor.did || actor.handle, followCapPerActor);
    if (follows.subject) ensureActor(follows.subject);
    for (const followed of follows.actors) {
      const followedId = actorId(followed);
      if (graph.nodes.has(followedId)) addEdge(graph, actorId(actor), followedId);
    }
    if (++crawled % 100 === 0) log(`    ${crawled}/${crawlOrder.length}`);
  }

  return graph;
};
