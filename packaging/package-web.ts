// package-web.ts — build the `web` target: a curated, page-loadable library
// tree stage-copied FRESH from live extension/ source on every run, so it
// inherits upstream changes with no hand-vendored snapshots. Output: web-dist/.
//
//   bun run package:web        (build + verify — the boundary gate auto-runs,
//                               mirroring how store artifacts self-verify)
//
// Stage model, web-flavored (mirrors packaging/package.ts):
//   1. stage the curated INCLUDE dirs + files from extension/ into web-dist/
//   2. apply the committed-template SWAPS (no-throw browser-polyfill shim +
//      the two /background/ title-constant stubs), verifying each stub's
//      exported values still MATCH the real extension file (drift fails here)
//   3. generate shared/channel-config.js (web flavor: CHANNEL="web",
//      DWEB_ENABLED=false) and swap the dweb-loader stub
//   4. overlay the hand-authored shell (packaging/templates/web-shell/),
//      REFUSING any path
//      collision with staged source (shadowing = silent fork; fail loudly)
//   5. stamp build.json ({version, buildId, gitHead}) and rewrite sw.js's
//      __PEERD_WEB_*__ tokens (per-build cache name + generated precache list)
//   6. run check-web-boundary over the assembled tree

import {
  cpSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync,
  readdirSync, statSync, existsSync,
} from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, EXTENSION_DIR, TEMPLATES_DIR, STORE_LOADER_TEMPLATE, readVersion } from './lib.ts';
import { genChannelConfigSource } from './gen-channel-config.ts';
import { checkWebBoundary } from './check-web-boundary.ts';
import {
  WEB_INCLUDE_DIRS, WEB_INCLUDE_FILES, WEB_PRUNE_WITHIN, WEB_SWAPS,
  WEB_STUB_PATHS, WEB_SHELL_DIR, WEB_DIST,
} from './web-target.ts';

const isPruned = (rel: string): boolean =>
  basename(rel) === '.DS_Store'
  || rel.endsWith('.d.ts')
  // tests never ship (parity with package.ts PRUNE_ALWAYS; colocated test
  // files inside a module dir would otherwise land in the staged tree).
  || rel.endsWith('.test.js')
  || rel.split('/').includes('tests')
  || WEB_PRUNE_WITHIN.some((p) => rel === p || rel.startsWith(p + '/'))
  // swapped files are written from templates, not copied from source
  || Object.prototype.hasOwnProperty.call(WEB_SWAPS, rel);

// why the .DS_Store filter here too: staged source is filtered by isPruned,
// but the shell overlay + the hash/precache walk must apply the same hygiene —
// a Finder browse of the web-shell template must not stage junk, pollute the precache,
// or roll the buildId (local vs CI divergence for the same commit).
const isJunk = (name: string): boolean => name === '.DS_Store';

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (isJunk(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const stageDir = (dir: string): void => {
  cpSync(join(EXTENSION_DIR, dir), join(WEB_DIST, dir), {
    recursive: true,
    filter: (src) => {
      const rel = relative(EXTENSION_DIR, src);
      return rel === '' || !isPruned(rel);
    },
  });
};

// Every `export const NAME = <literal>` in a stub template must match the real
// extension file — otherwise the web tree silently diverges from upstream (the
// exact drift the stubs exist to prevent). Throws with the fix.
const verifyStubValues = (): void => {
  const exportRe = /^export const (\w+) = (.+?);/gm;
  for (const rel of WEB_STUB_PATHS) {
    const template = readFileSync(join(TEMPLATES_DIR, WEB_SWAPS[rel]), 'utf8');
    const real = readFileSync(join(EXTENSION_DIR, rel), 'utf8');
    exportRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = exportRe.exec(template))) {
      found++;
      const [, name, value] = m;
      const realMatch = real.match(new RegExp(`export const ${name} = (.+?);`));
      if (!realMatch) {
        throw new Error(
          `web stub drift: ${rel} no longer exports "${name}" (the real file renamed/removed it). `
          + `Update packaging/templates/${WEB_SWAPS[rel]} and the importing tool defs.`,
        );
      }
      if (realMatch[1] !== value) {
        throw new Error(
          `web stub drift: ${rel} exports ${name} = ${realMatch[1]} but the template has ${value}. `
          + `Update packaging/templates/${WEB_SWAPS[rel]} to match.`,
        );
      }
    }
    if (found === 0) throw new Error(`web stub template ${WEB_SWAPS[rel]} exports no constants — malformed?`);
  }
};

