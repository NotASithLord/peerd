// @ts-check
// Minimal in-browser test framework. ~120 lines, no dependencies.
//
// Nesting: describe blocks form a tree; tests within a block run in
// declaration order. Both sync and async tests are supported.
//
// We deliberately do NOT ship a Jest/Vitest-shaped API. The matchers
// here are just enough to write clear tests; add a matcher when a real
// test would be unclear without it, not before.
//
// The framework, the test files, and production code all run in the
// same browser runtime as the extension itself — there is no jsdom
// approximation, no Node toolchain. Open tests/runner.html in a tab.

/**
 * @typedef {object} Test
 * @property {string} name
 * @property {() => void | Promise<void>} fn
 */

/**
 * @typedef {object} Suite
 * @property {string} name
 * @property {Test[]} tests
 * @property {Suite[]} children
 * @property {Suite | null} parent
 */

/**
 * @typedef {object} TestResult
 * @property {string} name
 * @property {boolean} pass
 * @property {number} ms
 * @property {{ name: string, message: string, details?: unknown, stack?: string }} [error]
 */

/**
 * @typedef {object} SuiteResult
 * @property {string} name
 * @property {TestResult[]} tests
 * @property {SuiteResult[]} children
 */

/** @type {Suite[]} */
const suites = [];
/** @type {Suite | null} */
let current = null;

/**
 * @param {string} name
 * @param {() => void} body
 */
export const describe = (name, body) => {
  /** @type {Suite} */
  const suite = { name, tests: [], children: [], parent: current };
  (current ? current.children : suites).push(suite);
  const prev = current;
  current = suite;
  try { body(); }
  finally { current = prev; }
};

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
export const it = (name, fn) => {
  if (!current) throw new Error('it() must be inside a describe()');
  current.tests.push({ name, fn });
};

/**
 * Deep structural equality for plain data. Handles arrays, plain
 * objects, primitives, Uint8Arrays. No cycles, no Map/Set support —
 * the test code doesn't deal in those shapes.
 */
/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export const eq = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    const ao = /** @type {Record<string, unknown>} */ (a);
    const bo = /** @type {Record<string, unknown>} */ (b);
    return ak.every(k => eq(ao[k], bo[k]));
  }
  return false;
};

class AssertionError extends Error {
  /** @param {Record<string, unknown>} details */
  constructor(details) {
    super('Assertion failed');
    this.name = 'AssertionError';
    /** @type {Record<string, unknown>} */
    this.details = details;
  }
}

/** @param {any} actual */
export const expect = (actual) => ({
  /** @param {unknown} expected */
  toBe: (expected) => {
    if (actual !== expected) throw new AssertionError({ op: 'toBe', actual, expected });
  },
  /** @param {unknown} expected */
  toEqual: (expected) => {
    if (!eq(actual, expected)) throw new AssertionError({ op: 'toEqual', actual, expected });
  },
  toBeTruthy: () => {
    if (!actual) throw new AssertionError({ op: 'toBeTruthy', actual });
  },
  toBeFalsy: () => {
    if (actual) throw new AssertionError({ op: 'toBeFalsy', actual });
  },
  /** @param {unknown} item */
  toContain: (item) => {
    const ok = Array.isArray(actual) ? actual.includes(item)
      : actual instanceof Set ? actual.has(item)
      : typeof actual === 'string' ? actual.includes(/** @type {string} */ (item))
      : false;
    if (!ok) throw new AssertionError({ op: 'toContain', actual, item });
  },
  /** @param {number} n */
  toBeGreaterThan: (n) => {
    if (!(actual > n)) throw new AssertionError({ op: 'toBeGreaterThan', actual, n });
  },
  /** @param {number} n */
  toBeLessThan: (n) => {
    if (!(actual < n)) throw new AssertionError({ op: 'toBeLessThan', actual, n });
  },
  /**
   * `actual` is a 0-arg sync-or-async function. Optionally pass a
   * predicate that validates the thrown error.
   * @param {(err: any) => boolean} [matcher]
   */
  toThrow: async (matcher) => {
    let threw = false;
    /** @type {any} */
    let err = null;
    try { await actual(); }
    catch (e) { threw = true; err = e; }
    if (!threw) {
      throw new AssertionError({ op: 'toThrow', expected: 'function to throw, did not' });
    }
    if (matcher && !matcher(err)) {
      throw new AssertionError({
        op: 'toThrow',
        errorName: err?.name,
        errorMessage: err?.message,
        expected: 'matching predicate',
      });
    }
  },
});

