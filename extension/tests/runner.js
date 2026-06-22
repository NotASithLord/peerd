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

import './index.js';   // pulls in every *.test.js file by side effect
import { run, summarize } from './framework.js';

// why: runner.html always defines these elements; assert non-null so the
// render/CI-marker writes below typecheck without scattering null guards.
const summaryEl = /** @type {HTMLElement} */ (document.getElementById('summary'));
const resultsEl = /** @type {HTMLElement} */ (document.getElementById('results'));
const ciMarker = /** @type {HTMLElement} */ (document.getElementById('ci-marker'));
const isCI = new URLSearchParams(location.search).has('ci');

(async () => {
  const t0 = performance.now();
  const results = await run();
  const elapsed = performance.now() - t0;
  const { passed, failed } = summarize(results);

  summaryEl.textContent = `${passed} passed, ${failed} failed — ${elapsed.toFixed(0)}ms`;
  summaryEl.classList.toggle('fail', failed > 0);

  resultsEl.replaceChildren(...results.map(renderSuite));

  if (isCI) {
    ciMarker.textContent = `__TEST_RESULT__ ${JSON.stringify({ passed, failed, ms: Math.round(elapsed) })}`;
  }
})().catch((e) => {
  summaryEl.textContent = `Runner crashed: ${e?.message ?? e}`;
  summaryEl.classList.add('fail');
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
