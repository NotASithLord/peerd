// gtm/lib/rank.ts - turn raw centrality scores into a ranked outreach list.
//
// Pure (no IO). why percentiles, not raw values: PageRank and betweenness
// live on wildly different scales and both are heavy-tailed; percentile
// ranks make them comparable and make the combined score robust to a few
// mega-nodes swamping everything.

import type { Graph, NodeScores } from './graph.ts';

export interface RankWeights {
  pageRank: number;
  betweenness: number;
  inDegree: number;
}

// why this default: endorsement (PageRank) is the primary signal the
// playbook is built on; bridging is the differentiator for EVANGELISTS
// (their reach compounds across clusters); in-degree is a stabilizer.
export const DEFAULT_WEIGHTS: RankWeights = { pageRank: 0.5, betweenness: 0.3, inDegree: 0.2 };

export interface OutreachCandidate {
  id: string;
  label: string;
  kind: string;
  url: string;
  score: number;
  pageRankPercentile: number;
  betweennessPercentile: number;
  inDegree: number;
  community: number;
  /** distinct communities among this node's neighbors - >1 means a bridge */
  communitiesTouched: number;
  why: string;
}

const percentileRanks = (ids: string[], values: Map<string, number>): Map<string, number> => {
  const valueOf = (id: string): number => values.get(id) ?? 0;
  const sorted = [...ids].sort((a, b) => valueOf(a) - valueOf(b) || a.localeCompare(b));
  const result = new Map<string, number>();
  const denominator = Math.max(1, sorted.length - 1);
  let start = 0;
  while (start < sorted.length) {
    let end = start + 1;
    while (end < sorted.length && valueOf(sorted[end]) === valueOf(sorted[start])) end++;
    const percentile = ((start + end - 1) / 2) / denominator;
    for (const id of sorted.slice(start, end)) result.set(id, percentile);
    start = end;
  }
  return result;
};

export const rankOutreach = (
  graph: Graph,
  scores: NodeScores,
  weights: RankWeights = DEFAULT_WEIGHTS,
): OutreachCandidate[] => {
  // why person-only here (not before scoring): repos/stories must stay in
  // the graph while scoring - contributions flowing through a repo node are the
  // endorsement signal - but they are never outreach targets themselves.
  const personIds = [...graph.nodes.values()].filter((node) => node.person).map((node) => node.id);

  const prPct = percentileRanks(personIds, scores.pageRank);
  const btPct = percentileRanks(personIds, scores.betweenness);
  const degPct = percentileRanks(personIds, scores.inDegree);

  const touched = new Map<string, Set<number>>();
  for (const edge of graph.edges.values()) {
    for (const [self, other] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      const otherCommunity = scores.community.get(other);
      if (otherCommunity === undefined) continue;
      let set = touched.get(self);
      if (!set) touched.set(self, (set = new Set()));
      set.add(otherCommunity);
    }
  }

  const candidates = personIds.map((id): OutreachCandidate => {
    const node = graph.nodes.get(id)!;
    const pr = prPct.get(id) ?? 0;
    const bt = btPct.get(id) ?? 0;
    const deg = degPct.get(id) ?? 0;
    const communitiesTouched = touched.get(id)?.size ?? 0;
    const reasons: string[] = [];
    if (pr >= 0.99) reasons.push('top 1% endorsement (PageRank)');
    else if (pr >= 0.95) reasons.push('top 5% endorsement (PageRank)');
    if (bt >= 0.95 && communitiesTouched > 1) reasons.push(`bridges ${communitiesTouched} communities`);
    const inDeg = scores.inDegree.get(id) ?? 0;
    if (inDeg > 0) reasons.push(`${inDeg} in-community endorsements`);
    return {
      id,
      label: node.label,
      kind: node.kind,
      url: node.url ?? '',
      score: weights.pageRank * pr + weights.betweenness * bt + weights.inDegree * deg,
      pageRankPercentile: pr,
      betweennessPercentile: bt,
      inDegree: inDeg,
      community: scores.community.get(id) ?? 0,
      communitiesTouched,
      why: reasons.join(' · ') || 'in-community presence',
    };
  });

  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};

/** Render the top-N as a Markdown worksheet: ranked overall, then a
 * per-community view so outreach covers every cluster instead of
 * exhausting the biggest one. */
export const toOutreachMarkdown = (candidates: OutreachCandidate[], top = 150): string => {
  const picked = candidates.slice(0, top);
  const lines = [
    '# peerd - outreach worksheet',
    '',
    `Top ${picked.length} of ${candidates.length} accounts, scored by weighted PageRank / betweenness / in-degree percentiles.`,
    'Deduplicate identities first. Contact each human once, with one specific message.',
    '',
    '| # | who | where | score | why | link |',
    '|---|-----|-------|-------|-----|------|',
  ];
  picked.forEach((candidate, i) => {
    lines.push(`| ${i + 1} | ${candidate.label} | ${candidate.kind} | ${candidate.score.toFixed(3)} | ${candidate.why} | ${candidate.url} |`);
  });

  const byCommunity = new Map<number, OutreachCandidate[]>();
  for (const candidate of picked) {
    const list = byCommunity.get(candidate.community) ?? [];
    list.push(candidate);
    byCommunity.set(candidate.community, list);
  }
  lines.push('', '## Coverage by community', '');
  for (const [community, members] of [...byCommunity.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`- **community ${community}** (${members.length} in top list): ${members.slice(0, 8).map((m) => m.label).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
};
