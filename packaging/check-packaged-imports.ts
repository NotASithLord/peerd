// CI guard against the v0.2.0 home black-screen class of bug: a file that
// packaging PRUNES is still STATICALLY imported by a shipped page, so in the
// packaged build the import 404s, the page's module graph fails to load, and the
// page renders blank. The e2e suite runs the UNPACKED source (nothing pruned), so
// it can never catch this — only resolving imports against the PRUNED build does.
//
// For each channel, this stages the real packaged tree (reusing packageArtifact's
// prune + generated manifest/channel-config), then walks every page's static
// import graph and asserts every target ships. Dynamic import() is intentionally
// NOT followed: a lazy import of a pruned module is the CORRECT pattern (it's
// runtime-guarded), which is exactly how the home Lab was fixed.
//
// Run: bun packaging/check-packaged-imports.ts   (also wired into CI + preflight)

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from './package.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version);

/** Recursively list every file under `dir`. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// STATIC import specifiers only — `import … from "x"` / `import "x"`. Deliberately
// excludes `import("x")` (dynamic, runtime-guarded). Two alternations: the
// from-form and the bare side-effect form.
const STATIC_IMPORT = /(?:import|export)[^"'\n]*?from\s*["']([^"']+)["']|(?:^|[;\s])import\s*["']([^"']+)["']/g;

/** Resolve a module specifier to an on-disk path under the staged build root. */
const resolveSpec = (spec: string, fromFile: string, root: string): string | null => {
  if (spec.startsWith('/')) return join(root, spec);      // root-absolute (e.g. /vendor/…)
  if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
  return null;                                            // bare specifier — unused in this codebase
};

/** BFS an entry's static import graph; return every specifier that doesn't ship. */
const unresolved = (entry: string, root: string): Array<{ spec: string; from: string }> => {
  const miss: Array<{ spec: string; from: string }> = [];
  if (!existsSync(entry)) return [{ spec: relative(root, entry), from: '(html entry)' }];
  const seen = new Set<string>([entry]);
  const queue: string[] = [entry];
  while (queue.length) {
    const file = queue.shift() as string;
    let src: string;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    STATIC_IMPORT.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = STATIC_IMPORT.exec(src))) {
      const spec = mm[1] ?? mm[2];
      if (!spec) continue;
      const r = resolveSpec(spec, file, root);
      if (!r) continue;
      if (!existsSync(r)) { miss.push({ spec, from: relative(root, file) }); continue; }
      if (!seen.has(r)) { seen.add(r); queue.push(r); }
    }
  }
  return miss;
};

/** Every module entry point that ships: each page's <script src> + the SW. */
const entryPoints = (root: string): string[] => {
  const entries = new Set<string>();
  for (const f of walk(root)) {
    if (!f.endsWith('.html')) continue;
    const html = readFileSync(f, 'utf8');
    const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html))) {
      const src = mm[1];
      entries.add(src.startsWith('/') ? join(root, src) : resolve(dirname(f), src));
    }
  }
  try {
    const sw = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))?.background?.service_worker;
    if (typeof sw === 'string') entries.add(join(root, sw));
  } catch { /* no manifest — staging always writes one */ }
  return [...entries];
};

let failed = false;
for (const channel of ['preview', 'store'] as const) {
  await packageArtifact({ channel, browser: 'chrome', version, sign: false, verify: false });
  const root = join(REPO_ROOT, 'artifacts', 'staging', `${channel}-chrome`);
  const entries = entryPoints(root);
  let chMiss = 0;
  for (const entry of entries) {
    const miss = unresolved(entry, root);
    if (!miss.length) continue;
    failed = true;
    chMiss += miss.length;
    console.error(`✗ [${channel}] ${relative(root, entry)} — ${miss.length} pruned-but-imported:`);
    for (const m of miss) console.error(`    ${m.spec}  (from ${m.from})`);
  }
  console.log(`[${channel}/chrome] ${entries.length} entry points · ${chMiss} unresolved static import(s)`);
}

if (failed) {
  console.error('\nPACKAGED IMPORT CHECK FAILED — a pruned file is still statically imported; that page will 404 + blank in the packaged build. Lazy-import it (guarded) or stop pruning it for that channel.');
  process.exit(1);
}
console.log('packaged import check OK — every page\'s static import graph resolves in both channels.');
