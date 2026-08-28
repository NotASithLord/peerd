// tests/gtm/graph.test.ts - the GTM toolkit's pure core, on a fixture graph.
//
// why here (not colocated in gtm/): tests/** is what `bun test ./tests`
// runs AND what pulls files into the strict typecheck - importing the gtm
// core from here gives it both gates for free.

import { describe, expect, test } from 'bun:test';
import {
  addEdge, addNode, betweenness, communities, computeScores, createGraph,
  deserializeGraph, inDegree, mergeGraphs, pageRank, pruneDanglingEdges,
  serializeGraph, toGexf, toNodesCsv, type Graph,
} from '../../gtm/lib/graph.ts';
import { rankOutreach, toOutreachMarkdown } from '../../gtm/lib/rank.ts';

const person = (graph: Graph, id: string): void =>
  addNode(graph, { id, label: id, kind: 'github', person: true, url: `https://x/${id}` });

/** Two clusters joined only through `bridge`, plus a repo node the
 * a-cluster signals. Each cluster is internally connected by a ring so no
 * cluster member is an accidental cut vertex, and `bridge` attaches to
 * TWO nodes per side so no attachment point shares its betweenness. The
 * expected winners are unambiguous: `hub` collects endorsements
 * (PageRank), `bridge` owns betweenness. */
const fixture = (): Graph => {
  const graph = createGraph();
  const aRing = ['a1', 'a2', 'a3', 'a4'];
  const bRing = ['b1', 'b2', 'b3', 'b4'];
  for (const id of [...aRing, ...bRing, 'hub', 'bridge']) person(graph, id);
  addNode(graph, { id: 'repo:x/y', label: 'x/y', kind: 'repo', person: false });

  for (const [i, id] of aRing.entries()) {
    addEdge(graph, id, 'hub'); // hub is endorsed by every a
    addEdge(graph, id, aRing[(i + 1) % aRing.length]);
  }
  for (const [i, id] of bRing.entries()) addEdge(graph, id, bRing[(i + 1) % bRing.length]);
  addEdge(graph, 'b1', 'b3'); // diagonals densify b so it clusters as one
  addEdge(graph, 'b2', 'b4');
  // the ONLY paths between clusters run through bridge; b links back so
  // the b-ring is not a rank sink (a closed cycle would trap PageRank
  // mass and drown the hub - real follow graphs always leak back out)
  addEdge(graph, 'a1', 'bridge');
  addEdge(graph, 'a2', 'bridge');
  addEdge(graph, 'bridge', 'b1');
  addEdge(graph, 'bridge', 'b2');
  addEdge(graph, 'b1', 'bridge');
  addEdge(graph, 'b2', 'bridge');
  for (const id of ['a1', 'a2']) addEdge(graph, id, 'repo:x/y');
  return graph;
};

describe('graph primitives', () => {
  test('addNode merges metadata instead of clobbering', () => {
    const graph = createGraph();
    addNode(graph, { id: 'n', label: 'n', kind: 'hn', person: true, meta: { points: 5 } });
    addNode(graph, { id: 'n', label: 'n', kind: 'hn', person: true, url: 'https://x/n', meta: { query: 'q' } });
    const node = graph.nodes.get('n')!;
    expect(node.url).toBe('https://x/n');
    expect(node.meta).toEqual({ query: 'q', points: 5 });
  });

  test('addEdge accumulates weight and drops self-loops', () => {
    const graph = createGraph();
    addEdge(graph, 'a', 'b');
    addEdge(graph, 'a', 'b', 2);
    addEdge(graph, 'a', 'a');
    expect(graph.edges.size).toBe(1);
    expect([...graph.edges.values()][0].weight).toBe(3);
  });

  test('mergeGraphs + pruneDanglingEdges keep only resolvable edges', () => {
    const a = fixture();
    const b = createGraph();
    person(b, 'hub'); // overlaps with fixture
    addEdge(b, 'hub', 'ghost'); // ghost never gets a node
    mergeGraphs(a, b);
    pruneDanglingEdges(a);
    expect(a.nodes.has('ghost')).toBe(false);
    expect([...a.edges.values()].every((e) => a.nodes.has(e.source) && a.nodes.has(e.target))).toBe(true);
  });

  test('serialize/deserialize round-trips', () => {
    const graph = fixture();
    const restored = deserializeGraph(JSON.parse(JSON.stringify(serializeGraph(graph))));
    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.edges.size).toBe(graph.edges.size);
    expect(restored.nodes.get('hub')).toEqual(graph.nodes.get('hub')!);
  });
});

