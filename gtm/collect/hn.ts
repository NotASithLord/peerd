// gtm/collect/hn.ts - engagement graph from Hacker News via the Algolia API.
//
// HN has no follow graph, but it has something the others lack: TOPIC
// engagement. Commenting on a "local-first" or "browser agent" story is a
// strong interest signal. Edge model: commenter → story author (endorses
// the person) and commenter → story node (keeps topic structure so the
// community detection can see which THEMES cluster together).

import { addEdge, addNode, createGraph, type Graph } from '../lib/graph.ts';
import { fetchJson, type FetchJsonOptions } from '../lib/http.ts';

export interface HnCollectOptions {
  storiesPerQuery?: number;
  /** stop walking a story's comment tree after this many commenters */
  commenterCapPerStory?: number;
  /** ignore stories below this score - low-engagement stories add noise */
  minStoryPoints?: number;
  minimumIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

interface AlgoliaHit { objectID: string; title: string; author: string; points: number; }
interface AlgoliaSearch { hits: AlgoliaHit[]; }
interface AlgoliaItem { id: number; author?: string | null; children?: AlgoliaItem[]; }

const api = 'https://hn.algolia.com/api/v1';

const userNode = (author: string) => ({
  id: `hn:${author}`,
  label: author,
  kind: 'hn' as const,
  person: true,
  url: `https://news.ycombinator.com/user?id=${author}`,
});

export const collectHn = async (
  queries: string[],
  {
    storiesPerQuery = 30,
    commenterCapPerStory = 200,
    minStoryPoints = 20,
    minimumIntervalMs = 100,
    fetchImpl,
    log = console.error,
  }: HnCollectOptions = {},
): Promise<Graph> => {
  const graph = createGraph();
  const request: FetchJsonOptions = { fetchImpl, minimumIntervalMs };
  const seenStories = new Set<string>();

  for (const query of queries) {
    log(`  HN stories for "${query}"…`);
    const search = await fetchJson<AlgoliaSearch>(
      `${api}/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${storiesPerQuery}`,
      request,
    );
    for (const hit of search.hits) {
      if (hit.points < minStoryPoints || seenStories.has(hit.objectID)) continue;
      seenStories.add(hit.objectID);

      const storyId = `story:${hit.objectID}`;
      addNode(graph, {
        id: storyId,
        label: hit.title,
        kind: 'story',
        person: false,
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        meta: { points: hit.points, query },
      });
      addNode(graph, userNode(hit.author));

      const item = await fetchJson<AlgoliaItem>(`${api}/items/${hit.objectID}`, request);
      const commenters = new Set<string>();
      const walk = (children: AlgoliaItem[] | undefined): void => {
        if (!children) return;
        for (const child of children) {
          if (commenters.size >= commenterCapPerStory) return;
          if (child.author && child.author !== hit.author) {
            if (!commenters.has(child.author)) {
              commenters.add(child.author);
              addNode(graph, userNode(child.author));
            }
            addEdge(graph, `hn:${child.author}`, storyId);
            addEdge(graph, `hn:${child.author}`, `hn:${hit.author}`);
          }
          walk(child.children);
        }
      };
      walk(item.children);
    }
  }

  return graph;
};
