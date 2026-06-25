// @ts-check
// notebook-tab/notebook-std.js — `peerd:std`, the Notebook standard library.
//
// Imported EXPLICITLY in Notebook code — `import { table, chart, mean } from
// 'peerd:std'`. The module resolver maps the bare `peerd:std` specifier to this
// file (see makeResolverDeps in notebook-tab.js + the `builtins` map in
// module-resolver.js). why explicit and not an injected global: in peerd,
// dependencies are visible imports you can see and delete, never magic ambient
// names (the spirit of DECISIONS #21 — and the owner's call, 2026-06-15).
//
// This module runs INSIDE the Notebook worker, which has NO DOM. So the display
// helpers (table/chart) are PURE — they return display DESCRIPTORS (plain data)
// that the page-side renderer (output-render.js, which has `document`) turns
// into a table or an SVG. Everything here is a pure function: no I/O, no
// globals, no input mutation — which is what keeps Notebook runs reproducible
// (DECISIONS #24). A run displays a value by RETURNING it, or via
// peerd.self.display(value) for more than one output.

// ── display helpers — return descriptors the output pane renders ──────────

/**
 * Render an array of row objects as a table. `rows` is an array of plain
 * objects; columns are the union of their keys.
 * @param {unknown} rows
 */
export const table = (rows) => ({
  __peerd_display: 'table',
  rows: Array.isArray(rows) ? rows : [],
});

/**
 * Render a chart (SVG, built page-side). `spec`:
 *   type   'bar' | 'line' | 'scatter'   (default 'bar')
 *   data   array of row objects, OR array of numbers (plotted vs index),
 *          OR array of [x, y] pairs
 *   x, y   key names when `data` is row objects (default: first two keys)
 *   title  optional heading
 * @param {{ type?: string, data?: unknown, x?: unknown, y?: unknown, title?: unknown }} [spec]
 */
export const chart = (spec = {}) => ({
  __peerd_display: 'chart',
  type: typeof spec.type === 'string' && ['bar', 'line', 'scatter'].includes(spec.type) ? spec.type : 'bar',
  data: Array.isArray(spec.data) ? spec.data : [],
  x: spec.x ?? null,
  y: spec.y ?? null,
  title: typeof spec.title === 'string' ? spec.title : null,
});

// ── data helpers — pure, dependency-free ──────────────────────────────────

/** @param {unknown} xs @returns {number[]} */
const nums = (xs) => /** @type {number[]} */ ((Array.isArray(xs) ? xs : []).filter((v) => typeof v === 'number' && Number.isFinite(v)));

/** @param {unknown} xs */
export const sum = (xs) => nums(xs).reduce((a, b) => a + b, 0);

/** @param {unknown} xs */
export const mean = (xs) => { const n = nums(xs); return n.length ? sum(n) / n.length : NaN; };

/** @param {unknown} xs */
export const median = (xs) => {
  const n = nums(xs).slice().sort((a, b) => a - b);
  if (!n.length) return NaN;
  const mid = Math.floor(n.length / 2);
  return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
};

/** @param {unknown} xs */
export const min = (xs) => { const n = nums(xs); return n.length ? Math.min(...n) : NaN; };

/** @param {unknown} xs */
export const max = (xs) => { const n = nums(xs); return n.length ? Math.max(...n) : NaN; };

/** @param {number} x @param {number} [dp] */
export const round = (x, dp = 0) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/**
 * range(n) → 0..n-1; range(a, b[, step]) → a, a+step, … up to (not incl.) b.
 * @param {number} start @param {number} [end] @param {number} [step]
 */
export const range = (start, end, step = 1) => {
  const [a, b] = end === undefined ? [0, start] : [start, end];
  if (step === 0 || (b - a) * step <= 0) return [];
  const len = Math.ceil((b - a) / step);
  return Array.from({ length: len }, (_, i) => a + i * step);
};

/** @param {unknown} xs */
export const unique = (xs) => [...new Set(Array.isArray(xs) ? xs : [])];

// why any: the *By helpers accept arbitrary row objects and a string key or a
// key-fn; the property read x?.[key] is dynamic by design.
/**
 * @typedef {string | ((x: any) => any)} KeySpec a property name or accessor fn.
 */

/**
 * Group items by a key (string) or key-fn. Returns { groupKey: items[] }.
 * @param {unknown} xs @param {KeySpec} key
 */
