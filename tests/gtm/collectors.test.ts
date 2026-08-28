import { describe, expect, test } from 'bun:test';
import { collectBluesky } from '../../gtm/collect/bluesky.ts';
import { collectGithub } from '../../gtm/collect/github.ts';
import { collectHn } from '../../gtm/collect/hn.ts';

const json = (value: unknown): Response => Response.json(value);
const edgePairs = (graph: Awaited<ReturnType<typeof collectGithub>>): string[] =>
  [...graph.edges.values()].map((edge) => `${edge.source}->${edge.target}`).sort();

describe('GTM collectors', () => {
  test('GitHub keeps only in-community follow edges', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/contributors')) {
        return json([
          { login: 'alice', html_url: 'https://github.com/alice', type: 'User' },
          { login: 'bob', html_url: 'https://github.com/bob', type: 'User' },
        ]);
      }
      if (path === '/users/alice/following') {
        return json([
          { login: 'bob', html_url: 'https://github.com/bob', type: 'User' },
          { login: 'outside', html_url: 'https://github.com/outside', type: 'User' },
        ]);
      }
      throw new Error(`unexpected request: ${path}`);
    }) as typeof fetch;

    const graph = await collectGithub(['owner/repo'], {
      fetchImpl,
      followCrawlCap: 1,
      followCapPerUser: 100,
      contributorCapPerRepo: 100,
      minimumIntervalMs: 0,
      token: 'token',
      log: () => {},
    });

    expect([...graph.nodes.keys()].sort()).toEqual(['github:alice', 'github:bob', 'repo:owner/repo']);
    expect(edgePairs(graph)).toEqual([
      'github:alice->github:bob',
      'github:alice->repo:owner/repo',
      'github:bob->repo:owner/repo',
    ]);
  });

  test('GitHub keeps contributor results within the cap', async () => {
    const users = [
      { login: 'alice', html_url: 'https://github.com/alice', type: 'User' },
      { login: 'bob', html_url: 'https://github.com/bob', type: 'User' },
      { login: 'carol', html_url: 'https://github.com/carol', type: 'User' },
    ];
    const fetchImpl = (async (_input: string | URL | Request) => json(users)) as typeof fetch;

    const graph = await collectGithub(['owner/repo'], {
      fetchImpl,
      followCrawlCap: 0,
      contributorCapPerRepo: 2,
      minimumIntervalMs: 0,
      token: 'token',
      log: () => {},
    });

    expect([...graph.nodes.keys()].sort()).toEqual(['github:alice', 'github:bob', 'repo:owner/repo']);
  });

  test('GitHub keeps follow results within the cap', async () => {
    const users = [
      { login: 'alice', html_url: 'https://github.com/alice', type: 'User' },
      { login: 'bob', html_url: 'https://github.com/bob', type: 'User' },
      { login: 'carol', html_url: 'https://github.com/carol', type: 'User' },
    ];
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/contributors')) return json(users);
      if (path === '/users/alice/following') return json(users.slice(1));
      throw new Error(`unexpected request: ${path}`);
    }) as typeof fetch;

    const graph = await collectGithub(['owner/repo'], {
      fetchImpl,
      followCrawlCap: 1,
      followCapPerUser: 1,
      contributorCapPerRepo: 3,
      minimumIntervalMs: 0,
      token: 'token',
      log: () => {},
    });

    expect(edgePairs(graph)).toContain('github:alice->github:bob');
    expect(edgePairs(graph)).not.toContain('github:alice->github:carol');
  });

  test('Bluesky uses stable DIDs when handles change', async () => {
    const seed = { did: 'did:plc:a-seed', handle: 'seed.test' };
    const followActors: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const endpoint = url.pathname;
      if (endpoint.endsWith('getFollowers')) {
        return json({
          subject: seed,
          followers: [{ did: 'did:plc:z-neighbor', handle: 'old.test' }],
        });
      }
      if (endpoint.endsWith('getFollows')) {
        const actor = url.searchParams.get('actor')!;
        followActors.push(actor);
        if (actor === 'did:plc:z-neighbor') {
          return json({
            subject: { did: 'did:plc:z-neighbor', handle: 'new.test' },
            follows: [seed],
          });
        }
        return json({
          subject: seed,
          follows: [{ did: 'did:plc:z-neighbor', handle: 'old.test' }],
        });
      }
      throw new Error(`unexpected request: ${endpoint}`);
    }) as typeof fetch;

    const graph = await collectBluesky(['seed.test'], {
      fetchImpl,
      neighborhoodCap: 1,
      followCrawlCap: 1,
      followCapPerActor: 1,
      minimumIntervalMs: 0,
      log: () => {},
    });

    expect([...graph.nodes.keys()].sort()).toEqual(['bsky:did:plc:a-seed', 'bsky:did:plc:z-neighbor']);
    expect(edgePairs(graph)).toEqual([
      'bsky:did:plc:a-seed->bsky:did:plc:z-neighbor',
      'bsky:did:plc:z-neighbor->bsky:did:plc:a-seed',
    ]);
    expect(graph.nodes.get('bsky:did:plc:z-neighbor')).toMatchObject({
      label: 'new.test',
      url: 'https://bsky.app/profile/new.test',
    });
    expect(followActors).toEqual(['seed.test', 'did:plc:z-neighbor']);
  });

  test('Bluesky resolves a seed DID when no neighborhood page runs', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toEndWith('app.bsky.actor.getProfile');
      return json({ did: 'did:plc:resolved', handle: 'seed.test' });
    }) as typeof fetch;

    const graph = await collectBluesky(['seed.test'], {
      fetchImpl,
      neighborhoodCap: 0,
      followCrawlCap: 0,
      minimumIntervalMs: 0,
      log: () => {},
    });

    expect([...graph.nodes.keys()]).toEqual(['bsky:did:plc:resolved']);
  });

  test('Hacker News collects nested topic engagement and skips weak stories', async () => {
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith('/search')) {
        return json({ hits: [
          { objectID: '1', title: 'Local agents', author: 'author', points: 50 },
          { objectID: '2', title: 'Weak signal', author: 'other', points: 2 },
        ] });
      }
      if (url.pathname.endsWith('/items/1')) {
        return json({ id: 1, children: [
          { id: 3, author: 'alice', children: [
            { id: 4, author: 'alice' },
            { id: 5, author: 'bob' },
          ] },
        ] });
      }
      throw new Error(`unexpected request: ${url.pathname}`);
    }) as typeof fetch;

    const graph = await collectHn(['local first'], {
      fetchImpl,
      storiesPerQuery: 2,
      commenterCapPerStory: 2,
      minStoryPoints: 20,
      minimumIntervalMs: 0,
      log: () => {},
    });

    expect([...graph.nodes.keys()].sort()).toEqual(['hn:alice', 'hn:author', 'hn:bob', 'story:1']);
    expect(requests).toEqual(['/api/v1/search', '/api/v1/items/1']);
    expect(edgePairs(graph)).toContain('hn:bob->hn:author');
    expect(edgePairs(graph)).not.toContain('hn:other->story:2');
  });
});
