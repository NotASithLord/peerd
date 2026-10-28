#!/usr/bin/env bun
// Compare captures from both run manifests. Pixel changes require review.
// Missing evidence fails the run. No reference screenshots are committed.
// Usage: bun scripts/cdp/visual-vs-base.mjs [--base <ref>] [--only a,b] [--reuse-head]

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { STATES } from './states.mjs';
import { THEMES, log, visualSourceIdentity } from './e2e-harness.mjs';
import { DEFAULT_THRESHOLD, decodePng, comparePixels, writeDiffImage } from './visual.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ARTIFACTS = join(HERE, 'artifacts');
const RUNS = join(HERE, 'visual-runs');
const arg = (flag) => {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (hit) return hit.slice(`--${flag}=`.length);
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const visualStates = STATES.filter((s) => s.kind === 'visual' && (!only.length || only.includes(s.name)));
const selectedStates = visualStates.map((state) => state.name);
if (!visualStates.length) {
  console.error('[vs-base] no visual states selected');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
// why: CI checks out a merge commit. Its merge base is the target branch.
const baseRef = arg('base') || tryGit('merge-base', 'origin/main', 'HEAD')
  || tryGit('rev-parse', 'origin/main') || tryGit('rev-parse', 'main');
const headRef = git('rev-parse', 'HEAD');
const BASE_RUN = join(RUNS, 'base');
const SCREENS = join(RUNS, 'screens');
const BASE_DIR = join(SCREENS, 'base');
const HEAD_DIR = join(SCREENS, 'head');
const DIFF_DIR = join(SCREENS, 'diff');
const baseTree = join(RUNS, `base-tree-${baseRef?.slice(0, 8) ?? 'missing'}`);
rmSync(SCREENS, { recursive: true, force: true });
rmSync(BASE_RUN, { recursive: true, force: true });
for (const name of ['visual-vs-base.json', 'visual-vs-base.md', 'montage'])
  rmSync(join(RUNS, name), { recursive: true, force: true });
for (const dir of [RUNS, BASE_DIR, HEAD_DIR, DIFF_DIR]) mkdirSync(dir, { recursive: true });

const collect = (fromDir, intoDir, exitCode, sourceIdentity) => {
  const errors = [];
  let result;
  try {
    result = JSON.parse(readFileSync(join(fromDir, 'result.json'), 'utf8'));
    if (!Array.isArray(result.states) || result.states.some((state) => !state || typeof state.name !== 'string'))
      throw new Error('states must contain named results');
  } catch (error) {
    errors.push({ state: null, detail: `No usable result.json: ${error.message}` });
    result = { states: [] };
  }
  if (!sourceIdentity || result.sourceIdentity !== sourceIdentity)
    errors.push({ state: null, detail: 'Capture source identity is missing or does not match' });
  const states = new Map(result.states.map((state) => [state.name, state]));
  const captures = new Map();
  for (const state of visualStates) {
    const recorded = states.get(state.name);
    if (!recorded) {
      errors.push({ state: state.name, detail: 'State did not run' });
      continue;
    }
    const failed = (Array.isArray(recorded.checks) ? recorded.checks : []).filter((check) => !check?.pass);
    if (recorded.ok !== true || failed.length) errors.push({ state: state.name,
      detail: failed.map((check) => `${check?.name}: ${check?.detail}`).join('; ') || 'State failed' });
    if (!Array.isArray(recorded.visuals)) errors.push({ state: state.name, detail: 'Capture metadata is missing' });
    for (const capture of Array.isArray(recorded.visuals) ? recorded.visuals : []) {
      if (!capture?.base || !THEMES.includes(capture.theme) || capture.name !== `${capture.base}.${capture.theme}`) {
        errors.push({ state: state.name, detail: 'Capture metadata is invalid' });
        continue;
      }
      try { decodePng(readFileSync(join(fromDir, `${capture.name}-current.png`))); }
      catch (error) {
        errors.push({ state: state.name, detail: `Capture is missing or invalid: ${capture.name}: ${error.message}` });
        continue;
      }
      if (captures.has(capture.name)) errors.push({ state: state.name, detail: `Duplicate capture: ${capture.name}` });
      captures.set(capture.name, { ...capture, sourceState: state.name });
    }
  }
  // why: retain partial images even if the process failed before it wrote its manifest.
  const declared = new Set(result.states.flatMap((state) => Array.isArray(state.visuals) ? state.visuals : []).map((capture) => capture?.name));
  for (const file of existsSync(fromDir) ? readdirSync(fromDir) : []) {
    if (!file.endsWith('-current.png')) continue;
    if (!declared.has(file.replace(/-current\.png$/, ''))) errors.push({ state: null, detail: `Capture metadata is missing: ${file}` });
    copyFileSync(join(fromDir, file), join(intoDir, file.replace(/-current\.png$/, '.png')));
  }
  if (result.ok !== true || exitCode !== 0) errors.push({ state: null, detail: `Render failed (exit ${exitCode ?? 'unknown'})` });
  return { exitCode, errors, states, captures, sourceIdentity: result.sourceIdentity };
};

const render = ({ extensionDir, artifactsDir }) => {
  const args = [join(HERE, 'run-e2e-verify.mjs'), '--visual'];
  if (only.length) args.push(`--only=${only.join(',')}`);
  if (extensionDir) args.push(`--extension=${extensionDir}`);
  if (artifactsDir) args.push(`--artifacts=${artifactsDir}`);
  return spawnSync('bun', args, { cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, PEERD_VISUAL_BASE_RENDER: extensionDir ? '1' : '0' } }).status;
};
const materialiseBase = () => {
  if (!baseRef) return false;
  try {
    if (!existsSync(baseTree)) execFileSync('git', ['worktree', 'add', '--detach', baseTree, baseRef], { cwd: ROOT, stdio: 'pipe' });
    execFileSync('bun', ['run', 'gen:dev'], { cwd: baseTree, stdio: 'pipe' });
    // Keep capability probes bound to the committed base, before overlaying
    // executable fixtures from the head. Re-read Git even for a reused worktree.
    const fixtureSources = {};
    const fixtureFiles = git('ls-tree', '-r', '--name-only', baseRef, '--', 'extension/tests/fixtures').split('\n');
    for (const name of ['starters.js', 'explore.js', 'contacts.js']) {
      const path = `extension/tests/fixtures/${name}`;
      fixtureSources[name] = fixtureFiles.includes(path) ? git('show', `${baseRef}:${path}`) : '';
    }
    writeFileSync(join(baseTree, 'extension/tests/visual-base-fixtures.json'), JSON.stringify(fixtureSources));
    // why: both builds must use the same fixture pages as the state definitions.
    rmSync(join(baseTree, 'extension/tests/fixtures'), { recursive: true, force: true });
    cpSync(join(ROOT, 'extension/tests/fixtures'), join(baseTree, 'extension/tests/fixtures'), { recursive: true });
    // Discover fixtures also click versioned UI labels. Preserve the base's
    // drivers for supported screens; unsupported new frames are reported absent.
    for (const [name, source] of Object.entries(fixtureSources)) {
      const path = join(baseTree, 'extension/tests/fixtures', name);
      if (source) writeFileSync(path, source);
      else rmSync(path, { force: true });
    }
    return true;
  } catch (error) {
    log(`Could not prepare the base: ${error.message}`);
    return false;
  }
};

log(`comparing ${headRef.slice(0, 8)} against ${baseRef?.slice(0, 8) ?? 'missing base'}`);
const baseReady = materialiseBase(), extensionDir = join(baseTree, 'extension');
const baseIdentity = baseReady ? visualSourceIdentity({ extensionDir, states: selectedStates }) : null;
const base = collect(BASE_RUN, BASE_DIR, baseReady ? render({ extensionDir, artifactsDir: BASE_RUN }) : 1, baseIdentity);
const headIdentity = visualSourceIdentity({ states: selectedStates });
let reuse = false;
if (process.argv.includes('--reuse-head')) try {
  const previous = JSON.parse(readFileSync(join(ARTIFACTS, 'result.json'), 'utf8'));
  reuse = previous.sourceIdentity === headIdentity && Array.isArray(previous.states)
    && previous.states.every((state) => state && typeof state.name === 'string' && Array.isArray(state.visuals));
} catch { /* A missing or invalid manifest requires a new render. */ }
const head = collect(ARTIFACTS, HEAD_DIR, reuse ? 0 : render({ artifactsDir: ARTIFACTS }), headIdentity);
const rows = [];
const names = new Map(visualStates.flatMap((state) => (state.visualVariants ?? []).map((name) => [name, state.name])));
for (const capture of [...base.captures.values(), ...head.captures.values()]) names.set(capture.base, capture.sourceState);
for (const state of visualStates) {
  if (![...names.values()].includes(state.name)) {
    for (const run of [base, head]) run.errors.push({ state: state.name, detail: 'No capture metadata on either side' });
  }
}
for (const [state, sourceState] of names) {
  for (const theme of THEMES) {
    const key = `${state}.${theme}`;
    const beforeFile = join(BASE_DIR, `${key}.png`);
    const afterFile = join(HEAD_DIR, `${key}.png`);
    const before = base.captures.has(key) && existsSync(beforeFile);
    const after = head.captures.has(key) && existsSync(afterFile);
    let status = 'identical', verdict = 'identical', ratio = null;
    if (!before || !after) {
      const newCapture = after && !base.captures.has(key) && base.states.get(sourceState)?.ok === true
        && !base.errors.some((error) => error.state === sourceState)
        && ![...base.captures.values()].some((capture) => capture.base === state);
      status = newCapture ? 'new' : 'missing';
      verdict = newCapture ? 'new capture (absent on the base)'
        : `missing ${!before && !after ? 'base and head' : !before ? 'base' : 'head'} capture`;
      if (!newCapture) for (const [run, present] of [[base, before], [head, after]]) {
        if (!present) run.errors.push({ state: sourceState, detail: `${verdict}: ${key}` });
      }
    } else try {
      const b = decodePng(readFileSync(beforeFile)), a = decodePng(readFileSync(afterFile));
      if (b.width !== a.width || b.height !== a.height) {
        status = 'changed';
        verdict = `capture resized ${b.width}x${b.height} to ${a.width}x${a.height}`;
      } else {
        ratio = comparePixels(b, a).ratio;
        if (ratio > DEFAULT_THRESHOLD) {
          status = verdict = 'changed';
          writeDiffImage(b, a, join(DIFF_DIR, `${key}.png`));
        }
      }
    } catch (error) {
      status = 'missing';
      verdict = 'capture could not be decoded';
      head.errors.push({ state: sourceState, detail: `${key}: ${error.message}` });
    }
    rows.push({ state, sourceState, theme, key, status, verdict, ratio });
  }
}
const browserScreens = [];
for (const state of visualStates) for (const shot of head.states.get(state.name)?.screenshots ?? []) {
  if (shot?.kind !== 'browser-window') continue;
  if (typeof shot.path !== 'string' || typeof shot.label !== 'string') {
    head.errors.push({ state: state.name, detail: 'Browser capture metadata is invalid' });
    continue;
  }
  const file = join(HEAD_DIR, `${state.name}-${shot.label}.png`);
  try { decodePng(readFileSync(resolve(ROOT, shot.path)));
    copyFileSync(resolve(ROOT, shot.path), file);
    browserScreens.push({ state: state.name, label: shot.label, file: relative(ROOT, file) });
  } catch (error) { head.errors.push({ state: state.name, detail: `Browser capture is missing or invalid: ${shot.label}: ${error.message}` }); }
}
const renderResults = Object.fromEntries(Object.entries({ base, head }).map(([name, run]) =>
  [name, { ok: run.errors.length === 0, exitCode: run.exitCode, sourceIdentity: run.sourceIdentity, errors: run.errors }]));
const ok = renderResults.base.ok && renderResults.head.ok;
const summary = Object.fromEntries(['changed', 'new', 'missing', 'identical']
  .map((status) => [status, rows.filter((row) => row.status === status).length]));
writeFileSync(join(RUNS, 'visual-vs-base.json'), JSON.stringify({
  baseRef, headRef, ok, status: ok ? 'complete' : 'incomplete', render: renderResults,
  summary, threshold: DEFAULT_THRESHOLD, screens: SCREENS, rows, browserScreens,
}, null, 2));

const md = ['### Visual regression', '',
  `Base: \`${baseRef?.slice(0, 12) ?? 'unavailable'}\`. Rendered head: \`${headRef.slice(0, 12)}\`.`, '',
  `**${ok ? 'Comparison complete' : 'Comparison incomplete'}.** ${summary.changed} changed, ${summary.new} new captures, ${summary.missing} missing, ${summary.identical} unchanged.`, ''];
for (const [side, run] of Object.entries(renderResults)) for (const error of run.errors)
  md.push(`- ${side}${error.state ? ` / \`${error.state}\`` : ''}: ${error.detail}`);
if (rows.some((row) => row.status !== 'identical')) {
  md.push('', '| capture | theme | result | changed pixels |', '|---|---|---|---|');
  for (const row of rows.filter((entry) => entry.status !== 'identical'))
    md.push(`| \`${row.state}\` | ${row.theme} | ${row.verdict} | ${row.ratio == null ? '-' : `${(row.ratio * 100).toFixed(3)}%`} |`);
}
writeFileSync(join(RUNS, 'visual-vs-base.md'), `${md.join('\n')}\n`);
console.log(`\n${md.join('\n')}\n`);
try { execFileSync('git', ['worktree', 'remove', '--force', baseTree], { cwd: ROOT, stdio: 'pipe' }); }
catch { rmSync(baseTree, { recursive: true, force: true }); }
process.exitCode = ok ? 0 : 1;
