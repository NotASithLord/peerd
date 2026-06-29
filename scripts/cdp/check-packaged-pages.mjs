#!/usr/bin/env bun
// Behavioral packaged-page BOOT check — the runtime backstop to the static
// check:imports. It loads the PRUNED/packaged tree headless (launchPeerd with a
// staging dir, not extension/) and asserts every Mithril #app page actually
// mounts. This catches packaged-build-only RUNTIME breaks the static check can't
// see — a 404'd dynamic import of a pruned module, a regressed graceful-degrade
// path, a pruned CSS/asset — and the whole class e2e misses (it loads the
// UNPACKED source and only ever opens the side panel). This is the test that
// would have caught the v0.2.0 home black-screen directly: home/home.html's #app
// would never have gained children in the packaged build.
//
// Run: bun run check:pages   (needs Chrome for Testing: bun run e2e:chrome)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { launchPeerd, openExtPage, evalIn, waitFor, log } from './e2e-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// Pages that mount Mithril at #app — these must never render blank. Auto-
// discovered from the staged tree, so a future #app page is covered for free.
const appPages = (root) =>
  walk(root)
    .filter((f) => f.endsWith('.html') && readFileSync(f, 'utf8').includes('id="app"'))
    .map((f) => relative(root, f))
    .sort();

let failed = false;
for (const channel of ['preview', 'store']) {
  await packageArtifact({ channel, browser: 'chrome', version, sign: false, verify: false });
  const root = join(REPO_ROOT, 'artifacts', 'staging', `${channel}-chrome`);
  const pages = appPages(root);
  let ctx = null;
  try {
    // Loads the PACKAGED tree (not extension/). launchPeerd already opens +
    // mounts the side panel as part of setup, so a packaged side-panel break
    // throws here and is caught below.
    ctx = await launchPeerd({ extensionDir: root });
    for (const page of pages) {
      const p = await openExtPage(ctx, page);
      const mounted = await waitFor(
        () => evalIn(p, `(document.getElementById('app')?.childElementCount || 0) > 0`),
        { budgetMs: 12_000, pollMs: 200 });
      const errs = (p.events || []).filter((e) => /^EXC|^ERR/.test(e)).slice(0, 6);
      if (mounted && errs.length === 0) {
        log(`  ✓ [${channel}] ${page} mounted`);
      } else {
        failed = true;
        log(`  ✗ [${channel}] ${page} — ${mounted ? 'mounted but console errors' : 'NEVER MOUNTED (blank page)'}`);
        for (const e of errs) log(`      ${e}`);
      }
    }
    log(`[${channel}/chrome] booted ${pages.length} #app page(s)`);
  } catch (e) {
    failed = true;
    log(`✗ [${channel}] launch/boot failed: ${e?.message ?? e}`);
  } finally {
    try { ctx?.close(); } catch { /* */ }
  }
}

if (failed) {
  console.error('\nPACKAGED PAGE BOOT CHECK FAILED — a page rendered blank or errored in the packaged build (the v0.2.0 home black-screen class).');
  process.exit(1);
}
log('packaged page boot check OK — every #app page mounts in both channels.');
process.exit(0);
