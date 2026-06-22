// @ts-check
// Palette filtering + ranking — pure.
//
// The command palette shows a list of candidates (commands, files, the
// @tab entries) and filters them as the user types. We use subsequence
// ("fuzzy") matching like every IDE palette: the query characters must
// appear in order, but not necessarily contiguously. "rvw" matches
// "review", "qd" matches "query-dom".
//
// Ranking favors, in order:
//   1. exact prefix matches      ("rev" → "review" beats "preview")
//   2. word-boundary hits        (matching at '-' / '_' / camelCase seams)
//   3. shorter candidates        (less to read, usually more relevant)
//   4. earlier first-match index
//
// Pure + deterministic so the palette tests assert exact orderings.

/**
 * @typedef {Object} Candidate
 * @property {string} id          stable id (command name / file path / 'tab:active')
 * @property {string} label       primary display text matched against
 * @property {string} [detail]    secondary text (not matched, just shown)
 */

/**
 * Score a single candidate against a query. Returns a number where
 * HIGHER is better, or -Infinity if the query isn't a subsequence.
 *
 * @param {string} query     raw user query (may be empty)
 * @param {string} label     candidate label
 * @returns {number}
 */
export const score = (query, label) => {
  const q = (query ?? '').toLowerCase();
  const s = (label ?? '').toLowerCase();
  if (q === '') return 1; // empty query: everything matches with a flat score
  if (q.length > s.length) return -Infinity;

  let qi = 0;
  let firstHit = -1;
  let boundaryHits = 0;
  let prevBoundary = true; // start-of-string counts as a boundary
  for (let si = 0; si < s.length && qi < q.length; si++) {
    const ch = s[si];
    const isBoundary = prevBoundary || ch === '-' || ch === '_' || ch === '/' || ch === '.' || ch === ' ';
    if (ch === q[qi]) {
      if (firstHit === -1) firstHit = si;
      if (isBoundary) boundaryHits++;
      qi++;
    }
    // A separator makes the NEXT char a boundary; a non-separator clears it.
    prevBoundary = ch === '-' || ch === '_' || ch === '/' || ch === '.' || ch === ' ';
  }
  if (qi < q.length) return -Infinity; // not a subsequence

  let sc = 0;
  if (s.startsWith(q)) sc += 1000;          // exact prefix — strongest signal
  sc += boundaryHits * 50;                  // word-boundary alignment
  sc += Math.max(0, 100 - s.length);        // brevity bonus
  sc += Math.max(0, 50 - firstHit);         // earlier first match
  return sc;
};

/**
 * Filter + rank candidates against a query. Stable for ties (preserves
 * input order), so callers can pre-sort by recency/relevance and have it
 * survive an empty query.
 *
 * @param {Candidate[]} candidates
 * @param {string} query
 * @param {number} [limit]      max results (default 50)
 * @returns {Candidate[]}
 */
export const filterCandidates = (candidates, query, limit = 50) => {
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = list
    .map((candidate, originalIndex) => ({
      candidate,
      matchScore: score(query, candidate.label),
      originalIndex,
    }))
    .filter((entry) => entry.matchScore !== -Infinity);
  // Sort by score desc, then original index asc (stable tie-break).
  scored.sort((a, b) => (b.matchScore - a.matchScore) || (a.originalIndex - b.originalIndex));
  return scored.slice(0, limit).map((entry) => entry.candidate);
};
