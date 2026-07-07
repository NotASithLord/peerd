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
