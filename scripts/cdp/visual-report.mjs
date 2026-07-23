#!/usr/bin/env bun
// Render scripts/cdp/artifacts/result.json as a markdown table.
//
// why a script and not inline JS in the workflow: both the job summary and the
// PR comment need this text, quoting a heredoc-inside-YAML-inside-shell is a
// trap, and this stays runnable locally (`bun scripts/cdp/visual-report.mjs`)
// when you want to know what the last run decided.
//
// Prints to stdout. Exits 0 even when states failed — the caller already knows
// the verdict from the test step; this is presentation only.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT = join(HERE, 'artifacts', 'result.json');

if (!existsSync(RESULT)) {
  console.log('_No `result.json` — the render step did not get far enough to produce one._');
  process.exit(0);
}

const report = JSON.parse(readFileSync(RESULT, 'utf8'));
const visuals = (report.states ?? []).flatMap((s) => s.visuals ?? []);

if (!visuals.length) {
  console.log('_No visual states ran._');
  process.exit(0);
}

const pct = (n) => `${(n * 100).toFixed(3)}%`;

console.log(`Chrome pin \`${readPin()}\` · platform \`${report.visual?.platform ?? 'unknown'}\``
  + `${report.visual?.gating === false ? ' · **informational only** (not the baseline authority)' : ''}`);
console.log('');
console.log('| state | verdict | changed pixels | allowed |');
console.log('|---|---|---|---|');
for (const v of visuals) {
  const passed = v.rawPass ?? v.pass;
  // A size change reads as 100% and produces NO diff image — call it out, or a
  // reviewer goes looking for a diff.png that was never written.
  const verdict = v.wrote ? 'baseline written'
    : passed ? 'unchanged'
      : v.ratio >= 1 ? '**CAPTURE SIZE CHANGED**'
        : '**changed**';
  console.log(`| \`${v.name}\` | ${verdict} | ${v.wrote ? '—' : pct(v.ratio)} | ${pct(v.threshold)} |`);
}

function readPin() {
  try { return readFileSync(join(HERE, 'chrome-version.txt'), 'utf8').trim(); } catch { return 'unpinned'; }
}
