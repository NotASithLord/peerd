// gtm/lib/graph.ts - the pure graph core for the GTM network analysis.
//
// Functional core, imperative shell: nothing in this file does IO. The
// collectors (gtm/collect/*) produce {nodes, edges}; this file merges,
// scores, and serializes them. Tested from tests/gtm/graph.test.ts,
// which also pulls it into the strict typecheck.
//
// why these algorithms: the Figma playbook is "find the influential
// nodes, reach out personally". Influence is not one number -
//   - PageRank      → who the community endorses (follows flow in)
//   - betweenness   → who BRIDGES sub-communities (the best evangelists:
//                     one post reaches audiences that don't overlap)
//   - in-degree     → raw in-community reach (sanity anchor)
//   - communities   → coverage: outreach should span clusters, not
//                     saturate one clique

export type NodeKind = 'github' | 'bluesky' | 'hn' | 'repo' | 'story';

export interface GraphNode {
  /** Globally unique, source-prefixed: "github:alice", "repo:owner/name", "bsky:did:plc:..." */
  id: string;
  label: string;
  kind: NodeKind;
  /** true for human accounts (outreach targets); repos/stories are false */
  person: boolean;
  url?: string;
  meta?: Record<string, string | number>;
}

/** Directed signal: source → target records a follow, contribution, or
 * story engagement. */
export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

export class GraphIntegrityError extends Error {}

export const createGraph = (): Graph => ({ nodes: new Map(), edges: new Map() });

export const addNode = (graph: Graph, node: GraphNode): void => {
  const existing = graph.nodes.get(node.id);
  // why merge-not-replace: the same account can arrive from two seeds.
  // Keep the richest record we have seen.
  if (existing) {
    graph.nodes.set(node.id, {
      ...existing,
      url: existing.url ?? node.url,
      meta: { ...node.meta, ...existing.meta },
    });
    return;
  }
  graph.nodes.set(node.id, node);
};

export const addEdge = (graph: Graph, source: string, target: string, weight = 1): void => {
  if (source === target) return; // self-endorsement carries no signal
  const key = `${source}\u0000${target}`;
  const existing = graph.edges.get(key);
  if (existing) existing.weight += weight;
  else graph.edges.set(key, { source, target, weight });
};

/** Merge b into a (mutates a). Node metadata merges; edge weights add. */
export const mergeGraphs = (a: Graph, b: Graph): Graph => {
  for (const node of b.nodes.values()) addNode(a, node);
  for (const edge of b.edges.values()) addEdge(a, edge.source, edge.target, edge.weight);
  return a;
};

/** Drop edges whose endpoints were never registered as nodes.
 * why: collectors cap their crawls, so follow edges can point at users
 * outside the collected set; keeping them would crash the scorers. */
export const pruneDanglingEdges = (graph: Graph): Graph => {
  for (const [key, edge] of graph.edges) {
    if (!graph.nodes.has(edge.source) || !graph.nodes.has(edge.target)) graph.edges.delete(key);
  }
  return graph;
};

const sortedNodeIds = (graph: Graph): string[] => [...graph.nodes.keys()].sort();

// JSON round-trip for the collect → analyze handoff (gtm/data/*.json).
export interface SerializedGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

export const serializeGraph = (graph: Graph): SerializedGraph => ({
  nodes: [...graph.nodes.values()],
  edges: [...graph.edges.values()],
});

export const deserializeGraph = (data: SerializedGraph): Graph => {
  const graph = createGraph();
  for (const node of data.nodes) addNode(graph, node);
  for (const edge of data.edges) addEdge(graph, edge.source, edge.target, edge.weight);
  return graph;
};

// ---------------------------------------------------------------------------
// PageRank (weighted, directed, with dangling-mass redistribution)
// ---------------------------------------------------------------------------

export interface PageRankOptions {
  damping?: number;
  maxIterations?: number;
  tolerance?: number;
}

export const pageRank = (
  graph: Graph,
  { damping = 0.85, maxIterations = 100, tolerance = 1e-9 }: PageRankOptions = {},
): Map<string, number> => {
  const ids = sortedNodeIds(graph);
  const n = ids.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  const index = new Map(ids.map((id, i) => [id, i]));
  const outWeight = new Float64Array(n);
  const outEdges: Array<Array<{ to: number; weight: number }>> = ids.map(() => []);
  for (const edge of graph.edges.values()) {
    const s = index.get(edge.source);
    const t = index.get(edge.target);
    if (s === undefined || t === undefined) throw new GraphIntegrityError(`edge references unknown node: ${edge.source} -> ${edge.target}`);
    outEdges[s].push({ to: t, weight: edge.weight });
    outWeight[s] += edge.weight;
  }

  let rank = new Float64Array(n).fill(1 / n);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const next = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outWeight[i] === 0) { danglingMass += rank[i]; continue; }
      const share = rank[i] / outWeight[i];
      for (const { to, weight } of outEdges[i]) next[to] += share * weight;
    }
    const base = (1 - damping) / n + (damping * danglingMass) / n;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const value = base + damping * next[i];
      delta += Math.abs(value - rank[i]);
      next[i] = value;
    }
    rank = next;
    if (delta < tolerance) break;
  }

  ids.forEach((id, i) => result.set(id, rank[i]));
  return result;
};

