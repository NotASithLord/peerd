// @ts-check
// Test runner entry point.
//
// Loads the test manifest, runs every collected suite, and renders the
// result tree into the page. Refresh the page to re-run.
//
// CI mode: append `?ci=1` to the URL. The runner writes a single
// `__TEST_RESULT__ {json}` line to a hidden <pre>, which the headless
// harness (scripts/cdp/run-inbrowser-tests.mjs) scrapes over CDP. The
// harness exits non-zero on any failure.

// why: runner.html always defines these elements; assert non-null so the
// render/CI-marker writes below typecheck without scattering null guards.
const summaryEl = /** @type {HTMLElement} */ (document.getElementById('summary'));
const resultsEl = /** @type {HTMLElement} */ (document.getElementById('results'));
const ciMarker = /** @type {HTMLElement} */ (document.getElementById('ci-marker'));
const search = new URLSearchParams(location.search);
const isCI = search.has('ci');
const only = search.get('only') ?? '';
const shardMatch = /^(\d+)\/(\d+)$/.exec(search.get('shard') ?? '1/1');
const shardNumber = Number(shardMatch?.[1] ?? 1);
const shardCount = Number(shardMatch?.[2] ?? 1);
const validShard = shardMatch !== null
  && Number.isInteger(shardNumber) && Number.isInteger(shardCount)
  && shardNumber >= 1 && shardNumber <= shardCount;

(async () => {
  if (!validShard) throw new Error('shard must use the form N/TOTAL with 1 <= N <= TOTAL');
  // Dynamic imports keep module-graph failures inside this catch. With static
  // imports, a Firefox-only parse or load error happens before the runner body
  // exists and CI waits on a page that says only "Loading...".
  await import('./index.js');   // pulls in every *.test.js file by side effect
  const { run, summarize, countTests } = await import('./framework.js');
  const total = countTests();
  const t0 = performance.now();
  /** @type {string[]} */
  const started = [];
  const results = await run((name) => {
    started.push(name);
    if (started.length > 30) started.shift();
    summaryEl.dataset.testHistory = JSON.stringify(started);
    summaryEl.textContent = `Running: ${name}`;
  }, { only, shardIndex: shardNumber - 1, shardCount });
  const elapsed = performance.now() - t0;
  const { passed, failed } = summarize(results);

  summaryEl.textContent = `${passed} passed, ${failed} failed — ${elapsed.toFixed(0)}ms`;
  summaryEl.classList.toggle('fail', failed > 0);

  resultsEl.replaceChildren(...results.map(renderSuite));

  if (isCI) {
    ciMarker.textContent = `__TEST_RESULT__ ${JSON.stringify({
      passed, failed, total, shardNumber, shardCount, ms: Math.round(elapsed),
    })}`;
  }
})().catch((e) => {
  const message = e?.message ?? String(e);
  summaryEl.textContent = `Runner crashed: ${message}`;
  summaryEl.classList.add('fail');
  if (isCI) {
    ciMarker.textContent = `__TEST_RESULT__ ${JSON.stringify({
      passed: 0, failed: 1, ms: 0, crash: message,
    })}`;
  }
  console.error(e);
});

/**
 * @param {import('./framework.js').SuiteResult} suite
 * @param {number} [depth]
 */
function renderSuite(suite, depth = 0) {
  const node = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'suite-name';
  heading.textContent = suite.name;
  node.appendChild(heading);

  const list = document.createElement('ul');
  for (const t of suite.tests) list.appendChild(renderTest(t));
  for (const c of suite.children) list.appendChild(renderSuite(c, depth + 1));
  node.appendChild(list);
  return node;
}

/** @param {import('./framework.js').TestResult} t */
function renderTest(t) {
  const li = document.createElement('li');
  li.className = `test ${t.pass ? 'pass' : 'fail'}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = t.pass ? '✓' : '✗';
  const name = document.createElement('span');
  name.textContent = t.name;
  const ms = document.createElement('span');
  ms.className = 'ms';
  ms.textContent = ` (${Math.round(t.ms)}ms)`;
  li.append(icon, name, ms);

  // why: a failed test always carries `error` (set together in runSuite),
  // so guarding on `t.error` is equivalent to `!t.pass` here and lets TS
  // narrow the optional field for the field accesses below.
  if (!t.pass && t.error) {
    const err = t.error;
    const det = document.createElement('details');
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = `${err.name}: ${err.message}`;
    det.appendChild(sum);
    if (err.details) {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(err.details, null, 2);
      det.appendChild(pre);
    }
    if (err.stack) {
      const pre = document.createElement('pre');
      pre.textContent = err.stack;
      det.appendChild(pre);
    }
    li.appendChild(det);
  }
  return li;
}