export const groupBy = (xs, key) => {
  const accessor = typeof key === 'function' ? key : (/** @type {any} */ x) => x?.[key];
  /** @type {Record<string, any[]>} */
  const out = {};
  for (const x of (Array.isArray(xs) ? xs : [])) {
    const k = accessor(x);
    (out[k] ??= []).push(x);
  }
  return out;
};

/**
 * Stable sort by a key (string) or key-fn; does not mutate the input.
 * @param {unknown} xs @param {KeySpec} key
 */
export const sortBy = (xs, key) => {
  const accessor = typeof key === 'function' ? key : (/** @type {any} */ x) => x?.[key];
  return (Array.isArray(xs) ? xs : []).slice().sort((a, b) => {
    const ka = accessor(a);
    const kb = accessor(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
};

// keyOf: a string key reads a property; a function IS the accessor. Shared by
// the *By helpers below (groupBy/sortBy above predate it and inline their own).
/** @param {KeySpec} key @returns {(x: any) => any} */
const keyOf = (key) => (typeof key === 'function' ? key : (x) => x?.[key]);

/**
 * Clamp x into [lo, hi]. The single most hand-rolled (and mis-ordered) line.
 * @param {number} x @param {number} lo @param {number} hi
 */
export const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Variance of the finite numbers in `xs`. POPULATION by default (÷n); pass
 * { sample: true } for the sample/unbiased estimate (÷n−1). NaN when there
 * aren't enough points (1 for population, 2 for sample). why the flag: the
 * population-vs-sample mixup is the classic stats wrong-answer.
 */
/** @param {unknown} xs @param {{ sample?: boolean }} [opts] */
export const variance = (xs, { sample = false } = {}) => {
  const n = nums(xs);
  if (n.length < (sample ? 2 : 1)) return NaN;
  const m = sum(n) / n.length;
  const ss = n.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return ss / (n.length - (sample ? 1 : 0));
};

/** Standard deviation — √variance, same { sample } option.
 * @param {unknown} xs @param {{ sample?: boolean }} [opts] */
export const stdev = (xs, opts) => Math.sqrt(variance(xs, opts));

/**
 * The q-quantile (0 ≤ q ≤ 1) of `xs`, linearly interpolated between ranks
 * (the NumPy/Excel default). quantile(xs, 0.5) === median; 0.25/0.75 give the
 * quartiles. why a real impl: nearest-rank "just index at q·n" is off by one at
 * the edges and skips interpolation — a subtly wrong percentile.
 */
/** @param {unknown} xs @param {number} q */
export const quantile = (xs, q) => {
  const n = nums(xs).slice().sort((a, b) => a - b);
  if (!n.length) return NaN;
  const pos = (n.length - 1) * clamp(q, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? n[lo] : n[lo] + (n[hi] - n[lo]) * (pos - lo);
};

/** Most-frequent value (ties → first seen). Works on any value, not just numbers.
 * @param {unknown} xs */
export const mode = (xs) => {
  /** @type {Map<any, number>} */
  const counts = new Map();
  let best;
  let bestN = 0;
  for (const x of (Array.isArray(xs) ? xs : [])) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    if (c > bestN) { bestN = c; best = x; }
  }
  return best;
};

/** Sum of a key (string) or key-fn over rows — groupBy's natural partner.
 * @param {unknown} xs @param {KeySpec} key */
export const sumBy = (xs, key) => sum((Array.isArray(xs) ? xs : []).map(keyOf(key)));

/** Mean of a key (string) or key-fn over rows.
 * @param {unknown} xs @param {KeySpec} key */
export const meanBy = (xs, key) => mean((Array.isArray(xs) ? xs : []).map(keyOf(key)));

/** Histogram: count rows per key (string) or key-fn. Returns { key: count }.
 * @param {unknown} xs @param {KeySpec} key */
export const countBy = (xs, key) => {
  const accessor = keyOf(key);
  /** @type {Record<string, number>} */
  const out = {};
  for (const x of (Array.isArray(xs) ? xs : [])) {
    const k = accessor(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

/** Index rows by a key (string) or key-fn → { key: row }. Last write wins.
 * @param {unknown} xs @param {KeySpec} key */
export const keyBy = (xs, key) => {
  const accessor = keyOf(key);
  /** @type {Record<string, any>} */
  const out = {};
  for (const x of (Array.isArray(xs) ? xs : [])) out[accessor(x)] = x;
  return out;
};

// ── array reshaping — pure, dependency-free ───────────────────────────────

/** Split into consecutive chunks of `size` (last is short). chunk([1,2,3], 2) → [[1,2],[3]].
 * @param {unknown} xs @param {number} size */
export const chunk = (xs, size) => {
  const arr = Array.isArray(xs) ? xs : [];
  const n = Math.max(1, Math.floor(size));
  return range(0, arr.length, n).map((i) => arr.slice(i, i + n));
};

/** Zip arrays elementwise, truncating to the shortest. zip([1,2],[a,b]) → [[1,a],[2,b]].
 * @param {...unknown} arrays */
export const zip = (...arrays) => {
  const lists = arrays.map((a) => (Array.isArray(a) ? a : []));
  const len = lists.length ? Math.min(...lists.map((a) => a.length)) : 0;
  return range(len).map((i) => lists.map((a) => a[i]));
};

/** Split into [pass, fail] by a predicate, in one pass.
 * @param {unknown} xs @param {(x: any) => unknown} predicate */
export const partition = (xs, predicate) => {
  /** @type {any[]} */
  const pass = [];
  /** @type {any[]} */
  const fail = [];
  for (const x of (Array.isArray(xs) ? xs : [])) (predicate(x) ? pass : fail).push(x);
  return [pass, fail];
};

// ── line-delimited records (JSONL) — pure, dependency-free ────────────────
// why: the natural on-disk shape for a growing record set — an append-only log,
// or a harvested index in OPFS — is JSONL: one JSON object per line. These
// round-trip it with no parser dependency (parseJsonl(toJsonl(rows)) deep-equals
// rows), and dedupeBy is the idempotent append-merge partner.

/**
 * Parse JSONL text into an array of values — one per non-blank line. Blank /
 * whitespace-only lines AND any line that is not valid JSON are SKIPPED, so a
 * trailing newline or a half-written final line never breaks a read. (For strict
 * parsing, split on newlines and JSON.parse yourself.) Non-string → [].
 * @param {unknown} text @returns {any[]}
 */
export const parseJsonl = (text) => {
  if (typeof text !== 'string') return [];
  /** @type {any[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a non-JSON line */ }
  }
  return out;
};

/**
 * Serialize an array of values to JSONL — one JSON line each, newline-joined
 * (no trailing newline). The inverse of parseJsonl. Non-array → ''.
 * @param {unknown} rows @returns {string}
 */
export const toJsonl = (rows) =>
  (Array.isArray(rows) ? rows : []).map((r) => JSON.stringify(r)).join('\n');

/**
 * Drop duplicate rows by a key (string) or key-fn, keeping the FIRST occurrence
 * (stable order). The append-merge partner: dedupeBy([...existing, ...fresh],
 * 'id') is an idempotent upsert that keeps the existing row. (keyBy is the
 * last-wins, object-valued cousin; unique is for primitives.)
 * @param {unknown} xs @param {KeySpec} key
 */
export const dedupeBy = (xs, key) => {
  const accessor = keyOf(key);
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const x of (Array.isArray(xs) ? xs : [])) {
    const k = accessor(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
};

// ── exact integer / ratio math — BigInt in, exact value out ───────────────
// why: every helper above takes Number, so feeding one a BigInt collapses it to
// a lossy 53-bit float — the precision footgun called out in JS_PITFALLS_NOTE.
// These keep large-integer and ratio math EXACT: no value ever round-trips
// through a float. Reach for them instead of hand-rolling the scale-and-divide
// dance (the bug that turns a correct .8̄ into a wrong .9).

// Accept a BigInt, an integer Number, or an all-digits string — but REJECT a
// float (3.5): a non-integer input means precision is already gone, so the
// exact helpers refuse it loudly rather than silently lie.
/** @param {unknown} x @returns {bigint} */
const toBigInt = (x) => {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' && Number.isInteger(x)) return BigInt(x);
  if (typeof x === 'string' && /^[+-]?\d+$/.test(x.trim())) return BigInt(x.trim());
  throw new TypeError(`expected an integer or BigInt, got ${typeof x}: ${x}`);
};

/**
 * Exact integer division. Returns { quotient, remainder } as BigInts, with the
 * same truncate-toward-zero / sign-of-dividend rule as BigInt `/` and `%`. Use
 * this instead of Number(a) / Number(b) whenever a or b can exceed 2**53.
 *   divmod(8944394323791464n, 9n) → { quotient: 993821591532384n, remainder: 8n }
 */
/** @param {unknown} a @param {unknown} b */
export const divmod = (a, b) => {
  const x = toBigInt(a);
  const y = toBigInt(b);
  if (y === 0n) throw new RangeError('divmod: division by zero');
  return { quotient: x / y, remainder: x % y };
};

/**
 * Exact decimal expansion of a / b as a STRING, to `places` fractional digits
 * (default 20). TRUNCATES rather than rounds, so every digit shown is genuinely
 * correct — a true prefix of the real value, never floated. Trailing zeros are
 * trimmed.
 *   divDecimal(1n, 3n)                  → '0.33333333333333333333'
 *   divDecimal(8944394323791464n, 9n)   → '993821591532384.88888888888888888888'
 *   divDecimal(4n, 2n)                  → '2'
 */
/** @param {unknown} a @param {unknown} b @param {number} [places] */
export const divDecimal = (a, b, places = 20) => {
  const x = toBigInt(a);
  const y = toBigInt(b);
  if (y === 0n) throw new RangeError('divDecimal: division by zero');
  const negative = (x < 0n) !== (y < 0n);
  const ax = x < 0n ? -x : x;
  const ay = y < 0n ? -y : y;
  const intPart = ax / ay;
  const rem = ax % ay;
  const sign = negative && (intPart !== 0n || rem !== 0n) ? '-' : '';
  const digits = Math.trunc(places);
  if (digits <= 0 || rem === 0n) return `${sign}${intPart}`;
  // why scale-then-divide: (rem * 10^digits) / ay shifts `digits` fractional
  // places into the integer range, so the division stays exact in BigInt.
  const fracScaled = (rem * 10n ** BigInt(digits)) / ay;
  const frac = fracScaled.toString().padStart(digits, '0').replace(/0+$/, '');
  return frac ? `${sign}${intPart}.${frac}` : `${sign}${intPart}`;
};

/** Greatest common divisor as a non-negative BigInt (Euclid). gcd(12, 18) → 6n.
 * @param {unknown} a @param {unknown} b */
export const gcd = (a, b) => {
  let x = toBigInt(a);
  let y = toBigInt(b);
  x = x < 0n ? -x : x;
  y = y < 0n ? -y : y;
  while (y) { [x, y] = [y, x % y]; }
  return x;
};

/** Least common multiple as a non-negative BigInt; 0n if either input is 0.
 * @param {unknown} a @param {unknown} b */
export const lcm = (a, b) => {
  const x = toBigInt(a);
  const y = toBigInt(b);
  if (x === 0n || y === 0n) return 0n;
  const ax = x < 0n ? -x : x;
  const ay = y < 0n ? -y : y;
  // why divide first: (ax / gcd) * ay stays smaller than ax * ay, but is exact
  // because gcd divides ax evenly.
  return (ax / gcd(ax, ay)) * ay;
};

/** n! as an EXACT BigInt (no float overflow past 170!). Throws on a negative n.
 * @param {unknown} n */
export const factorial = (n) => {
  const x = toBigInt(n);
  if (x < 0n) throw new RangeError('factorial: negative input');
  let result = 1n;
  // why a BigInt counting loop (not range().reduce): range is Number-based and
  // would overflow for the very inputs factorial exists to handle.
  for (let i = 2n; i <= x; i++) result *= i;
  return result;
};

/**
 * Modular exponentiation: (base ** exp) mod m, EXACT for any size via
 * square-and-multiply — never materializes the (astronomically large) full
 * power. Positive modulus, non-negative exponent.
 */
/** @param {unknown} base @param {unknown} exp @param {unknown} mod */
export const modpow = (base, exp, mod) => {
  let b = toBigInt(base);
  let e = toBigInt(exp);
  const m = toBigInt(mod);
  if (m <= 0n) throw new RangeError('modpow: modulus must be positive');
  if (e < 0n) throw new RangeError('modpow: negative exponent');
  if (m === 1n) return 0n;
  let result = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
};
