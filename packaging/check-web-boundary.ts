// check-web-boundary.ts — the honesty gate for the `web` target (spec §10,
// mirrors the spirit of check-dweb-boundary.ts). It proves the staged web-dist/
// is IMPORT-CLOSED: every static/side-effect/dynamic import specifier resolves
// to a file that actually exists in the tree. A dangling import means a curated
// module reaches into pruned chassis code (e.g. /background/*, /offscreen/*) and
// would 404 at module load on a page — the exact failure mode a naive
// "stage + prune" build hits. It also asserts the browser-polyfill was swapped
// for the no-throw shim, and lists any top-level chrome./browser. touches for review.
//
// Run: bun run check:web   (after bun run package:web)
// why here, not eslint: eslint's no-restricted-imports runs on SOURCE and can't
// see the effect of staging/pruning. This runs on the ASSEMBLED tree, so it
// catches a NEW upstream import escaping the curated set the moment it lands.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { REPO_ROOT } from './lib.ts';
import { WEB_DIST } from './web-target.ts';

// The shim must carry this marker; its absence means the swap did not apply.
const SHIM_MARKER = 'browser-polyfill.web.js';

// Strip block + line comments so import-like text in JSDoc / prose isn't scanned
// (e.g. `@param {import('webextension-polyfill')…}` or a `//  import … from 'x'`
// example). Not a full tokenizer, but combined with statement-anchoring below it
// removes the false positives without missing real import statements.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);

// A specifier that is a real, resolvable module path (not a template/placeholder
// built as data, and not the notebook `peerd:std` builtin scheme).
const isRealSpecifier = (spec: string): boolean =>
  spec.length > 0 && !/[\s<>${}]/.test(spec) && !spec.startsWith('peerd:');

// Import forms, anchored to STATEMENT position (line start, or a `}` continuation
// line for multi-line named imports) so specifiers built inside template strings
// (module-resolver.js constructs `import … from '…'` as data) are not matched.
const SPEC_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'import/export-from', re: /(?:^|\n)\s*(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g },
  { kind: 'continuation-from', re: /(?:^|\n)\s*}\s*from\s*['"]([^'"]+)['"]/g },
  { kind: 'side-effect import', re: /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g },
  { kind: 'dynamic import', re: /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g },
];

const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // vendor/ is third-party and self-contained; don't scan its internals.
      if (entry === 'vendor') continue;
      walk(p, out);
    } else if (/\.(js|mjs)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
};

const dangling: string[] = [];
const suspicious: string[] = [];   // top-level chrome./browser. touches (warn)
const chromeAtLineStart = /^\s*(?:globalThis\.)?(chrome|browser)\.\w/;

if (!existsSync(WEB_DIST)) {
  console.error('web-dist/ not found — run `bun run package:web` first.');
  process.exit(1);
}

for (const file of walk(WEB_DIST)) {
  const rel = relative(WEB_DIST, file);
  const raw = readFileSync(file, 'utf8');
  const src = stripComments(raw);
  const fileDir = dirname(file);

  // top-level (column 0) extension-global touch — a module-load throw risk.
  src.split('\n').forEach((line, i) => {
    if (chromeAtLineStart.test(line)) suspicious.push(`${rel}:${i + 1}  ${raw.split('\n')[i]?.trim() ?? line.trim()}`);
  });

  for (const { kind, re } of SPEC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!isRealSpecifier(spec)) continue;
      const at = `${rel}:${lineOf(src, m.index)}`;
      let resolved: string;
      if (spec.startsWith('/')) resolved = join(WEB_DIST, spec);
      else if (spec.startsWith('.')) resolved = resolve(fileDir, spec);
      else { dangling.push(`${at}  [${kind}] bare/non-relative specifier "${spec}" (no importmap ships)`); continue; }
      if (!existsSync(resolved)) {
        dangling.push(`${at}  [${kind}] "${spec}" -> ${relative(WEB_DIST, resolved)} (missing)`);
      }
    }
  }
}

// The polyfill must be the no-throw shim, not the real vendored one.
const polyfill = join(WEB_DIST, 'vendor', 'browser-polyfill.js');
if (!existsSync(polyfill)) {
  dangling.push('vendor/browser-polyfill.js is missing (the shim swap did not run)');
} else if (!readFileSync(polyfill, 'utf8').includes(SHIM_MARKER)) {
  dangling.push('vendor/browser-polyfill.js is not the page shim — the swap did not apply');
}

if (suspicious.length > 0) {
  console.warn(`\n⚠  ${suspicious.length} chrome./browser. touch(es) — verify the page shim (packaging/templates/browser-polyfill.web.js) covers these APIs:`);
  for (const s of suspicious.slice(0, 40)) console.warn('   ' + s);
  if (suspicious.length > 40) console.warn(`   … and ${suspicious.length - 40} more`);
}

if (dangling.length > 0) {
  console.error(`\nWEB BOUNDARY VIOLATION — ${dangling.length} import(s) in web-dist/ do not resolve within the staged tree.`);
  console.error('The web target reaches pruned chassis code (or a bare specifier). Fix curation in');
  console.error('packaging/web-target.ts (include the file, add a stub, or shim it), then re-run `bun run package:web`:\n');
  for (const v of dangling) console.error('  ' + v);
  process.exit(1);
}

console.log(`web boundary OK — every import in ${relative(REPO_ROOT, WEB_DIST)}/ resolves; polyfill shim in place.`);
