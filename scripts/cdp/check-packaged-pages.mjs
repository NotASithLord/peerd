#!/usr/bin/env bun
// Behavioral packaged-page BOOT check — the runtime backstop to the static
// check:imports, and the broad net that catches the WHOLE "works in dev, blank
// in a packaged install" class. It packages each channel, loads the PRUNED tree
// headless via launchPeerd(extensionDir) (not extension/), and boots EVERY
// shipped page, asserting it referenced nothing it didn't ship.
//
// The class-killer signal is a failed SAME-ORIGIN (chrome-extension://) resource
// load: Chrome emits NO console error for a missing subresource (CSS/font/wasm/
// img/dynamic-import), so a pruned asset would otherwise ship silently with every
// other guard green. We capture Network.loadingFailed/4xx in the harness and fail
// on any same-origin miss — one assertion covers JS, CSS, fonts, wasm, and
// at-load dynamic imports, on every page, with no per-asset parser to maintain.
//
//   - #app pages (home/options/sidepanel): ALSO assert Mithril mounts + zero
//     uncaught exceptions (clean UI pages — strict).
//   - other pages (engine tabs, offscreen, mic, dwapps): assert load + zero
//     missing same-origin resource; exceptions are NOTED, not failed (booting a
//     page out of its normal context — e.g. the offscreen doc — can throw on a
//     healthy build, so the reliable signal there is the resource miss).
//
// Per-channel page sets fall out for free: walk() lists only files present in the
// staged tree, so a page pruned for a channel (commons in store) is simply not
// booted there.
//
// Run: bun run check:pages   (needs Chrome for Testing: bun run e2e:chrome)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { launchPeerd, openExtPage, evalIn, waitFor, log } from './e2e-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version);
const SETTLE_MS = 2000;   // let late dynamic-import / asset loadingFailed events land
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// Every shipped page in the staged tree.
const htmlPages = (root) =>
  walk(root).filter((f) => f.endsWith('.html')).map((f) => relative(root, f)).sort();
// Mithril mount pages get the strict treatment.
const isAppPage = (root, page) => readFileSync(join(root, page), 'utf8').includes('id="app"');

// A same-origin (chrome-extension://) load failure = a file the packaged build
// references but didn't ship. Ignore favicon (Chrome auto-requests it; extensions
// ship none) and cross-origin misses (test-env noise, not our artifact).
const sameOriginNetFails = (events) => (events || [])
  .filter((e) => e.startsWith('NETFAIL') && e.includes('chrome-extension://') && !e.includes('/favicon.ico'));
const exceptions = (events) => (events || []).filter((e) => /^EXC |^ERR /.test(e));

let failed = false;
for (const channel of ['preview', 'store']) {
  await packageArtifact({ channel, browser: 'chrome', version, sign: false, verify: false });
  const root = join(REPO_ROOT, 'artifacts', 'staging', `${channel}-chrome`);
  const pages = htmlPages(root);
  let ctx = null;
  try {
    // Loads the PACKAGED tree (not extension/). launchPeerd opens + mounts the
    // side panel as part of setup, so a packaged side-panel break throws here.
    ctx = await launchPeerd({ extensionDir: root });
    for (const page of pages) {
      const app = isAppPage(root, page);
      let p = null; let mounted = true; let openErr = null;
      try {
        p = await openExtPage(ctx, page);
        const ready = app
          ? `(document.getElementById('app')?.childElementCount || 0) > 0`
          : `document.readyState === 'complete'`;
        mounted = await waitFor(() => evalIn(p, ready), { budgetMs: 12_000, pollMs: 200 });
        await sleep(SETTLE_MS);
      } catch (e) { openErr = e?.message ?? String(e); }
      const netFails = p ? sameOriginNetFails(p.events) : [];
      const excs = p ? exceptions(p.events) : [];
      try { p?.close(); } catch { /* */ }
      // Hard fail: an open failure, a missing same-origin resource (ANY page), a
      // non-mounting #app page, or an uncaught exception on an #app page.
      const hardFail = !!openErr || netFails.length > 0 || (app && (!mounted || excs.length > 0));
      if (hardFail) {
        failed = true;
        const why = openErr ? `open failed: ${openErr}`
          : netFails.length ? 'missing same-origin resource(s)'
          : !mounted ? 'NEVER MOUNTED (blank page)'
          : 'uncaught exception';
        log(`  ✗ [${channel}] ${page} — ${why}`);
        for (const e of [...netFails, ...(app ? excs : [])].slice(0, 6)) log(`      ${e}`);
      } else {
        const note = !app && excs.length ? ` (${excs.length} non-fatal exception(s) — out-of-context boot)` : '';
        log(`  ✓ [${channel}] ${page}${app ? ' mounted' : ' loaded'}${note}`);
      }
    }
    log(`[${channel}/chrome] booted ${pages.length} page(s)`);
  } catch (e) {
    failed = true;
    log(`✗ [${channel}] launch/boot failed: ${e?.message ?? e}`);
  } finally {
    try { ctx?.close(); } catch { /* */ }
  }
}

if (failed) {
  console.error('\nPACKAGED PAGE BOOT CHECK FAILED — a page rendered blank, threw, or referenced a missing file in the packaged build (the v0.2.0 black-screen class).');
  process.exit(1);
}
log('packaged page boot check OK — every shipped page boots with no missing same-origin resource, both channels.');
process.exit(0);
