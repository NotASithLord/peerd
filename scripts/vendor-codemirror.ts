// One-shot CodeMirror 6 bundler.
//
// Run via `bun scripts/vendor-codemirror.ts`. Output is committed to
// extension/vendor/codemirror/cm.js so the extension itself runs no
// build step. The output is ONE ES module exporting just the surface
// js-tab.js consumes -- EditorView + EditorState + a curated set of
// extensions for JS editing.
//
// To upgrade: bump the dep versions in package.json, re-run, commit.

import { write } from 'bun';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const ENTRY = path.join(ROOT, 'scripts/codemirror-entry.ts');
const OUT_DIR = path.join(ROOT, 'extension/vendor/codemirror');

console.log('[vendor:codemirror] bundling…');
const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUT_DIR,
  format: 'esm',
  minify: true,
  target: 'browser',
  naming: 'cm.js',
});

if (!result.success) {
  console.error('[vendor:codemirror] build failed:');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Drop a SOURCE.txt with provenance, matching the rest of vendor/.
const pkg = JSON.parse(await Bun.file(path.join(ROOT, 'package.json')).text());
const deps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};
const pinned = [
  'codemirror',
  '@codemirror/lang-javascript',
  '@codemirror/lang-html',
  '@codemirror/lang-css',
  '@codemirror/theme-one-dark',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/commands',
  '@codemirror/search',
  '@codemirror/autocomplete',
  '@codemirror/language',
].map((name) => `  ${name}: ${deps[name] ?? '?'}`).join('\n');

await write(
  path.join(OUT_DIR, 'SOURCE.txt'),
  `CodeMirror 6 — bundled by scripts/vendor-codemirror.ts.

Source entry: scripts/codemirror-entry.ts
Bundler: Bun ${Bun.version}

Versions pinned in package.json (devDependencies):
${pinned}

Re-run with: bun run vendor:codemirror
`,
);

const stats = await Bun.file(path.join(OUT_DIR, 'cm.js')).size;
console.log(`[vendor:codemirror] wrote cm.js (${(stats / 1024).toFixed(1)} KB)`);
