#!/usr/bin/env bun
// Write the visual review comment. Keep capture failures separate from changes.

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
const REPORT = arg('report') || join(RUNS, 'visual-vs-base.json');

const pct = (n) => `${(n * 100).toFixed(3)}%`;
const LABELS = {
  'initial-screen': 'Vault gate', 'idle-unlocked': 'Empty chat',
  'completed-turn': 'Completed turn', 'multi-turn-transcript': 'Multi-turn',
  'busy-thinking': 'Thinking', 'mode-plan': 'Plan mode',
  'tool-card-expanded': 'Tool call', 'goal-running': 'Goal running',
  'error-turn': 'Failed turn', 'sessions-list': 'Chats',
  'home-fulltab': 'Home (full tab)', 'options-fulltab': 'Settings (full tab)',
};

const md = ['<!-- peerd-visual -->', '### Visual regression', ''];
if (!existsSync(REPORT)) {
  md.push('⚠️ **The visual comparison is incomplete.** No comparison report is available.');
  if (RUN_URL) md.push(`See the render evidence on [this run](${RUN_URL}).`);
  console.log(md.join('\n'));
  process.exit(0);
}
const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const rows = report.rows ?? [];
const notable = rows.filter((r) => r.verdict !== 'identical');
const images = new Set(existsSync(MONTAGE_DIR) ? readdirSync(MONTAGE_DIR) : []);
const shortBase = String(report.baseRef ?? '').slice(0, 12);
const shortHead = String(report.headRef ?? '').slice(0, 12);
md.push(report.ok === false || !rows.length ? '⚠️ **The visual comparison is incomplete.**'
  : notable.length ? '⚠️ **Review the visual changes below.**' : '✅ **No visual change.**',
`${rows.filter(r => r.status === 'changed').length} changed, `
  + `${rows.filter(r => r.status === 'new').length} new captures, `
  + `${rows.filter(r => r.status === 'missing').length} missing captures, `
  + `${rows.filter(r => r.verdict === 'identical').length} identical.`, '');
for (const [side, render] of Object.entries(report.render ?? {})) {
  for (const error of (render.errors ?? []).slice(0, 6))
    md.push(`- ${side}: ${error.state ?? 'render'} - ${String(error.detail).slice(0, 500)}`);
  if (render.errors?.length > 6) md.push(`- ${side}: ${render.errors.length - 6} more errors. See the run evidence.`);
}
// why reserve space: GitHub limits comment size. The artifact keeps all captures.
let budget = 60000 - md.join('\n').length;
let omitted = false;
for (const screen of report.browserScreens ?? []) {
  const name = screen.file.split('/').pop();
  const section = ['', `**Browser window: ${screen.state} - ${screen.label}**`, ''];
  if (BASE_URL && images.has(name)) section.push(`![This branch browser window](${BASE_URL}/${name})`, '');
  budget -= section.join('\n').length + 1;
  if (budget < 0) { omitted = true; break; }
  md.push(...section);
}
const byState = new Map();
for (const row of notable) {
  if (!byState.has(row.state)) byState.set(row.state, []);
  byState.get(row.state).push(row);
}
const worstOf = (entries) => Math.max(...entries.map((entry) => entry.ratio ?? 0));
const ordered = [...byState.entries()].sort((a, b) => worstOf(b[1]) - worstOf(a[1]));
for (const [state, entries] of ordered) {
  const label = LABELS[state] || state;
  const worst = worstOf(entries);
  const measure = entries.some(e => e.status === 'changed' && e.ratio != null) ? `up to ${pct(worst)} changed` : entries[0].verdict;
  const section = [`<details${worst > 0.05 ? ' open' : ''}><summary>${label} - ${measure}</summary>`, ''];
  for (const entry of entries.sort((a, b) => (a.theme || '').localeCompare(b.theme || ''))) {
    section.push(`**${entry.theme}** - ${entry.verdict}${entry.ratio == null ? '' : ` (${pct(entry.ratio)} of pixels)`}`, '');
    if (BASE_URL && images.has(`${entry.key}.before-after.png`))
      section.push(`![${entry.theme}: before then after](${BASE_URL}/${entry.key}.before-after.png)`);
    else if (BASE_URL && images.has(`${entry.key}.after.png`))
      section.push(`![${entry.theme}: this branch only](${BASE_URL}/${entry.key}.after.png)`);
    else section.push('_(Review image unavailable. See the run evidence.)_');
    section.push('');
  }
  section.push('</details>', '');
  budget -= section.join('\n').length + 1;
  if (budget < 0) { omitted = true; break; }
  md.push(...section);
}
if (omitted) md.push('More captures are in the run evidence. The inline gallery reached the comment size limit.', '');
if (RUN_URL) md.push(`Full captures and render errors: the \`visual-screens\` artifact on [this run](${RUN_URL}).`, '');
md.push('<sub>Pixel changes do not gate merges. Browser window captures show this branch only.</sub>', '',
  `<sub>\`${shortBase}\` (merge base) to \`${shortHead}\`. Review images are deleted when this PR closes.</sub>`);
console.log(md.join('\n'));
