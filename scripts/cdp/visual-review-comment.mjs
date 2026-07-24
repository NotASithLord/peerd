#!/usr/bin/env bun
// Emit the PR-comment markdown for a visual diff, with the before/after montages
// embedded INLINE (no artifact download). The montages are pushed to the
// `visual-diffs` branch by the workflow; here we reference them by raw URL, which
// GitHub renders in a comment.
//
//   bun scripts/cdp/visual-review-comment.mjs --base-url <url> --run-url <url> [--montage-dir <dir>]
//
// --base-url : raw prefix the montages live under, e.g.
//   https://raw.githubusercontent.com/<owner>/<repo>/visual-diffs/pr123/<sha>
// Reads scripts/cdp/artifacts/result.json for which screens changed. Prints
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
const MONTAGE_DIR = arg('montage-dir') || join(HERE, 'artifacts', 'montage');
const RESULT = join(HERE, 'artifacts', 'result.json');

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const LABELS = {
  'initial-screen': 'Vault gate', 'idle-unlocked': 'Empty chat',
  'completed-turn': 'Completed turn', 'multi-turn-transcript': 'Multi-turn',
  'busy-thinking': 'Thinking', 'mode-plan': 'Plan mode',
  'tool-card-expanded': 'Tool call', 'goal-running': 'Goal running',
  'error-turn': 'Failed turn', 'sessions-list': 'Chats',
  'home-fulltab': 'Home (full tab)', 'options-fulltab': 'Settings (full tab)',
};

console.log('<!-- peerd-visual -->');

if (!existsSync(RESULT)) {
  console.log('_The render step did not produce a `result.json`._');
  process.exit(0);
}
const report = JSON.parse(readFileSync(RESULT, 'utf8'));
const visuals = (report.states ?? []).flatMap((s) => s.visuals ?? []);
const changed = visuals.filter((v) => !(v.rawPass ?? v.pass) && !v.wrote);

// A montage exists per <state>.<theme> that we composed + pushed.
const haveMontage = existsSync(MONTAGE_DIR)
  ? new Set(readdirSync(MONTAGE_DIR).map((f) => f.replace(/\.before-after\.png$/, '')))
  : new Set();

if (!changed.length) {
  console.log('**No visual change** — every screen matches the committed baselines. ✅');
  process.exit(0);
}

console.log(`**The UI renders differently than the committed baselines** — ${changed.length} of ${visuals.length} screens changed (before ⟶ after below).`);
console.log('');

// Group changed screens by base state, so light + dark sit together.
const byState = new Map();
for (const v of changed) {
  const base = v.base || v.name.replace(/\.(light|dark)$/, '');
  if (!byState.has(base)) byState.set(base, []);
  byState.get(base).push(v);
}

for (const [state, entries] of byState) {
  const label = LABELS[state] || state;
  const worst = Math.max(...entries.map((e) => e.ratio));
  console.log(`<details${worst > 0.05 ? ' open' : ''}><summary><b>${label}</b> — <code>${state}</code> · up to ${pct(worst)} changed</summary>`);
  console.log('');
  for (const e of entries.sort((a, b) => (a.theme || '').localeCompare(b.theme || ''))) {
    const key = e.name; // <state>.<theme>
    console.log(`**${e.theme}** — ${pct(e.ratio)} of pixels (before ⟶ after)`);
    if (BASE_URL && haveMontage.has(key)) {
      console.log('');
      console.log(`![${label} ${e.theme} before/after](${BASE_URL}/${key}.before-after.png)`);
    } else {
      console.log('_(montage unavailable — see the artifact)_');
    }
    console.log('');
  }
  console.log('</details>');
  console.log('');
}

if (RUN_URL) {
  console.log(`<sub>Full-res before/after/diff PNGs: **[download the \`visual-diff-…\` artifact](${RUN_URL})**.</sub>`);
}
console.log('');
console.log('<sub>Intended? Re-run this workflow on the branch with **update_visual_baselines** checked, then commit the fresh `baselines/linux-x64/` + `gallery.html`.</sub>');
