// gtm/collect/github.ts - map the GitHub neighborhood around the seed repos.
//
// The 2026 equivalent of Dylan Field's Twitter scrape: for a dev tool the
// strongest public endorsement graph is GitHub. Two edge layers:
//   1. contributor edges person → repo   (who builds in this space)
//   2. follow edges   person → person (who the space itself listens to)
// The follow crawl is IN-COMMUNITY only: we keep a follow edge only when
// both ends contributed to seed repos. That is the whole trick - someone with 300
// followers inside this graph beats someone with 100k generic ones.
//
// Auth: set GITHUB_TOKEN (classic, no scopes needed - public data only).
// Unauthenticated works but the 60 req/hr limit makes real crawls painful.

import { addEdge, addNode, createGraph, type Graph } from '../lib/graph.ts';
import { fetchJson, type FetchJsonOptions } from '../lib/http.ts';

export interface GithubCollectOptions {
  token?: string;
  /** contributors fetched per seed repo (100 per API page) */
  contributorCapPerRepo?: number;
  /** users whose follow lists we crawl, prioritized by multi-repo overlap */
  followCrawlCap?: number;
  /** follow entries fetched per crawled user */
  followCapPerUser?: number;
  minimumIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

interface GithubUser { login: string; html_url: string; type: string; }

const api = 'https://api.github.com';

export const collectGithub = async (
  seedRepos: string[],
  {
    token = process.env.GITHUB_TOKEN,
    contributorCapPerRepo = 2000,
    followCrawlCap = 1500,
    followCapPerUser = 200,
    minimumIntervalMs = 100,
    fetchImpl,
    log = console.error,
  }: GithubCollectOptions = {},
): Promise<Graph> => {
  const graph = createGraph();
  const request: FetchJsonOptions = {
    fetchImpl,
    minimumIntervalMs,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'peerd-gtm-graph',
      'x-github-api-version': '2026-03-10',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
  if (!token) log('  warning: no GITHUB_TOKEN - unauthenticated rate limit is 60 req/hr');

  const contributionCounts = new Map<string, number>();

  for (const fullName of seedRepos) {
    const repoId = `repo:${fullName}`;
    addNode(graph, {
      id: repoId,
      label: fullName,
      kind: 'repo',
      person: false,
      url: `https://github.com/${fullName}`,
    });
    log(`  contributors to ${fullName}…`);
    for (let page = 1; page <= Math.ceil(contributorCapPerRepo / 100); page++) {
      const users = await fetchJson<GithubUser[]>(
        `${api}/repos/${fullName}/contributors?per_page=100&page=${page}`,
        request,
      );
      const remaining = contributorCapPerRepo - (page - 1) * 100;
      for (const user of users.slice(0, remaining)) {
        if (user.type !== 'User') continue; // orgs/bots are not outreach targets
        const id = `github:${user.login}`;
        addNode(graph, {
          id,
          label: user.login,
          kind: 'github',
          person: true,
          url: user.html_url,
        });
        addEdge(graph, id, repoId);
        contributionCounts.set(user.login, (contributionCounts.get(user.login) ?? 0) + 1);
      }
      if (users.length < 100) break;
    }
  }

  // why multi-repo-first: a person who contributed to three seed repos is
  // more likely to be in the community; crawl their
  // follow lists first so a capped crawl spends budget where signal is.
  const crawlOrder = [...contributionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, followCrawlCap)
    .map(([login]) => login);

  log(`  follow lists for ${crawlOrder.length} users (in-community edges only)…`);
  let crawled = 0;
  for (const login of crawlOrder) {
    for (let page = 1; page <= Math.ceil(followCapPerUser / 100); page++) {
      const following = await fetchJson<GithubUser[]>(
        `${api}/users/${login}/following?per_page=100&page=${page}`,
        request,
      );
      const remaining = followCapPerUser - (page - 1) * 100;
      for (const followed of following.slice(0, remaining)) {
        // in-community filter: only keep the edge when the followed person
        // is already in the graph (i.e. also contributed to seed repos).
        if (graph.nodes.has(`github:${followed.login}`)) {
          addEdge(graph, `github:${login}`, `github:${followed.login}`);
        }
      }
      if (following.length < 100) break;
    }
    if (++crawled % 100 === 0) log(`    ${crawled}/${crawlOrder.length}`);
  }

  return graph;
};
