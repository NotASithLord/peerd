// Dweb import-boundary check (spec §2/§3) — fails CI if anything
// outside extension/peerd-distributed/ references the dweb module.
//
// The invariant: core code programs against /shared/dweb-interface.js;
// the ONLY sanctioned reference to the module's path is the gated dynamic
// import in /shared/dweb-loader.js (which the store package swaps for
// a stub variant). This script is the load-bearing gate; the ESLint
// no-restricted-imports pattern gives the same feedback in editors but
// doesn't see dynamic import() — this does.
//
// What counts as a reference (comments in prose don't):
//   - a static import/export-from whose specifier names peerd-distributed
//   - a dynamic import(...) whose literal names peerd-distributed
//   - ANY string literal containing a /peerd-distributed/ path (catches
//     fetch()/scripting paths and other indirect loads)
//
// Run: bun run check:boundary   (also part of `bun run package`)

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { EXTENSION_DIR, REPO_ROOT } from './lib.ts';

const DWEB_DIR = 'peerd-distributed';
// The one file allowed to name the module path (dynamic, flag-gated).
const ALLOWED = new Set(['shared/dweb-loader.js']);

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'static import/export', re: /\bfrom\s+['"][^'"]*peerd-distributed[^'"]*['"]/ },
  { name: 'side-effect import', re: /\bimport\s+['"][^'"]*peerd-distributed[^'"]*['"]/ },
  { name: 'dynamic import', re: /\bimport\(\s*['"][^'"]*peerd-distributed[^'"]*['"]/ },
  { name: 'path string literal', re: /['"]\/?peerd-distributed\/[^'"]*['"]/ },
];

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === DWEB_DIR || entry === 'vendor' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(js|mjs|html)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
};

const violations: string[] = [];
for (const file of walk(EXTENSION_DIR)) {
  const rel = relative(EXTENSION_DIR, file);
  if (ALLOWED.has(rel)) continue;
  // tests/ and eval/ never ship — package.ts prunes them from BOTH
  // artifacts — so in-browser dweb tests may import the module.
  if (rel.startsWith('tests/') || rel.startsWith('eval/')) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        violations.push(`${relative(REPO_ROOT, file)}:${i + 1}  [${name}]  ${line.trim()}`);
        break;
      }
    }
  });
}

if (violations.length > 0) {
  console.error(
    'DWEB BOUNDARY VIOLATION — code outside extension/peerd-distributed/ '
    + 'references the dweb module. Program against '
    + '/shared/dweb-interface.js and obtain the client via '
    + '/shared/dweb-loader.js instead:\n',
  );
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('dweb boundary OK — no references outside peerd-distributed/');
