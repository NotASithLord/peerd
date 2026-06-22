// @ts-check
// Structured-review schema + parser/validator.
//
// The reviewer is a clean-context agent: it sees ONLY the diff, never the
// writer's conversation. Its job is to emit a STRUCTURED summary the
// parent can act on programmatically, not prose the parent has to re-read.
// So we constrain the contract on both ends:
//   - the reviewer system prompt (prompt.js) tells it to emit a fenced
//     ```json block matching this shape;
//   - parseReviewSummary() extracts + validates that block, coercing a
//     best-effort structure even when the model is sloppy.
//
// Functional core: every function here is pure (text in, value out). No
// IO, no model call. That's what makes the contract unit-testable in Bun
// without standing up the loop.

/**
 * @typedef {'critical' | 'high' | 'medium' | 'low' | 'info'} Severity
 *
 * critical  ships a security hole / data loss / breaks the build
 * high      a real bug that will bite under normal use
 * medium    a likely bug or a correctness gap in an edge case
 * low       smell, minor inefficiency, missing-but-not-load-bearing test
 * info      a note / question / suggestion, not a defect
 */

// why: a fixed, ordered set lets the parent SORT and THRESHOLD
// deterministically ("block on any high+", "auto-apply only low fixes").
// Lowercase one-token-per-peerd-convention; index = rank (0 worst).
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);

const SEVERITY_RANK = Object.freeze(
  Object.fromEntries(SEVERITIES.map((s, i) => [s, i])),
);

/**
 * @typedef {Object} ReviewIssue
 * @property {Severity} severity
 * @property {string} title        one-line summary
 * @property {string} [detail]     why it's a problem
 * @property {string} [location]   file:line or App/file path the diff touched
 * @property {string} [fix]        suggested fix (text or a patch snippet)
 */

/**
 * @typedef {Object} ReviewSummary
 * @property {'approve' | 'request_changes' | 'comment'} verdict
 * @property {Severity} severity        the WORST issue severity (or 'info' if none)
 * @property {ReviewIssue[]} issues
 * @property {string} [summary]         one-paragraph human gloss
 */

/**
 * Clamp an arbitrary value to a known severity; default 'info'.
 * @param {unknown} v
 * @returns {Severity}
 */
const coerceSeverity = (v) => (
  typeof v === 'string' && /** @type {readonly string[]} */ (SEVERITIES).includes(v)
    ? /** @type {Severity} */ (v)
    : 'info'
);

/**
 * The worst (lowest-rank) severity across issues; 'info' when empty.
 * @param {ReviewIssue[]} issues
 * @returns {Severity}
 */
export const worstSeverity = (issues) => {
  /** @type {Severity} */
  let worst = 'info';
  for (const it of issues) {
    if (SEVERITY_RANK[it.severity] < SEVERITY_RANK[worst]) worst = it.severity;
  }
  return worst;
};

/**
 * Extract the LAST fenced ```json block from model text. Last, not first:
 * a reasoning model often shows an example/scratch block before its real
 * answer, and the final block is the committed one. Falls back to the
 * whole string if there's no fence (some models emit bare JSON).
 *
 * @param {string} text
 * @returns {string | null}
 */
const extractJsonBlock = (text) => {
  if (typeof text !== 'string') return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let last = null;
  let m;
  while ((m = fence.exec(text)) !== null) last = m[1].trim();
  if (last) return last;
  // No fence — try the substring from the first { to the last }.
  const first = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (first !== -1 && end > first) return text.slice(first, end + 1);
  return null;
};

/**
 * Parse + validate a reviewer's raw output into a ReviewSummary.
 *
 * Tolerant by design: a clean-context reviewer is still a language model,
 * and a malformed block must NOT crash the parent's turn. On unparseable
 * input we return a well-formed summary that flags the parse failure as a
 * single 'info' issue, so the caller always gets the same shape.
 *
 * @param {string} raw   the reviewer's final assistant text
 * @returns {{ ok: boolean, summary: ReviewSummary, parseError?: string }}
 */
export const parseReviewSummary = (raw) => {
  const block = extractJsonBlock(raw);
  if (!block) {
    return {
      ok: false,
      parseError: 'no_json_block',
      summary: fallbackSummary('Reviewer returned no structured block.', raw),
    };
  }

  let obj;
  try {
    obj = JSON.parse(block);
  } catch (e) {
    return {
      ok: false,
      parseError: `json_parse: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
      summary: fallbackSummary('Reviewer block was not valid JSON.', raw),
    };
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return {
      ok: false,
      parseError: 'not_an_object',
      summary: fallbackSummary('Reviewer block was not a JSON object.', raw),
    };
  }

  const issues = Array.isArray(obj.issues)
    ? obj.issues
        .filter((/** @type {unknown} */ it) => it && typeof it === 'object')
        .map(normalizeIssue)
    : [];

  // Derive severity from the issues rather than trusting the model's
  // self-reported top-level field — keeps verdict/severity coherent.
  const severity = worstSeverity(issues);

  const verdict = normalizeVerdict(obj.verdict, severity);

  return {
    ok: true,
    summary: {
      verdict,
      severity,
      issues,
      ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
    },
  };
};

/** @param {Record<string, any>} it @returns {ReviewIssue} */
const normalizeIssue = (it) => {
  /** @type {ReviewIssue} */
  const out = {
    severity: coerceSeverity(it.severity),
    title: typeof it.title === 'string' && it.title.trim()
      ? it.title.trim()
      : '(untitled issue)',
  };
  if (typeof it.detail === 'string' && it.detail.trim()) out.detail = it.detail.trim();
  if (typeof it.location === 'string' && it.location.trim()) out.location = it.location.trim();
  if (typeof it.fix === 'string' && it.fix.trim()) out.fix = it.fix.trim();
  return out;
};

// why: if the reviewer omits a verdict, infer a safe one from severity —
// anything high+ requests changes, otherwise approve. Never silently
// approve when there's a critical/high finding.
/**
 * @param {unknown} v
 * @param {Severity} severity
 * @returns {ReviewSummary['verdict']}
 */
const normalizeVerdict = (v, severity) => {
  if (v === 'approve' || v === 'request_changes' || v === 'comment') {
    // Override an over-optimistic 'approve' when a high+ issue exists.
    if (v === 'approve' && SEVERITY_RANK[severity] <= SEVERITY_RANK.high) {
      return 'request_changes';
    }
    return v;
  }
  return SEVERITY_RANK[severity] <= SEVERITY_RANK.high ? 'request_changes' : 'approve';
};

/** @param {string} note @param {unknown} raw @returns {ReviewSummary} */
const fallbackSummary = (note, raw) => ({
  verdict: 'comment',
  severity: 'info',
  issues: [{
    severity: 'info',
    title: 'Reviewer output could not be parsed',
    detail: `${note} Raw output is preserved for inspection.`,
  }],
  summary: typeof raw === 'string' ? raw.slice(0, 2000) : '',
});
