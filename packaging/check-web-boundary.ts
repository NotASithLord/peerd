// check-web-boundary.ts — the honesty gate for the `web` target (spec §10,
// the web analogue of verify-store-artifact.ts). Runs over the ASSEMBLED
// web-dist/ tree and proves it is actually shippable:
//
//   1. IMPORT CLOSURE — every static/dynamic import specifier (parsed with
//      es-module-lexer, not regexes: real declarations only, so prose in
//      strings/comments can't false-fail and multi-line forms can't slip) in
//      every .js/.mjs file AND in index.html's module scripts resolves to a
//      file that exists in the tree. `new Worker('…')` paths are covered too.
//      A dangling import means curated code reaches pruned chassis — the 404
//      that would kill the page at module load.
//   2. SWAP FIDELITY — every swapped file (browser-polyfill shim, the two
//      /background/ stubs, the dweb loader) is byte-identical to its committed
//      template, and imports FROM a stubbed module use only names the stub
//      exports (a second constant added upstream fails here, not at runtime).
//   3. CHANNEL POSTURE — shared/channel-config.js carries CHANNEL "web" and
//      DWEB_ENABLED false.
//   4. BUILD STAMP — build.json exists and sw.js's __PEERD_WEB_*__ tokens were
//      replaced (the per-build cache name is what invalidates staged modules
//      on deploy).
//   5. SHIPPABILITY — no file exceeds Cloudflare Pages' 25 MiB upload limit.
//   6. PLATFORM-TOUCH RATCHET — module-scope chrome./browser. touches must be
//      in web-target.ts's reviewed KNOWN_BROWSER_TOUCHES allowlist; a NEW
//      touch fails until the shim's coverage is reviewed and the list bumped
//      (same posture as the tscheck floor).
//
// Run: bun run check:web (also auto-runs at the end of `bun run package:web`).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { REPO_ROOT, TEMPLATES_DIR, STORE_LOADER_TEMPLATE } from './lib.ts';
import {
  WEB_DIST, WEB_SWAPS, WEB_STUB_PATHS, KNOWN_BROWSER_TOUCHES,
  PAGES_FILE_LIMIT, PAGES_FILE_WARN,
} from './web-target.ts';

interface Findings { violations: string[]; warnings: string[]; }

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// Specifier schemes that are not file paths by design: the Notebook's
// peerd:std builtin, and blob:/data: URLs the resolvers construct.
const isFileSpecifier = (spec: string): boolean =>
  !/^(peerd:|blob:|data:|https?:)/.test(spec);

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);

const lineOf = (text: string, index: number): number => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
};

