// @ts-check
// tools/web/spill — pure windowing + paging for oversized fetched text.
//
// The old behavior silently sliced an oversized body at the budget: the model
// lost the tail (and never knew what it lost). Spill-and-page instead keeps
// the FULL text (the caller stores it) and shows a head+tail WINDOW plus a
// footer naming the exact paging call — so the model can decide whether the
// middle matters and read on deliberately. Head-heavy split because openings
// carry the thesis; the tail catches conclusions/footers (and proves to the
// model that content was elided in between).
//
// Pure functions, no IO — the fetch_url/read_web_cache tools own the store.

// 75/25 head/tail split of the window budget.
const HEAD_FRACTION = 0.75;

// The ONE spill-cache entry cap, shared by every spill store (the SW's web
// extract cache and the run cache) — a window onto recent oversized texts,
// not an archive. Lives here so the twins can't silently drift apart.
export const SPILL_CACHE_MAX_ENTRIES = 40;

/**
 * Window an oversized text: head + tail with an elision marker between.
 * Text at or under the budget is returned whole (windowed:false).
 *
 * @param {string} text
 * @param {number} budget  max chars the caller wants to show
 * @returns {{ windowed: boolean, window: string, headChars: number, tailChars: number, total: number }}
 */
export const windowText = (text, budget) => {
  const total = text.length;
  if (total <= budget) {
    return { windowed: false, window: text, headChars: total, tailChars: 0, total };
  }
  const headChars = Math.floor(budget * HEAD_FRACTION);
  const tailChars = budget - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(total - tailChars);
  const elided = total - headChars - tailChars;
  return {
    windowed: true,
    window: `${head}\n\n[… ${elided} characters elided — see the paging note below …]\n\n${tail}`,
    headChars,
    tailChars,
    total,
  };
};

/**
 * The paging footer — a TRUSTED, tool-authored instruction. It must ride
 * OUTSIDE the untrusted fence (page content must never be able to forge or
 * suppress it) and contain ONLY caller-computed values, never fetched bytes.
 *
 * @param {{ key: string, total: number, headChars: number, tailChars: number }} p
 * @returns {string}
 */
export const pagingFooter = ({ key, total, headChars, tailChars }) => [
  `[paging] The full text (${total} chars) is stored locally. You saw the first ${headChars} and last ${tailChars} chars.`,
  `To read more call read_web_cache with { "key": "${key}", "offset": <char offset>, "limit": <chars, max 16000> } — e.g. offset ${headChars} continues where the head stopped.`,
].join('\n');

/**
 * Page a stored text: a bounds-clamped slice + what remains.
 *
 * @param {string} text
 * @param {number} offset  start char (clamped to [0, length])
 * @param {number} limit   max chars to return (caller pre-clamps its own cap)
 * @returns {{ slice: string, offset: number, end: number, total: number, remaining: number }}
 */
export const pageSlice = (text, offset, limit) => {
  const total = text.length;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, total));
  const end = Math.min(start + Math.max(1, Math.floor(limit) || 1), total);
  return { slice: text.slice(start, end), offset: start, end, total, remaining: total - end };
};

// ── Query-relevant excerpting (BM25) ────────────────────────────────────────
// windowText's head+tail is query-BLIND: on a long page the answer is rarely in
// the first 75% + last 25% — it's in the one paragraph that matches what you
// asked. When the caller HAS a query (the subgoal it's reading the page for),
// excerptRelevant returns the passages that best match it, ranked by BM25 and
// reassembled in DOCUMENT order (so it still reads top-to-bottom) with elision
// markers where passages were dropped. Same spill contract: the FULL text is
// still stored and pageable — this just picks a better window to show first.
// Pure, no IO. Returns null when there's no usable query signal so the caller
// falls back to windowText.

// A tiny English stoplist — enough to keep common function words from
// dominating IDF on short queries. why not a big list: over-stemming/stopping
// hurts recall on proper nouns and short queries more than it helps.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'by', 'at', 'as', 'it', 'its', 'this', 'that', 'with',
  'from', 'what', 'which', 'how', 'who', 'when', 'where', 'find', 'get', 'show',
]);

/** @param {string} s @returns {string[]} lowercased alphanumeric tokens, stopword/1-char stripped */
const tokenize = (s) => (String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
  .filter((t) => t.length > 1 && !STOPWORDS.has(t));

/**
 * Split text into passage chunks on blank lines (markdown paragraphs), then
 * hard-split any chunk longer than maxChunk so one giant blob can't dominate.
 * Keeps the original order.
 * @param {string} text @param {number} maxChunk
 * @returns {string[]}
 */
const chunkPassages = (text, maxChunk) => {
  /** @type {string[]} */
  const out = [];
  for (const para of text.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= maxChunk) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += maxChunk) out.push(p.slice(i, i + maxChunk));
  }
  return out;
};

/**
 * BM25 score of each chunk against the query terms (Robertson/Spärck-Jones).
 * @param {string[][]} chunkTokens  pre-tokenized chunks
 * @param {string[]} queryTerms
 * @param {{ k1?: number, b?: number }} [opts]
 * @returns {number[]} one score per chunk (0 = no query term present)
 */
