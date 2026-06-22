// @ts-check
// Clock primitives — pure time math.
//
// Every other clock file builds on these three. No Chrome APIs here;
// the only dep is Date. The clock injects its time source (`now`)
// through DI so tests can advance a fake clock without waiting on real
// wall time.
//
// formatDelta is the workhorse — it produces the compact "47s" /
// "22m" / "1h2m" / "3d" strings the temporal block renders. The format
// is deliberately one-or-two-units, no decimals: "5m 17s" is clutter
// where "5m" is enough.

const MINUTE_MS = 60_000;
const HOUR_MS   = 60 * MINUTE_MS;
const DAY_MS    = 24 * HOUR_MS;

/**
 * Compact human-readable elapsed-time formatter.
 *
 * Format rules:
 *   - <1s   → "0s"
 *   - <60s  → "Ns"
 *   - <60m  → "Nm"
 *   - <24h  → "Nh" or "NhMm" when minutes are nonzero
 *   - >=24h → "Nd" or "NdMh" when hours are nonzero
 *
 * Negative inputs are clamped to 0. Non-finite inputs return "?".
 * Output never exceeds 6 characters at the >=24h tier in normal use
 * (the temporal block has a hard token cap which uses this).
 *
 * @param {number} ms
 * @returns {string}
 */
export const formatDelta = (ms) => {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 0) ms = 0;
  if (ms < 1_000) return '0s';
  if (ms < MINUTE_MS) return `${Math.floor(ms / 1_000)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) {
    const h = Math.floor(ms / HOUR_MS);
    const m = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return m === 0 ? `${h}h` : `${h}h${m}m`;
  }
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / HOUR_MS);
  return h === 0 ? `${d}d` : `${d}d${h}h`;
};

/**
 * ISO timestamp without fractional seconds. The temporal block's
 * <time>…</time> tag uses this — saves ~4 tokens vs the full ISO.
 *
 * Example: 2026-06-05T14:34:21Z
 *
 * @param {number} [ms]   ms since epoch; defaults to now()
 * @returns {string}
 */
export const isoSecondsZ = (ms) => {
  const d = new Date(ms ?? Date.now());
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/**
 * Parse a duration string like "47s", "5m", "1h30m" into ms.
 *
 * Accepts a small grammar: a sequence of <integer><unit> pairs where
 * unit ∈ {s, m, h, d}. Whitespace is allowed between pairs but not
 * within. Returns NaN for malformed input so callers can detect it.
 *
 * Example: "5m" → 300000; "1h30m" → 5400000; "47s" → 47000;
 *          "" → NaN; "5x" → NaN; "5" → NaN.
 *
 * @param {string} input
 * @returns {number}
 */
export const parseDuration = (input) => {
  if (typeof input !== 'string') return NaN;
  const s = input.trim();
  if (!s) return NaN;
  const re = /(\d+)\s*([smhd])/gi;
  let total = 0;
  let lastIndex = 0;
  let matchCount = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== lastIndex) return NaN;           // gap = junk between pairs
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return NaN;
    // why: the regex's [smhd] class guarantees `unit` is a key of the map,
    // so the lookup is never undefined — cast the index to the key union.
    const unit = /** @type {'s' | 'm' | 'h' | 'd'} */ (m[2].toLowerCase());
    total += n * ({ s: 1_000, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }[unit]);
    lastIndex = re.lastIndex;
    matchCount++;
    // Allow whitespace between pairs.
    while (s[lastIndex] === ' ') lastIndex++;
    re.lastIndex = lastIndex;
  }
  if (matchCount === 0 || lastIndex !== s.length) return NaN;
  return total;
};