// The shell may only ADD files; a path collision with staged source means the
// shell is shadowing a real module — a silent fork check-web-boundary cannot
// see (the import still resolves). Fail loudly instead.
const assertNoShellCollisions = (): void => {
  const collisions = walk(WEB_SHELL_DIR)
    .map((f) => relative(WEB_SHELL_DIR, f))
    .filter((rel) => basename(rel) !== '.DS_Store' && existsSync(join(WEB_DIST, rel)));
  if (collisions.length > 0) {
    throw new Error(
      'web shell collision: these template files would OVERWRITE staged extension source '
      + '(shadowing = a silent fork of real modules):\n  ' + collisions.join('\n  ')
      + '\nRename the shell path or, if replacing source is intended, make it an explicit WEB_SWAPS template.',
    );
  }
};

export const buildWebTarget = async (): Promise<void> => {
  const version = readVersion();
  rmSync(WEB_DIST, { recursive: true, force: true });
  mkdirSync(WEB_DIST, { recursive: true });

  for (const dir of WEB_INCLUDE_DIRS) stageDir(dir);

  for (const file of WEB_INCLUDE_FILES) {
    const dst = join(WEB_DIST, file);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(EXTENSION_DIR, file), dst);
  }

  verifyStubValues();
  for (const [rel, template] of Object.entries(WEB_SWAPS)) {
    const dst = join(WEB_DIST, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(TEMPLATES_DIR, template), dst);
  }

  // Generated + swapped channel files. Web flavor = CHANNEL "web",
  // DWEB_ENABLED false: the agent-side dweb gate stays shut (loader stubbed),
  // and peerd-distributed itself is not staged at all (web-target.ts).
  writeFileSync(join(WEB_DIST, 'shared', 'channel-config.js'), genChannelConfigSource('web'));
  copyFileSync(STORE_LOADER_TEMPLATE, join(WEB_DIST, 'shared', 'dweb-loader.js'));

  assertNoShellCollisions();
  cpSync(WEB_SHELL_DIR, WEB_DIST, { recursive: true, filter: (src) => !isJunk(basename(src)) });

  // Build identity: content-hash the whole tree (sw.js and build.json excluded
  // — they embed the hash). Deterministic for identical inputs; any source or
  // shell change rolls the SW cache name and invalidates staged modules.
  const hash = createHash('sha256');
  const files = walk(WEB_DIST)
    .map((f) => relative(WEB_DIST, f))
    .filter((rel) => rel !== 'sw.js' && rel !== 'build.json')
    .sort();
  for (const rel of files) { hash.update(rel); hash.update('\0'); hash.update(readFileSync(join(WEB_DIST, rel))); }
  const buildId = `${version}-${hash.digest('hex').slice(0, 12)}`;

  let gitHead: string | null = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim(); }
  catch { /* not a git checkout (e.g. exported tarball) — stamp without it */ }

  writeFileSync(join(WEB_DIST, 'build.json'), JSON.stringify({ version, buildId, gitHead }, null, 2) + '\n');

  // Stamp sw.js: per-build cache name + a GENERATED precache list (every
  // non-vendor file — so a served tree works offline without a hand-maintained
  // SHELL list that drifts from the real import graph).
  // '/index.html' is deliberately NOT precached: static hosts redirect it to
  // '/', and a cached REDIRECTED response is rejected by respondWith for
  // navigations — '/' is the canonical precached document.
  const precache = ['/', ...files
    .filter((rel) => !rel.startsWith('vendor/') && rel !== '_headers' && rel !== 'index.html')
    .map((rel) => '/' + rel)];
  const swPath = join(WEB_DIST, 'sw.js');
  const swSrc = readFileSync(swPath, 'utf8');
  if (!swSrc.includes('__PEERD_WEB_BUILD__') || !swSrc.includes('__PEERD_WEB_PRECACHE__')) {
    throw new Error('web-shell/sw.js is missing a __PEERD_WEB_*__ stamp token; the SW template drifted.');
  }
  // quote-agnostic: match the PRECACHE token however it is quoted, then assert
  // NOTHING token-shaped survived — a quoting change in sw.js must fail the
  // build, never silently ship the literal token (verified failure mode:
  // JSON.parse of the literal throws, is caught, and the page loses its
  // entire precache with every gate green).
  const stamped = swSrc
    .replace('__PEERD_WEB_BUILD__', buildId)
    .replace(/['"`]__PEERD_WEB_PRECACHE__['"`]/, JSON.stringify(JSON.stringify(precache)));
  if (stamped.includes('__PEERD_WEB_BUILD__') || stamped.includes('__PEERD_WEB_PRECACHE__')) {
    throw new Error('web-shell/sw.js stamp did not apply; a __PEERD_WEB_*__ token is malformed in the SW template.');
  }
  writeFileSync(swPath, stamped);

  console.log(`web target staged -> ${relative(REPO_ROOT, WEB_DIST)}/ (web v${version}, build ${buildId})`);

  await checkWebBoundary();
};

if (import.meta.main) await buildWebTarget();
