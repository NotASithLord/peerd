#!/usr/bin/env bun
// Emit the PR-comment markdown for the visual comparison, with the before/after
// montages embedded INLINE (no artifact download). The montages are pushed to
// the `visual-diffs` branch by the workflow; here we reference them by raw URL,
// which GitHub renders in a comment.
//
//   bun scripts/cdp/visual-review-comment.mjs --base-url <url> --run-url <url> [--montage-dir <dir>]
//
// --base-url : raw prefix the montages live under, e.g.
//   https://raw.githubusercontent.com/<owner>/<repo>/visual-diffs/pr123/<sha>
// Reads scripts/cdp/visual-runs/visual-vs-base.json for what changed. Prints
// markdown to stdout.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (arg('base-url') || '').replace(/\/$/, '');
const RUN_URL = arg('run-url') || '';
const RUNS = join(HERE, 'visual-runs');
const MONTAGE_DIR = arg('montage-dir') || join(RUNS, 'montage');
const REPORT = join(RUNS, 'visual-vs-base.json');

const pct = (n) => `${(n * 100).toFixed(3)}%`;
const LABELS = {
  'initial-screen': 'Vault gate', 'idle-unlocked': 'Empty chat',
  'completed-turn': 'Completed turn', 'multi-turn-transcript': 'Multi-turn',
  'busy-thinking': 'Thinking', 'mode-plan': 'Plan mode',
  'tool-card-expanded': 'Tool call', 'goal-running': 'Goal running',
  'error-turn': 'Failed turn', 'sessions-list': 'Chats',
  'home-fulltab': 'Home (full tab)', 'options-fulltab': 'Settings (full tab)',
};

console.log('<!-- peerd-visual -->');
console.log('### Visual regression');
console.log('');

if (!existsSync(REPORT)) {
  console.log('_The comparison did not get far enough to produce a report._');
  process.exit(0);
}
const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const rows = report.rows ?? [];
const notable = rows.filter((r) => r.verdict !== 'identical');

// A montage exists per <state>.<theme> that we composed + pushed.
const haveMontage = existsSync(MONTAGE_DIR)
  ? new Set(readdirSync(MONTAGE_DIR).map((f) => f.replace(/\.before-after\.png$/, '')))
  : new Set();

const shortBase = String(report.baseRef ?? '').slice(0, 12);
const shortHead = String(report.headRef ?? '').slice(0, 12);

if (!notable.length) {
  console.log(`✅ **No visual change.** All ${rows.length} screens render exactly as they do at the merge base.`);
  console.log('');
  console.log(`<sub>Rendered twice in this run: \`${shortBase}\` (merge base) and \`${shortHead}\`. `
    + 'peerd keeps no reference screenshots, so there was nothing to compare against until now.</sub>');
  process.exit(0);
}

console.log(`⚠️ **The UI renders differently than the merge base** - ${notable.length} of ${rows.length} screens moved.`);
console.log('');

// Group by base state so light + dark sit together.
const byState = new Map();
for (const r of notable) {
  if (!byState.has(r.state)) byState.set(r.state, []);
  byState.get(r.state).push(r);
}

// Worst-first: a reviewer's attention should land on the biggest movement, and
// an alphabetical list buries a redesigned page under a 0.01% text reflow.
const worstOf = (entries) => Math.max(...entries.map((e) => e.ratio ?? 1));
const ordered = [...byState.entries()].sort((a, b) => worstOf(b[1]) - worstOf(a[1]));

for (const [state, entries] of ordered) {
  const label = LABELS[state] || state;
  const worst = worstOf(entries);
  console.log(`<details${worst > 0.05 ? ' open' : ''}><summary><b>${label}</b> - <code>${state}</code> · up to ${pct(worst)} changed</summary>`);
  console.log('');
  for (const e of entries.sort((a, b) => (a.theme || '').localeCompare(b.theme || ''))) {
    const measure = e.ratio == null ? e.verdict : `${pct(e.ratio)} of pixels`;
    console.log(`**${e.theme}** - ${measure} (merge base ⟶ this branch)`);
    if (BASE_URL && haveMontage.has(e.key)) {
      console.log('');
      console.log(`![${label}, ${e.theme}: merge base then this branch](${BASE_URL}/${e.key}.before-after.png)`);
    } else if (e.ratio == null) {
      console.log('');
      console.log('_(no pair to compose - see the run artifact)_');
    } else {
      console.log('');
      console.log('_(montage unavailable - see the run artifact)_');
    }
    console.log('');
  }
  console.log('</details>');
  console.log('');
}

if (RUN_URL) {
  console.log(`<sub>Every screen at full size, both sides, plus the diff masks: the \`visual-screens\` artifact on **[this run](${RUN_URL})**.</sub>`);
  console.log('');
}
console.log('<sub>**Intended? Then there is nothing to do here.** peerd commits no reference screenshots, '
  + 'so a deliberate redesign has no baseline to reseed - this lane reports, it does not gate. '
  + 'Both sides above were rendered from source in this run.</sub>');
console.log('');
console.log(`<sub>\`${shortBase}\` (merge base) ⟶ \`${shortHead}\`. `
  + 'The montages live on the `visual-diffs` branch and are deleted when this PR closes.</sub>');