describe('centrality', () => {
  test('pageRank sums to ~1 and ranks the endorsed hub above its endorsers', () => {
    const graph = fixture();
    const pr = pageRank(graph);
    const total = [...pr.values()].reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(pr.get('hub')!).toBeGreaterThan(pr.get('a1')!);
    expect(pr.get('hub')!).toBeGreaterThan(pr.get('a3')!);
  });

  test('pageRank is deterministic', () => {
    const a = pageRank(fixture());
    const b = pageRank(fixture());
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  test('betweenness crowns the bridge between clusters', () => {
    const graph = fixture();
    const bt = betweenness(graph);
    const best = [...bt.entries()].filter(([id]) => graph.nodes.get(id)!.person)
      .sort((x, y) => y[1] - x[1])[0][0];
    expect(best).toBe('bridge');
  });

  test('betweenness sampling keeps the bridge near the top', () => {
    const graph = fixture();
    const sampled = betweenness(graph, { maxPivots: 6 });
    const topTwo = [...sampled.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([id]) => id);
    expect(topTwo).toContain('bridge');
  });

  test('betweenness limits pivot work by graph size', () => {
    const graph = fixture();
    expect([...betweenness(graph, { maxPivots: 100, maxOperations: 1 })])
      .toEqual([...betweenness(graph, { maxPivots: 1 })]);
  });

  test('inDegree counts weighted endorsements', () => {
    const graph = fixture();
    expect(inDegree(graph).get('hub')).toBe(4);
    expect(inDegree(graph).get('repo:x/y')).toBe(2);
  });

  test('communities separate the two clusters and are deterministic', () => {
    const graph = fixture();
    const labels = communities(graph);
    expect(labels.get('a1')).toBe(labels.get('a2')!);
    expect(labels.get('b1')).toBe(labels.get('b2')!);
    expect(labels.get('a1')).not.toBe(labels.get('b1')!);
    expect([...labels.entries()]).toEqual([...communities(fixture()).entries()]);
  });
});

describe('outreach ranking', () => {
  test('ranks human accounts only, surfaces the bridge, and rates hub above its endorsers', () => {
    const graph = fixture();
    const ranked = rankOutreach(graph, computeScores(graph));
    expect(ranked.every((candidate) => !candidate.id.startsWith('repo:'))).toBe(true);
    expect(ranked.slice(0, 3).map((candidate) => candidate.id)).toContain('bridge');
    // the property that matters at scale: an endorsed node outranks the
    // people endorsing it (exact podium order on a 10-node toy is noise)
    const position = (id: string): number => ranked.findIndex((candidate) => candidate.id === id);
    for (const endorser of ['a1', 'a2', 'a3', 'a4']) {
      expect(position('hub')).toBeLessThan(position(endorser));
    }
  });

  test('bridge is credited with touching both communities', () => {
    const graph = fixture();
    const ranked = rankOutreach(graph, computeScores(graph));
    expect(ranked.find((candidate) => candidate.id === 'bridge')!.communitiesTouched).toBeGreaterThan(1);
  });

  test('gives equal percentile ranks to tied scores', () => {
    const graph = createGraph();
    for (const id of ['a', 'b', 'c']) person(graph, id);
    const scores = {
      pageRank: new Map([['a', 1], ['b', 1], ['c', 2]]),
      betweenness: new Map([['a', 0], ['b', 0], ['c', 0]]),
      inDegree: new Map([['a', 0], ['b', 0], ['c', 0]]),
      community: new Map([['a', 0], ['b', 0], ['c', 0]]),
    };
    const ranked = rankOutreach(graph, scores);
    const a = ranked.find((candidate) => candidate.id === 'a')!;
    const b = ranked.find((candidate) => candidate.id === 'b')!;
    expect(a.pageRankPercentile).toBe(0.25);
    expect(b.pageRankPercentile).toBe(0.25);
    expect(a.score).toBe(b.score);
    expect(ranked.map((candidate) => candidate.betweennessPercentile)).toEqual([0.5, 0.5, 0.5]);
  });

  test('markdown worksheet renders every top candidate and community coverage', () => {
    const graph = fixture();
    const ranked = rankOutreach(graph, computeScores(graph));
    const markdown = toOutreachMarkdown(ranked, 5);
    expect(markdown).toContain('| 1 |');
    expect(markdown).toContain('## Coverage by community');
    expect(markdown.split('\n').filter((line) => line.startsWith('| ')).length).toBe(6); // header + 5 rows
  });
});

describe('exports', () => {
  test('GEXF is well-formed enough for Gephi and escapes markup', () => {
    const graph = fixture();
    addNode(graph, { id: 'weird', label: 'a<b>&"c"', kind: 'hn', person: true });
    const gexf = toGexf(graph, computeScores(graph));
    expect(gexf).toStartWith('<?xml');
    expect(gexf).toContain('label="a&lt;b&gt;&amp;&quot;c&quot;"');
    expect(gexf).toContain('<attvalue for="5"'); // community attribute present
    expect((gexf.match(/<node /g) ?? []).length).toBe(graph.nodes.size);
    expect((gexf.match(/<edge /g) ?? []).length).toBe(graph.edges.size);
  });

  test('CSV quotes fields containing commas', () => {
    const graph = createGraph();
    addNode(graph, { id: 'story:1', label: 'Ask HN: agents, but local?', kind: 'story', person: false });
    const csv = toNodesCsv(graph, computeScores(graph));
    expect(csv).toContain('"Ask HN: agents, but local?"');
  });

  test('CSV forces untrusted formulas to plain text', () => {
    const graph = createGraph();
    addNode(graph, { id: 'hn:unsafe', label: ' =2+3', kind: 'hn', person: true });
    const csv = toNodesCsv(graph, computeScores(graph));
    expect(csv).toContain(",' =2+3,");
    expect(csv).not.toContain(', =2+3,');
  });
});
