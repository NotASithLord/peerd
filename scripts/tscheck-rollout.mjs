#!/usr/bin/env bun
// Dev-only helper (NOT shipped, NOT a gate): batch-applies the
// `// @ts-check` opt-in directive and reports which files pass clean.
//
// Mechanism: with checkJs:false a file's body is only checked once it
// carries `// @ts-check`. A file's *exported* types are inferred the
// same either way, so adding the directive everywhere and reverting the
// files that error is a sound one-pass way to find the "free wins"
// (files already type-clean) — no cross-file order effects.
//
// Modes:
//   --dry            : report counts only, touch nothing
//   --apply-clean    : add // @ts-check to every candidate, run tsc,
//                      then REVERT it from any file that errored. Net
//                      result: every newly-checked file is clean.
//   --list-uncovered : print files without // @ts-check (the backlog)
//
// Usage: bun scripts/tscheck-rollout.mjs --apply-clean [glob...]

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const EXT = join(REPO, 'extension');

// Deliberately-ES5 injected-into-page bodies (eslint.config.js) — never
// annotate; they are serialized + re-evaluated in a target page.
const ES5_INJECTED = new Set([
  'peerd-runtime/dom/walk-injected.js',
  'peerd-runtime/dom/framework-state.js',
  'peerd-runtime/dom/pull-in-hint-injected.js',
  'background/debugger-pool.js',
  'peerd-runtime/tools/defs/watch-changes.js',
]);

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'vendor' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (entry.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
};

const hasDirective = (src) => /^[ \t]*\/\/[ \t]*@ts-check\b/m.test(src.split('\n').slice(0, 3).join('\n'));

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--')) ?? '--dry';
const globs = args.filter((a) => !a.startsWith('--'));

const allFiles = walk(EXT).filter((f) => {
  const rel = relative(EXT, f);
  if (ES5_INJECTED.has(rel)) return false;
  if (globs.length === 0) return true;
  return globs.some((g) => rel.startsWith(g) || f.includes(g));
});

const covered = allFiles.filter((f) => hasDirective(readFileSync(f, 'utf8')));
const uncovered = allFiles.filter((f) => !hasDirective(readFileSync(f, 'utf8')));

if (mode === '--list-uncovered') {
  for (const f of uncovered) console.log(relative(REPO, f));
  process.exit(0);
}

const total = walk(EXT).filter((f) => !ES5_INJECTED.has(relative(EXT, f))).length;
const coveredAll = walk(EXT).filter((f) => !ES5_INJECTED.has(relative(EXT, f)) && hasDirective(readFileSync(f, 'utf8'))).length;
console.error(`coverage: ${coveredAll}/${total} files (${((coveredAll / total) * 100).toFixed(1)}%) carry // @ts-check`);
console.error(`in scope: ${allFiles.length} files, ${covered.length} already checked, ${uncovered.length} candidates`);

if (mode === '--dry') process.exit(0);

if (mode !== '--apply-clean') {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

// Add directive to all uncovered candidates.
const addDirective = (f) => {
  const src = readFileSync(f, 'utf8');
  writeFileSync(f, `// @ts-check\n${src}`);
};
const removeDirective = (f) => {
  const src = readFileSync(f, 'utf8');
  writeFileSync(f, src.replace(/^\/\/ @ts-check\n/, ''));
};

for (const f of uncovered) addDirective(f);

let tscOut = '';
try {
  tscOut = execSync('./node_modules/.bin/tsc', { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  tscOut = (e.stdout ?? '') + (e.stderr ?? '');
}

const errored = new Set(
  tscOut
    .split('\n')
    .map((l) => l.match(/^(extension\/[^(]+\.js)\(/))
    .filter(Boolean)
    .map((m) => join(REPO, m[1])),
);

let reverted = 0;
for (const f of uncovered) {
  if (errored.has(f)) {
    removeDirective(f);
    reverted += 1;
  }
}

const kept = uncovered.length - reverted;
console.error(`\napplied to ${uncovered.length} candidates → ${kept} kept clean, ${reverted} reverted (had errors)`);
console.error('newly covered (clean):');
for (const f of uncovered) {
  if (!errored.has(f)) console.error('  ' + relative(REPO, f));
}
