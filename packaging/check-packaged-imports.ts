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
// Static import specifiers, ANCHORED to line start (m flag) so a mid-line or
// commented "import"/"from" can't bridge into a false match. The head allows
// newlines (a static import can span lines: `import {\n a,\n b\n} from '/x'`) but
// is bounded by `;` and quotes so it can't run across statements. `import(…)`
// (dynamic) has a `(` after import + no `from`, so neither alternation matches —
// dynamic imports are runtime-guarded and intentionally skipped.
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;"']*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;

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
    const bg = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))?.background;
    // Chrome: background.service_worker (string). Firefox: gen-manifest rewrites
    // it to background.scripts (array) — so the Firefox SW import graph would be
    // silently never walked if we only read service_worker. Handle both shapes.
    if (typeof bg?.service_worker === 'string') entries.add(join(root, bg.service_worker));
    if (Array.isArray(bg?.scripts)) {
      for (const s of bg.scripts) if (typeof s === 'string') entries.add(join(root, s));
    }
  } catch { /* no manifest — staging always writes one */ }
  return [...entries];
};

/**
 * Manifest-declared asset paths that must ship in the pruned tree: icons,
 * action.default_icon, and web_accessible_resources. A channel patch pointing any
 * of these at a pruned/missing file ships a broken icon or a 404'd resource that
 * neither the import walk nor a page boot would catch. Returns the missing paths.
 */
const missingManifestAssets = (root: string): string[] => {
  let manifest: {
    icons?: Record<string, string>;
    action?: { default_icon?: string | Record<string, string>; default_popup?: string };
    web_accessible_resources?: Array<{ resources?: string[] }>;
    side_panel?: { default_path?: string };
    options_ui?: { page?: string };
    sidebar_action?: { default_panel?: string };
    sandbox?: { pages?: string[] };
  };
  try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
  catch { return []; }
  const miss: string[] = [];
  const check = (p: unknown, where: string): void => {
    if (typeof p !== 'string' || /^(https?:|data:)/.test(p)) return;
    if (!existsSync(join(root, p.replace(/^\//, '')))) miss.push(`${p}  (${where})`);
  };
  for (const p of Object.values(manifest.icons ?? {})) check(p, 'icons');
  const di = manifest.action?.default_icon;
  if (typeof di === 'string') check(di, 'action.default_icon');
  else for (const p of Object.values(di ?? {})) check(p, 'action.default_icon');
  // HTML ENTRY POINTERS — a manifest field aiming at a page that doesn't ship is a
  // blank surface when the browser opens it (the entryPoints walk only finds pages
  // that EXIST, so it can't see a pointer at a pruned one).
  check(manifest.action?.default_popup, 'action.default_popup');
  check(manifest.side_panel?.default_path, 'side_panel.default_path');
  check(manifest.options_ui?.page, 'options_ui.page');
  check(manifest.sidebar_action?.default_panel, 'sidebar_action.default_panel');
  for (const p of manifest.sandbox?.pages ?? []) check(p, 'sandbox.pages');
  for (const war of manifest.web_accessible_resources ?? []) {
    for (const r of war?.resources ?? []) {
      if (typeof r !== 'string') continue;
      // Literal path → check directly; glob → check its base dir still ships (a
      // glob into a fully-pruned dir, e.g. tests/**, then matches nothing).
      if (r.includes('*')) {
        const base = r.split('*')[0].replace(/\/$/, '').replace(/^\//, '');
        if (base && !existsSync(join(root, base))) miss.push(`${r}  (web_accessible_resources — base '${base}' pruned)`);
      } else check(r, 'web_accessible_resources');
    }
  }
  return miss;
};

let failed = false;
// The full 2×2 release matrix. Firefox diverges most (manifest transform strips
// sidePanel/offscreen/debugger and rewrites the SW shape), so its import graph
// needs its own walk — the static resolver needs no browser to run.
for (const channel of ['preview', 'store'] as const) {
  for (const browser of ['chrome', 'firefox'] as const) {
    await packageArtifact({ channel, browser, version, sign: false, verify: false });
    const root = join(REPO_ROOT, 'artifacts', 'staging', `${channel}-${browser}`);
    const entries = entryPoints(root);
    let chMiss = 0;
    for (const entry of entries) {
      const miss = unresolved(entry, root);
      if (!miss.length) continue;
      failed = true;
      chMiss += miss.length;
      console.error(`✗ [${channel}/${browser}] ${relative(root, entry)} — ${miss.length} pruned-but-imported:`);
      for (const m of miss) console.error(`    ${m.spec}  (from ${m.from})`);
    }
    const assetMiss = missingManifestAssets(root);
    for (const a of assetMiss) { failed = true; console.error(`✗ [${channel}/${browser}] manifest asset missing — ${a}`); }
    console.log(`[${channel}/${browser}] ${entries.length} entry points · ${chMiss} unresolved import(s) · ${assetMiss.length} missing manifest asset(s)`);
  }
}

if (failed) {
  console.error('\nPACKAGED IMPORT CHECK FAILED — a pruned file is still statically imported; that page will 404 + blank in the packaged build. Lazy-import it (guarded) or stop pruning it for that channel.');
  process.exit(1);
}
console.log('packaged import check OK — every page\'s static import graph resolves in all channel×browser builds.');