// ---------------------------------------------------------------------------
// Betweenness centrality (Brandes, unweighted, undirected view)
// ---------------------------------------------------------------------------

export interface BetweennessOptions {
  /** Run Brandes from at most this many deterministic pivots and scale up.
   * why: sampled betweenness preserves the ranking we act on. */
  maxPivots?: number;
  /** Limit the approximate node and edge visits across all pivots. */
  maxOperations?: number;
}

export const betweenness = (
  graph: Graph,
  { maxPivots = 128, maxOperations = 25_000_000 }: BetweennessOptions = {},
): Map<string, number> => {
  const ids = sortedNodeIds(graph);
  const n = ids.length;
  const score = new Map<string, number>(ids.map((id) => [id, 0]));
  if (n < 3) return score;

  const index = new Map(ids.map((id, i) => [id, i]));
  // why undirected: bridging is about sitting between communities; the
  // direction of a follow does not change who the bridge is.
  const neighbors: number[][] = ids.map(() => []);
  const seen = new Set<string>();
  for (const edge of graph.edges.values()) {
    const s = index.get(edge.source)!;
    const t = index.get(edge.target)!;
    const undirectedKey = s < t ? `${s},${t}` : `${t},${s}`;
    if (seen.has(undirectedKey)) continue;
    seen.add(undirectedKey);
    neighbors[s].push(t);
    neighbors[t].push(s);
  }

  // why use both limits: a pivot cap alone still permits extreme work on
  // dense crawls. One graph pass is the minimum useful approximation.
  const workPerPivot = n + seen.size;
  const operationPivots = Math.max(1, Math.floor(maxOperations / workPerPivot));
  const pivotCount = Math.max(1, Math.min(maxPivots, operationPivots, n));
  const stride = n / pivotCount;
  const centrality = new Float64Array(n);

  for (let p = 0; p < pivotCount; p++) {
    const source = Math.floor(p * stride); // deterministic, evenly spread - no RNG
    // Brandes single-source accumulation
    const stack: number[] = [];
    const predecessors: number[][] = ids.map(() => []);
    const sigma = new Float64Array(n);
    const distance = new Int32Array(n).fill(-1);
    sigma[source] = 1;
    distance[source] = 0;
    const queue: number[] = [source];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      stack.push(v);
      for (const w of neighbors[v]) {
        if (distance[w] < 0) {
          distance[w] = distance[v] + 1;
          queue.push(w);
        }
        if (distance[w] === distance[v] + 1) {
          sigma[w] += sigma[v];
          predecessors[w].push(v);
        }
      }
    }
    const delta = new Float64Array(n);
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i];
      for (const v of predecessors[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== source) centrality[w] += delta[w];
    }
  }

  const scale = n / pivotCount; // compensate for sampling
  ids.forEach((id, i) => score.set(id, centrality[i] * scale));
  return score;
};

// ---------------------------------------------------------------------------
// In-degree (weighted in-community reach)
// ---------------------------------------------------------------------------

export const inDegree = (graph: Graph): Map<string, number> => {
  const result = new Map<string, number>([...graph.nodes.keys()].map((id) => [id, 0]));
  for (const edge of graph.edges.values()) {
    result.set(edge.target, (result.get(edge.target) ?? 0) + edge.weight);
  }
  return result;
};

// ---------------------------------------------------------------------------
// Community detection (deterministic label propagation)
// ---------------------------------------------------------------------------