/**
 * Run collected suites. `only` and sharding are runner controls, not test
 * semantics; each selected test still gets the same fresh page-global state.
 * @param {(name: string) => void} [onTestStart]
 * @param {{ only?: string, shardIndex?: number, shardCount?: number }} [options]
 */
export const run = async (onTestStart = () => {}, options = {}) => {
  const only = options.only ?? '';
  const shardIndex = options.shardIndex ?? 0;
  const shardCount = options.shardCount ?? 1;
  const selectors = only.split(',').map((value) => value.trim()).filter(Boolean);
  /** @param {string} fullName */
  const selected = (fullName) => selectors.length === 0
    || selectors.some((selector) => fullName.includes(selector));
  /** @type {SuiteResult[]} */
  const results = [];
  for (const [index, suite] of suites.entries()) {
    // why: suites can deliberately share setup across their tests. Sharding a
    // suite's individual tests would change those semantics, so the root suite
    // is the smallest parallel unit.
    if (index % shardCount !== shardIndex) continue;
    results.push(await runSuite(suite, onTestStart, [], selected));
  }
  return results;
};

/** @returns {number} */
export const countTests = () => {
  /** @param {Suite} suite @returns {number} */
  const countSuite = (suite) => suite.tests.length
    + suite.children.reduce((total, child) => total + countSuite(child), 0);
  return suites.reduce((total, suite) => total + countSuite(suite), 0);
};

// why: a test can finish with requestAnimationFrame or setTimeout(0) work
// still pending (a scheduled focus restore, a queued redraw). Component code
// schedules these at module level, so they outlive the test's unmount, and
// without a drain they fire DURING the next test and mutate its DOM. That is
// the cross-test flake class: it reproduces only when a callback lands in
// exactly the wrong later test, which under CI load it eventually does. One
// macrotask turn drains timer work; one frame tick then flushes every rAF
// callback the test registered (rAF callbacks run in registration order)
// while the finished test's DOM is still the current one. A callback that
// chains a FURTHER rAF from inside a frame is not covered: one frame per
// test is the cost ceiling (a second tick measurably doubled the suite),
// so deferred effects that chain must precondition-check when they fire,
// as focusLibraryAction does. The cap bounds the wait where frames are
// throttled or absent; a callback the browser has not delivered by then
// was equally undeliverable mid-test.
const drainDeferredWork = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  if (typeof requestAnimationFrame !== 'function') return;
  await Promise.race([
    new Promise((resolve) => { requestAnimationFrame(() => resolve(undefined)); }),
    new Promise((resolve) => { setTimeout(resolve, 50); }),
  ]);
};

/**
 * @param {Suite} suite
 * @param {(name: string) => void} onTestStart
 * @param {string[]} parents
 * @param {(fullName: string) => boolean} selected
 * @returns {Promise<SuiteResult>}
 */
const runSuite = async (suite, onTestStart, parents, selected) => {
  /** @type {SuiteResult} */
  const out = { name: suite.name, tests: [], children: [] };
  for (const t of suite.tests) {
    const fullName = [...parents, suite.name, t.name].join(' > ');
    if (!selected(fullName)) continue;
    onTestStart(fullName);
    const start = performance.now();
    try {
      await t.fn();
      out.tests.push({ name: t.name, pass: true, ms: performance.now() - start });
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string, details?: unknown, stack?: string }} */ (e);
      out.tests.push({
        name: t.name,
        pass: false,
        ms: performance.now() - start,
        error: {
          name: err?.name ?? 'Error',
          message: err?.message ?? String(e),
          details: err?.details,
          stack: err?.stack,
        },
      });
    }
    await drainDeferredWork();
  }
  const nextParents = [...parents, suite.name];
  for (const c of suite.children) out.children.push(await runSuite(c, onTestStart, nextParents, selected));
  return out;
};

/**
 * Walk the result tree and tally pass/fail counts.
 * @param {SuiteResult[]} results
 */
export const summarize = (results) => {
  let passed = 0, failed = 0;
  /** @param {SuiteResult} node */
  const walk = (node) => {
    for (const t of node.tests) (t.pass ? passed++ : failed++);
    for (const c of node.children) walk(c);
  };
  for (const r of results) walk(r);
  return { passed, failed };
};