export const checkWebBoundary = async (): Promise<void> => {
  if (!existsSync(WEB_DIST)) {
    throw new Error('web-dist/ not found — run `bun run package:web` first.');
  }
  await init;
  const f: Findings = { violations: [], warnings: [] };

  const allFiles = walk(WEB_DIST).map((p) => relative(WEB_DIST, p));
  const stubExports = new Map<string, Set<string>>(); // staged rel path -> exported names
  for (const rel of WEB_STUB_PATHS) {
    const [, exports] = parse(readFileSync(join(TEMPLATES_DIR, WEB_SWAPS[rel]), 'utf8'));
    stubExports.set(rel, new Set(exports.map((e) => e.n)));
  }

  // resolve a specifier from a file; record a violation if it doesn't exist.
  // Returns the WEB_DIST-relative resolved path (for the stub check) or null.
  const resolveSpec = (fromRel: string, line: number, kind: string, spec: string): string | null => {
    if (!isFileSpecifier(spec)) return null;
    const clean = spec.split('?')[0].split('#')[0];
    let abs: string;
    if (clean.startsWith('/')) abs = join(WEB_DIST, clean);
    else if (clean.startsWith('.')) abs = resolve(join(WEB_DIST, dirname(fromRel)), clean);
    else {
      f.violations.push(`${fromRel}:${line}  [${kind}] bare specifier "${spec}" (no importmap ships — use a root-relative path)`);
      return null;
    }
    if (!existsSync(abs)) {
      f.violations.push(`${fromRel}:${line}  [${kind}] "${spec}" -> ${relative(WEB_DIST, abs)} (missing)`);
      return null;
    }
    return relative(WEB_DIST, abs);
  };

  // Scan one module source (a .js file or an inline <script type=module> body).
  const scanModule = (fromRel: string, src: string, lineBase = 0): void => {
    let imports;
    try { [imports] = parse(src, fromRel); }
    catch (e: any) {
      f.warnings.push(`${fromRel}: es-module-lexer could not parse (${e?.message ?? e}) — imports unchecked`);
      return;
    }
    for (const imp of imports) {
      if (imp.d === -2) continue;                    // import.meta
      const spec = imp.n;
      if (spec === undefined) continue;              // dynamic import with non-literal arg
      const line = lineBase + lineOf(src, imp.ss);
      const kind = imp.d >= 0 ? 'dynamic import' : 'import';
      const resolved = resolveSpec(fromRel, line, kind, spec);
      // Stub discipline: importers of a stubbed module may only use STATIC
      // NAMED imports of names the stub exports. Namespace/default/mixed
      // imports and dynamic import() are opaque to this check — the stub
      // occupies the path so mere existence always passes — refuse them so a
      // lazy-load refactor upstream cannot ship an undefined binding.
      if (resolved && stubExports.has(resolved)) {
        const allowed = stubExports.get(resolved)!;
        if (imp.d >= 0) {
          f.violations.push(`${fromRel}:${line}  [stub import] dynamic import() of stubbed ${resolved} is unverifiable — use a static named import (stub exports: ${[...allowed].join(', ')})`);
          continue;
        }
        const stmt = src.slice(imp.ss, imp.se);
        const braces = stmt.match(/{([^}]*)}/);
        const names = braces
          ? braces[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
          : null;
        // a default binding before the braces (`import def, { X } from …`) or
        // no braces at all (`import def from …`, `import * as ns from …`).
        const hasDefaultOrNs = /import\s+(?:[A-Za-z_$][\w$]*\s*,|[A-Za-z_$][\w$]*\s+from|\*\s+as)/.test(stmt);
        if (!names || hasDefaultOrNs) {
          f.violations.push(`${fromRel}:${line}  [stub import] non-named import of stubbed ${resolved} — import { … } only (stub exports: ${[...allowed].join(', ')})`);
        } else {
          for (const n of names) {
            if (!allowed.has(n)) {
              f.violations.push(`${fromRel}:${line}  [stub import] "${n}" is not exported by the web stub for ${resolved} — extend packaging/templates/${WEB_SWAPS[resolved]} (and verify the value against the real file)`);
            }
          }
        }
      }
    }
    // Worker entry points are module loads too. Only ROOT-relative paths are
    // checked: those are page-context loads against this origin (e.g.
    // /web/gemma-worker.js). Relative/bare worker paths in staged module code
    // are data for OTHER contexts (the App composer emits `new Worker('…')`
    // into opaque-iframe harness code, resolved against a blob origin) — not
    // resolvable here. Comment-stripped so doc examples don't match at all.
    const workerRe = /new\s+(?:Shared)?Worker\s*\(\s*['"](\/[^'"]+)['"]/g;
    const strippedSrc = stripComments(src);
    let w: RegExpExecArray | null;
    while ((w = workerRe.exec(strippedSrc))) {
      resolveSpec(fromRel, lineBase + lineOf(strippedSrc, w.index), 'worker', w[1]);
    }
  };

  const suspicious: string[] = [];
  const chromeTouchRe = /^\s*(?:globalThis\.)?(chrome|browser)[.?]/;

  for (const rel of allFiles) {
    // vendor/ is self-contained third-party (its own internal graph is not
    // ours to gate); the swapped polyfill is byte-verified below instead.
    if (rel.startsWith('vendor/')) continue;

    if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
      const raw = readFileSync(join(WEB_DIST, rel), 'utf8');
      scanModule(rel, raw);
      // module-scope platform-touch ratchet (line-start heuristic over
      // comment-stripped source; entries are reviewed into the allowlist).
      const stripped = stripComments(raw);
      const rawLines = raw.split('\n');
      stripped.split('\n').forEach((line, i) => {
        if (chromeTouchRe.test(line)) suspicious.push(`${rel}|${(rawLines[i] ?? line).trim()}`);
      });
    } else if (rel.endsWith('.html')) {
      const html = readFileSync(join(WEB_DIST, rel), 'utf8');
      const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let s: RegExpExecArray | null;
      while ((s = scriptRe.exec(html))) {
        const attrs = s[1];
        if (!/type\s*=\s*["']?module["']?/.test(attrs)) continue;
        const srcAttr = attrs.match(/src\s*=\s*["']([^"']+)["']/);
        if (srcAttr) resolveSpec(rel, lineOf(html, s.index), 'script src', srcAttr[1]);
        else scanModule(rel, s[2], lineOf(html, s.index) - 1);
      }
    }
  }

  // Platform-touch ratchet vs the reviewed allowlist.
  for (const touch of suspicious) {
    if (!KNOWN_BROWSER_TOUCHES.has(touch)) {
      f.violations.push(
        `[platform touch] NEW module-scope chrome./browser. use: ${touch.replace('|', ':  ')}\n`
        + '    → verify packaging/templates/browser-polyfill.web.js covers this API, then add the entry to KNOWN_BROWSER_TOUCHES in packaging/web-target.ts',
      );
    }
  }
  for (const known of KNOWN_BROWSER_TOUCHES) {
    if (!suspicious.includes(known)) f.warnings.push(`stale KNOWN_BROWSER_TOUCHES entry (no longer matches): ${known}`);
  }

  // Swap fidelity: byte-identical to the committed templates.
  for (const [rel, template] of Object.entries(WEB_SWAPS)) {
    const staged = join(WEB_DIST, rel);
    if (!existsSync(staged)) { f.violations.push(`swap missing: ${rel} (template ${template}) was not written`); continue; }
    if (!readFileSync(staged).equals(readFileSync(join(TEMPLATES_DIR, template)))) {
      f.violations.push(`swap drift: ${rel} is not byte-identical to packaging/templates/${template}`);
    }
  }
  const loader = join(WEB_DIST, 'shared', 'dweb-loader.js');
  if (!existsSync(loader) || !readFileSync(loader).equals(readFileSync(STORE_LOADER_TEMPLATE))) {
    f.violations.push('shared/dweb-loader.js is not the committed store stub template — the agent-side dweb gate is open');
  }

  // Channel posture.
  const cfg = readFileSync(join(WEB_DIST, 'shared', 'channel-config.js'), 'utf8');
  if (!cfg.includes('CHANNEL = "web"')) f.violations.push('channel-config: CHANNEL is not "web"');
  if (!cfg.includes('DWEB_ENABLED = false')) f.violations.push('channel-config: DWEB_ENABLED is not false in the web build');

  // Build stamp.
  const buildJson = join(WEB_DIST, 'build.json');
  if (!existsSync(buildJson)) f.violations.push('build.json missing — package-web did not stamp the build');
  else {
    try {
      const b = JSON.parse(readFileSync(buildJson, 'utf8'));
      if (!b.version || !b.buildId) f.violations.push('build.json lacks version/buildId');
    } catch { f.violations.push('build.json is not valid JSON'); }
  }
  const sw = readFileSync(join(WEB_DIST, 'sw.js'), 'utf8');
  // exact token names UNQUOTED — the SW comment mentions only the *-pattern
  // in prose, and matching the quoted form would miss a quoting change in the
  // template (verified: that shipped the literal token with the gate green).
  if (sw.includes('__PEERD_WEB_BUILD__') || sw.includes('__PEERD_WEB_PRECACHE__')) {
    f.violations.push('sw.js still contains unstamped __PEERD_WEB_BUILD__/__PEERD_WEB_PRECACHE__ tokens — the build stamp did not apply');
  }

  // Shippability: Cloudflare Pages per-file limit.
  for (const rel of allFiles) {
    const size = statSync(join(WEB_DIST, rel)).size;
    if (size > PAGES_FILE_LIMIT) {
      f.violations.push(`${rel} is ${(size / 1048576).toFixed(1)} MiB — over Cloudflare Pages' 25 MiB per-file limit; the deploy WILL fail`);
    } else if (size > PAGES_FILE_WARN) {
      f.warnings.push(`${rel} is ${(size / 1048576).toFixed(1)} MiB — within ${((PAGES_FILE_LIMIT - size) / 1048576).toFixed(1)} MiB of the Pages 25 MiB limit`);
    }
  }

  for (const w of f.warnings) console.warn(`⚠  ${w}`);
  if (f.violations.length > 0) {
    const msg =
      `WEB BOUNDARY VIOLATION — ${f.violations.length} problem(s) in web-dist/.\n`
      + 'Fix curation in packaging/web-target.ts (include the file, extend a stub template, or shim it), then re-run `bun run package:web`:\n\n  '
      + f.violations.join('\n  ');
    throw new Error(msg);
  }
  console.log(`web boundary OK — imports closed, swaps byte-identical, channel posture + build stamp verified (${relative(REPO_ROOT, WEB_DIST)}/).`);
};

if (import.meta.main) {
  try { await checkWebBoundary(); }
  catch (e: any) { console.error('\n' + (e?.message ?? e)); process.exit(1); }
}