export const communities = (graph: Graph, maxIterations = 50): Map<string, number> => {
  const ids = sortedNodeIds(graph);
  const index = new Map(ids.map((id, i) => [id, i]));
  const neighborWeights: Array<Map<number, number>> = ids.map(() => new Map());
  for (const edge of graph.edges.values()) {
    const s = index.get(edge.source)!;
    const t = index.get(edge.target)!;
    neighborWeights[s].set(t, (neighborWeights[s].get(t) ?? 0) + edge.weight);
    neighborWeights[t].set(s, (neighborWeights[t].get(s) ?? 0) + edge.weight);
  }

  // why sorted-order sweeps + smallest-label tie-break: label propagation
  // is normally randomized; a GTM ranking must be reproducible run-to-run
  // so the outreach list doesn't reshuffle under you.
  const label = ids.map((_, i) => i);
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      if (neighborWeights[i].size === 0) continue;
      const tally = new Map<number, number>();
      for (const [neighbor, weight] of neighborWeights[i]) {
        tally.set(label[neighbor], (tally.get(label[neighbor]) ?? 0) + weight);
      }
      let best = label[i];
      let bestWeight = -1;
      for (const [candidate, weight] of tally) {
        if (weight > bestWeight || (weight === bestWeight && candidate < best)) {
          best = candidate;
          bestWeight = weight;
        }
      }
      if (best !== label[i]) { label[i] = best; changed = true; }
    }
    if (!changed) break;
  }

  // Compress labels to 0..k-1, largest community first, so "community 0"
  // is always the biggest cluster in every output.
  const sizes = new Map<number, number>();
  for (const l of label) sizes.set(l, (sizes.get(l) ?? 0) + 1);
  const ordered = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const remap = new Map(ordered.map(([l], i) => [l, i]));
  return new Map(ids.map((id, i) => [id, remap.get(label[i])!]));
};

// ---------------------------------------------------------------------------
// Serialization: GEXF (for Gephi) and CSV
// ---------------------------------------------------------------------------

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export interface NodeScores {
  pageRank: Map<string, number>;
  betweenness: Map<string, number>;
  inDegree: Map<string, number>;
  community: Map<string, number>;
}

export const computeScores = (graph: Graph): NodeScores => ({
  pageRank: pageRank(graph),
  betweenness: betweenness(graph),
  inDegree: inDegree(graph),
  community: communities(graph),
});

/** GEXF 1.3 - opens directly in Gephi with scores as node attributes,
 * so "color by community, size by pagerank" is two clicks. */
export const toGexf = (graph: Graph, scores: NodeScores): string => {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://gexf.net/1.3" version="1.3">',
    '  <graph defaultedgetype="directed">',
    '    <attributes class="node">',
    '      <attribute id="0" title="kind" type="string"/>',
    '      <attribute id="1" title="person" type="boolean"/>',
    '      <attribute id="2" title="pagerank" type="double"/>',
    '      <attribute id="3" title="betweenness" type="double"/>',
    '      <attribute id="4" title="indegree" type="double"/>',
    '      <attribute id="5" title="community" type="integer"/>',
    '      <attribute id="6" title="url" type="string"/>',
    '    </attributes>',
    '    <nodes>',
  ];
  for (const node of graph.nodes.values()) {
    lines.push(`      <node id="${escapeXml(node.id)}" label="${escapeXml(node.label)}">`);
    lines.push('        <attvalues>');
    lines.push(`          <attvalue for="0" value="${node.kind}"/>`);
    lines.push(`          <attvalue for="1" value="${node.person}"/>`);
    lines.push(`          <attvalue for="2" value="${scores.pageRank.get(node.id) ?? 0}"/>`);
    lines.push(`          <attvalue for="3" value="${scores.betweenness.get(node.id) ?? 0}"/>`);
    lines.push(`          <attvalue for="4" value="${scores.inDegree.get(node.id) ?? 0}"/>`);
    lines.push(`          <attvalue for="5" value="${scores.community.get(node.id) ?? 0}"/>`);
    lines.push(`          <attvalue for="6" value="${escapeXml(node.url ?? '')}"/>`);
    lines.push('        </attvalues>');
    lines.push('      </node>');
  }
  lines.push('    </nodes>', '    <edges>');
  let edgeId = 0;
  for (const edge of graph.edges.values()) {
    lines.push(`      <edge id="${edgeId++}" source="${escapeXml(edge.source)}" target="${escapeXml(edge.target)}" weight="${edge.weight}"/>`);
  }
  lines.push('    </edges>', '  </graph>', '</gexf>', '');
  return lines.join('\n');
};

const escapeCsv = (value: string): string => {
  // why prefix an apostrophe: spreadsheets can execute untrusted cells as
  // formulas. The apostrophe forces text after the CSV parser removes quotes.
  const safe = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const toNodesCsv = (graph: Graph, scores: NodeScores): string => {
  const lines = ['id,label,kind,person,pagerank,betweenness,indegree,community,url'];
  for (const node of graph.nodes.values()) {
    lines.push([
      escapeCsv(node.id),
      escapeCsv(node.label),
      node.kind,
      String(node.person),
      String(scores.pageRank.get(node.id) ?? 0),
      String(scores.betweenness.get(node.id) ?? 0),
      String(scores.inDegree.get(node.id) ?? 0),
      String(scores.community.get(node.id) ?? 0),
      escapeCsv(node.url ?? ''),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
};
