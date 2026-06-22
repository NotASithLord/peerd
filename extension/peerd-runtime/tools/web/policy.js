// @ts-check
// Web tool escalation heuristics.
//
// Pure functions. Inputs: an HTTP response status + body string + the
// caller's `expects` shape. Outputs: a boolean and a reason string.
//
// These run on the SW side after a safeFetch returns. If any of them
// says "escalate", the wrapper tool opens an inactive tab instead.
// Tests can exercise the heuristics directly without driving the
// browser.
//
// The heuristics are intentionally conservative — false positives
// (escalating when safeFetch would have worked) are cheap, false
// negatives (returning SPA-shell HTML to the model) are not. The
// model would then receive useless markup and waste tokens trying to
// parse it.

const SPA_TEXT_THRESHOLD = 200;     // <200 visible chars + a script tag → likely SPA
const ANTI_BOT_PATTERNS = [
  // Cloudflare challenge.
  /Just a moment\.\.\./i,
  /Checking your browser before accessing/i,
  /cf-browser-verification/i,
  /__cf_chl_/i,
  // Generic captcha shells.
  /g-recaptcha/i,
  /h-captcha/i,
  /hcaptcha\.com/i,
  // Akamai / Imperva / Datadome bot pages.
  /Pardon Our Interruption/i,
  /Access Denied/i,
  /Bot Manager/i,
  /datadome/i,
  // Cookie-wall / consent pages don't count as anti-bot per se but
  // they DO mean safeFetch returned content the user's session would
  // have skipped. Escalate to tab.
  /Cookie consent required/i,
];

/**
 * Crude SPA-shell detector. We strip scripts/styles, collapse
 * whitespace, count visible character length. If that count is under
 * the threshold AND the original body contained a <script> tag, we
 * call it a shell.
 *
 * This is deliberately content-naive: we don't try to parse
 * `<div id="root"></div>`-style fingerprints. The threshold catches
 * those AND legitimately small skeletons like "Loading…" splash pages.
 *
 * @param {string} body
 * @returns {boolean}
 */
export const looksLikeSpaShell = (body) => {
  if (typeof body !== 'string' || body.length === 0) return false;
  const hasScript = /<script[\s>]/i.test(body);
  if (!hasScript) return false;
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length < SPA_TEXT_THRESHOLD;
};

/**
 * Returns the first anti-bot pattern that matches the body, or null.
 * Returning the match (not just a boolean) lets the caller surface
 * which signature triggered the escalation in audit logs and tool
 * results.
 *
 * @param {string} body
 * @returns {string | null}
 */
export const matchesAntiBotTemplate = (body) => {
  if (typeof body !== 'string') return null;
  for (const re of ANTI_BOT_PATTERNS) {
    const m = body.match(re);
    if (m) return m[0];
  }
  return null;
};

/**
 * Validate that a fetched body contains every string in `expects`. We
 * keep `expects` deliberately simple for V1 — an array of required
 * substrings. Anything missing → escalate. JSON-schema-shaped
 * validation lands in V1.x when there's a real demand.
 *
 * Returns { ok: true } or { ok: false, missing: string[] }.
 *
 * @param {string} body
 * @param {string[] | undefined} expects
 * @returns {{ ok: true } | { ok: false, missing: string[] }}
 */
export const satisfiesExpects = (body, expects) => {
  if (!Array.isArray(expects) || expects.length === 0) return { ok: true };
  /** @type {string[]} */
  const missing = [];
  for (const needle of expects) {
    if (typeof needle !== 'string' || !needle) continue;
    if (!body.includes(needle)) missing.push(needle);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};

/**
 * Composes the three checks into a single escalation decision. The SW
 * wrappers call this; the result drives the inactive-tab fallback.
 *
 * @param {Object} args
 * @param {number} args.status        HTTP status from safeFetch
 * @param {string} args.body          response body
 * @param {string[]} [args.expects]   caller-supplied required substrings
 * @returns {{ escalate: false } | { escalate: true, reason: string }}
 */
export const shouldEscalate = ({ status, body, expects }) => {
  // 403/challenge/redirect-to-login patterns. 429 (rate-limited) is
  // also worth tab-escalating — the user's session may have a fresh
  // cookie that bypasses the limit.
  if (status === 403 || status === 429 || status === 503) {
    return { escalate: true, reason: `http_${status}` };
  }
  const antibot = matchesAntiBotTemplate(body);
  if (antibot) return { escalate: true, reason: `antibot:${antibot.slice(0, 40)}` };
  if (looksLikeSpaShell(body)) return { escalate: true, reason: 'spa_shell' };
  const expectsResult = satisfiesExpects(body, expects);
  if (!expectsResult.ok) {
    return { escalate: true, reason: `expects_missing:${expectsResult.missing.join(',')}` };
  }
  return { escalate: false };
};