const bm25Scores = (chunkTokens, queryTerms, { k1 = 1.5, b = 0.75 } = {}) => {
  const N = chunkTokens.length;
  const lengths = chunkTokens.map((t) => t.length);
  const avgdl = lengths.reduce((s, l) => s + l, 0) / (N || 1) || 1;
  const uniqQuery = [...new Set(queryTerms)];
  // document frequency per query term
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const term of uniqQuery) {
    let d = 0;
    for (const toks of chunkTokens) if (toks.includes(term)) d++;
    df.set(term, d);
  }
  // idf with the +1 floor so a term in every chunk still scores ≥ 0
  /** @type {Map<string, number>} */
  const idf = new Map();
  for (const term of uniqQuery) {
    const d = df.get(term) || 0;
    idf.set(term, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  }
  return chunkTokens.map((toks, i) => {
    if (!toks.length) return 0;
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const term of uniqQuery) {
      const f = tf.get(term) || 0;
      if (!f) continue;
      const denom = f + k1 * (1 - b + (b * lengths[i]) / avgdl);
      score += (idf.get(term) || 0) * (f * (k1 + 1)) / denom;
    }
    return score;
  });
};

/**
 * Query-relevant excerpt of an oversized text. Returns the highest-BM25 passages
 * that fit the budget, reassembled in document order with elision markers.
 * Text at/under budget passes through whole. Returns NULL — signalling the
 * caller to fall back to windowText — when there is no usable query, fewer than
 * two passages, or no passage matches the query (all scores 0).
 *
 * @param {string} text
 * @param {string} query   what the caller is looking for on this page
 * @param {number} budget  max chars to show
 * @param {{ k1?: number, b?: number, maxChunk?: number }} [opts]
 * @returns {{ excerpted: boolean, excerpt: string, passagesShown: number, passagesTotal: number, charsShown: number, total: number } | null}
 */
export const excerptRelevant = (text, query, budget, opts = {}) => {
  const total = text.length;
  const queryTerms = tokenize(query || '');
  if (!queryTerms.length) return null;                       // no query → caller windows head/tail
  if (total <= budget) {
    return { excerpted: false, excerpt: text, passagesShown: 1, passagesTotal: 1, charsShown: total, total };
  }
  const maxChunk = Math.max(200, Math.min(opts.maxChunk ?? 1200, budget));
  const chunks = chunkPassages(text, maxChunk);
  if (chunks.length < 2) return null;                        // nothing to rank → fall back
  const chunkTokens = chunks.map(tokenize);
  const scores = bm25Scores(chunkTokens, queryTerms, opts);
  if (!scores.some((s) => s > 0)) return null;               // query matches nothing → fall back

  // Greedily take highest-scoring passages until the next won't fit; always
  // take at least the top one. Ties broken by earlier document position.
  const ranked = chunks
    .map((t, i) => ({ i, t, score: scores[i] }))
    .filter((c) => c.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const SEP = '\n\n';
  /** @type {{ i: number, t: string }[]} */
  const picked = [];
  let used = 0;
  for (const c of ranked) {
    const add = c.t.length + (picked.length ? SEP.length : 0);
    if (picked.length && used + add > budget) continue;      // skip; a later shorter one may still fit
    picked.push(c); used += add;
    if (used >= budget) break;
  }
  picked.sort((a, b) => a.i - b.i);                          // back into document order

  // Assemble in order; mark where passages were dropped between kept ones.
  const parts = [];
  if (picked[0].i > 0) parts.push(`[… ${picked[0].i} earlier passage(s) …]`);
  for (let k = 0; k < picked.length; k++) {
    parts.push(picked[k].t);
    const next = picked[k + 1];
    if (next) {
      const gap = next.i - picked[k].i - 1;
      if (gap > 0) parts.push(`[… ${gap} passage(s) …]`);
    }
  }
  const lastKept = picked[picked.length - 1].i;
  const trailing = chunks.length - 1 - lastKept;
  if (trailing > 0) parts.push(`[… ${trailing} later passage(s) …]`);

  return {
    excerpted: true,
    excerpt: parts.join('\n\n'),
    passagesShown: picked.length,
    passagesTotal: chunks.length,
    charsShown: used,
    total,
  };
};

/**
 * The paging footer for an EXCERPTED body — same trust rules as pagingFooter
 * (rides outside the untrusted fence, caller-computed values only). Tells the
 * model it saw the most-relevant passages, not a contiguous slice, and how to
 * read the rest.
 *
 * @param {{ key: string, total: number, passagesShown: number, passagesTotal: number, query: string }} p
 * @returns {string}
 */
export const excerptFooter = ({ key, total, passagesShown, passagesTotal, query }) => [
  `[paging] Showed the ${passagesShown} passage(s) most relevant to "${query}" (of ${passagesTotal}) from ${total} chars stored locally — NOT a contiguous slice.`,
  `To read the surrounding text or other sections call read_web_cache with { "key": "${key}", "offset": <char offset>, "limit": <chars, max 16000> }.`,
].join('\n');
