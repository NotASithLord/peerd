#!/usr/bin/env bun
// Behavioral packaged-page BOOT check — the runtime backstop to the static
// check:imports, and the broad net that catches the WHOLE "works in dev, blank
// in a packaged install" class. It packages each channel, loads the PRUNED tree
// headless via launchPeerd(extensionDir) (not extension/), boots every
// user-openable shipped page, and exercises the singleton offscreen page through
// its real repository-host path, asserting each referenced nothing it didn't ship.
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
//   - other pages (engine tabs, mic, dwapps): assert load + zero
//     missing same-origin resource; exceptions are NOTED, not failed (booting a
//     page out of its normal context — e.g. an unbound engine tab — can throw on a
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
const closeProbePage = async (page) => {
  if (!page) return;
  try {
    if (typeof page.closeTarget === 'function') await page.closeTarget();
    else page.close();
  } catch { /* the target may already have retired */ }
};

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
const appReadyProbe = (page) => {
  if (page === 'sidepanel/sidepanel.html' || page === 'home/home.html') {
    const selector = page === 'sidepanel/sidepanel.html'
      ? '.app-shell' : '.home-shell, .options-gate';
    return `document.readyState === 'complete'
      && document.documentElement.dataset.peerdBootModule === 'evaluated'
      && ((document.documentElement.dataset.peerdBootStage === 'vault-ready'
          && !!document.querySelector('.gate-card button:not([disabled])'))
        || (document.documentElement.dataset.peerdBootStage === 'app-ready'
          && !!document.querySelector(${JSON.stringify(selector)})))`;
  }
  return `(document.getElementById('app')?.childElementCount || 0) > 0`;
};

// A same-origin (chrome-extension://) load failure = a file the packaged build
// references but didn't ship. Ignore favicon (Chrome auto-requests it; extensions
// ship none) and cross-origin misses (test-env noise, not our artifact).
const sameOriginNetFails = (events) => (events || [])
  .filter((e) => e.startsWith('NETFAIL') && e.includes('chrome-extension://')
    && !e.includes('/favicon.ico')
    // .map sourcemaps aren't shipped + are only fetched under the Debugger domain
    // (we don't enable it) — exclude them so adding Debugger later can't red the gate.
    && !/\.map(\?|#|$)/.test(e));
const exceptions = (events) => (events || []).filter((e) => /^EXC |^ERR /.test(e));

// Runs inside a real packaged extension page. Preview first proves that the
// reachable module fixture is fetched and its canary executes in the sealed
// worker. Store then receives the same fetch capability deliberately and must
// still refuse every adversarial source before a request or worker exists.
const packagedRemoteImportProbe = async (remoteUrl, channel, notebookId) => {
  const [{ buildWorkerSource }, { makeFetchRemote }, { REMOTE_MODULE_IMPORTS_ENABLED }] = await Promise.all([
    import('/engine-tabs/notebook-tab/worker-source.js'),
    import('/peerd-engine/index.js'),
    import('/shared/channel-config.js'),
  ]);
  let fetchCalls = 0;
  const urls = [];
  const makeDeps = () => ({
    remoteModulesEnabled: REMOTE_MODULE_IMPORTS_ENABLED,
    // Inject even in Store. The package policy must remain the independent
    // fail-closed grant, not merely rely on the production host omitting this.
    fetchRemote: async (url) => {
      fetchCalls += 1;
      urls.push(url);
      return makeFetchRemote((request) => chrome.runtime.sendMessage({
        type: 'sw/web-fetch',
        ...request,
        abortToken: crypto.randomUUID(),
        notebookId,
      }))(url);
    },
    readFile: async () => { throw new Error('unexpected local module read'); },
    makeBlobUrl: (source) => URL.createObjectURL(
      new Blob([source], { type: 'application/javascript' })),
  });

  if (channel === 'preview') {
    let computedRefusal = null;
    try {
      await buildWorkerSource(`const url = ${JSON.stringify(remoteUrl)}; return import(url);`, {
        notebookId,
        resolverDeps: makeDeps(),
      });
    } catch (error) {
      computedRefusal = error?.code ?? null;
    }
    // The source spells the scheme with a JavaScript escape. Acorn must decode
    // it and the resolver must still route the request through audited fetch.
    const escapedRemoteUrl = remoteUrl.replace(/^h/, '\\x68');
    const built = await buildWorkerSource(
      `import { value } from '${escapedRemoteUrl}'; return value;`,
      { notebookId, resolverDeps: makeDeps() },
    );
    const workerUrl = URL.createObjectURL(new Blob([built.source], {
      type: 'application/javascript',
    }));
    const result = await new Promise((resolve) => {
      const worker = new Worker(workerUrl, { type: 'module' });
      const timer = setTimeout(() => {
        worker.terminate();
        resolve({ error: 'worker timed out' });
      }, 8000);
      worker.addEventListener('message', (event) => {
        if (event.data?.type !== 'done') return;
        clearTimeout(timer);
        worker.terminate();
        resolve({ value: event.data.value, error: event.data.error ?? null });
      });
      worker.addEventListener('error', (event) => {
        clearTimeout(timer);
        worker.terminate();
        resolve({ error: event.message || 'worker crashed' });
      });
    });
    URL.revokeObjectURL(workerUrl);
    for (const entry of built.cache.values()) URL.revokeObjectURL(entry.blobUrl);
    return {
      enabled: REMOTE_MODULE_IMPORTS_ENABLED,
      computedRefusal,
      fetchCalls,
      urls,
      result,
    };
  }

  const cases = [
    ['static', `import ${JSON.stringify(remoteUrl)};`],
    ['postfix', `let n = 1; const url = ${JSON.stringify(remoteUrl)}; n++ / import(url) / 2;`],
    ['ASI', `const url = ${JSON.stringify(remoteUrl)}; { import(url)\n{} }`],
    ['normalized', `import ' https:\\\\remote-module.test/normalized.js';`],
    ['escaped', `import '\\x68ttps://remote-module.test/escaped.js';`],
    ['data', "import('data:text/javascript,globalThis.__storeCanary=true')"],
  ];
  const refusals = [];
  for (const [name, source] of cases) {
    try {
      await buildWorkerSource(source, {
        notebookId,
        resolverDeps: makeDeps(),
      });
      refusals.push({ name, code: null });
    } catch (error) {
      refusals.push({ name, code: error?.code ?? null });
    }
  }
  return { enabled: REMOTE_MODULE_IMPORTS_ENABLED, fetchCalls, urls, refusals };
};

// Exact packaged regression for the operation-lazy repository split. It must
// cross SW -> authenticated offscreen loader -> dynamic isomorphic-git -> OPFS
// and return without putting the vendor back in the cold worker graph.
const preparePackagedVault = async () => {
  const vaultState = await chrome.runtime.sendMessage({ type: 'state/get' });
  if (!vaultState?.vault?.initialized) {
    const initialized = await chrome.runtime.sendMessage({
      type: 'vault/initialize', passphrase: 'packaged-probe-only-32-bytes!',
    });
    if (!initialized?.ok) return { ok: false, phase: 'vault-initialize', initialized };
  } else if (vaultState?.vault?.locked) {
    const unlocked = await chrome.runtime.sendMessage({
      type: 'vault/unlock', passphrase: 'packaged-probe-only-32-bytes!',
    });
    if (!unlocked?.ok) return { ok: false, phase: 'vault-unlock', unlocked };
  }
  return { ok: true };
};

const packagedAppImportProbe = async () => {
  const { buildAppExport } = await import('/peerd-engine/index.js');
  const envelope = await buildAppExport({
    record: { name: 'Packaged Git Probe', entryFile: 'index.html', tags: ['ci-probe'] },
    files: {
      'index.html': '<!doctype html><title>Packaged Git Probe</title><main>ready</main>',
      'assets/raw.bin': new Uint8Array([0, 1, 2, 255]),
    },
  });
  const imported = await chrome.runtime.sendMessage({ type: 'import/apply', envelope });
  if (!imported?.ok || imported.kind !== 'app') return { ok: false, phase: 'import', imported };
  return { ok: true, appId: imported.id };
};

const packagedRepositoryProbe = async (appId) => {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'apps/repository/status', appId });
    const branch = await chrome.runtime.sendMessage({
      type: 'apps/repository/branch', appId, name: 'ci/repository-host', checkout: true,
    });
    const history = await chrome.runtime.sendMessage({
      type: 'apps/repository/history', appId, depth: 5,
    });
    return { ok: status?.ok === true && !!status.status?.oid && branch?.ok === true
      && history?.ok === true && history.commits?.length >= 1, status, branch, history };
  } finally {
    await chrome.runtime.sendMessage({ type: 'apps/delete', appId }).catch(() => {});
  }
};

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

    // All three behavioral probes are post-vault capabilities. Establish that
    // posture through the real Options owner before asking an engine page or
    // Home to load their demand-owned runtimes.
    let vaultPage = null;
    try {
      vaultPage = await openExtPage(ctx, 'options/options.html');
      const prepared = await evalIn(vaultPage, `(${preparePackagedVault.toString()})()`, true);
      if (!prepared?.ok) {
        failed = true;
        log(`  ✗ [${channel}] packaged vault preparation: ${JSON.stringify(prepared)}`);
      }
    } catch (error) {
      failed = true;
      log(`  ✗ [${channel}] packaged vault preparation failed: ${error?.message ?? error}`);
    } finally {
      await closeProbePage(vaultPage);
    }

    // Browser-level package policy proof. CDP fulfills one HTTPS module URL at
    // the wire, so the fixture is deterministic and no public network is used.
    // Preview must execute it; Store must not request it.
    const remoteUrl = 'https://remote-module.test/store-policy-canary.js';
    const policyNotebookId = 'packaged-policy-probe';
    let policyPage = null;
    const fixtureRequestsBefore = ctx.remoteModuleRequestCount();
    try {
      policyPage = await openExtPage(
        ctx, `engine-tabs/notebook-tab/index.html#${encodeURIComponent(policyNotebookId)}`,
      );
      const probe = await evalIn(
        policyPage,
        `(${packagedRemoteImportProbe.toString()})(${JSON.stringify(remoteUrl)}, ${JSON.stringify(channel)}, ${JSON.stringify(policyNotebookId)})`,
        true,
      );
      const fixtureRequests = ctx.remoteModuleRequestCount() - fixtureRequestsBefore;
      const storeCodes = channel === 'store'
        ? Object.fromEntries(probe.refusals.map((entry) => [entry.name, entry.code]))
        : {};
      const expectedStoreCodes = {
        static: 'remote_module_imports_unavailable',
        postfix: 'unsupported_native_module_import',
        ASI: 'unsupported_native_module_import',
        normalized: 'remote_module_imports_unavailable',
        escaped: 'remote_module_imports_unavailable',
        data: 'unsupported_native_module_import',
      };
      const policyOk = channel === 'preview'
        ? probe.enabled === true
          && probe.computedRefusal === 'unsupported_native_module_import'
          && probe.fetchCalls === 1
          && fixtureRequests === 1
          && probe.result?.value === 'remote-canary-executed'
          && !probe.result?.error
        : probe.enabled === false
          && probe.fetchCalls === 0
          && fixtureRequests === 0
          && JSON.stringify(storeCodes) === JSON.stringify(expectedStoreCodes);
      if (!policyOk) {
        failed = true;
        log(`  ✗ [${channel}] packaged remote-import policy: ${JSON.stringify({ probe, fixtureRequests })}`);
      } else {
        log(`  ✓ [${channel}] packaged remote-import policy exercised in browser`);
      }
    } catch (error) {
      failed = true;
      const fixtureRequests = ctx.remoteModuleRequestCount() - fixtureRequestsBefore;
      log(`  ✗ [${channel}] packaged remote-import policy probe failed after ${fixtureRequests} fixture request(s): ${error?.message ?? error}`);
    } finally {
      await closeProbePage(policyPage);
    }

    let importPage = null;
    let repositoryPage = null;
    try {
      // Exact route provenance is part of the product boundary: artifact import
      // belongs to Options, while repository management and deletion belong to
      // the human Home surface. The smoke must use those real owners.
      importPage = await openExtPage(ctx, 'options/options.html');
      const imported = await evalIn(
        importPage, `(${packagedAppImportProbe.toString()})()`, true,
      );
      if (!imported?.ok) {
        failed = true;
        log(`  ✗ [${channel}] packaged app import probe: ${JSON.stringify(imported)}`);
      } else {
        repositoryPage = await openExtPage(ctx, 'home/home.html');
        const repository = await evalIn(
          repositoryPage,
          `(${packagedRepositoryProbe.toString()})(${JSON.stringify(imported.appId)})`,
          true,
        );
        if (!repository?.ok) {
          failed = true;
          log(`  ✗ [${channel}] packaged lazy repository probe: ${JSON.stringify(repository)}`);
        } else log(`  ✓ [${channel}] packaged lazy repository + binary OPFS probe`);
      }
    } catch (error) {
      failed = true;
      log(`  ✗ [${channel}] packaged lazy repository probe failed: ${error?.message ?? error}`);
    } finally {
      await closeProbePage(importPage);
      await closeProbePage(repositoryPage);
    }

    for (const page of pages) {
      if (page === 'offscreen/offscreen.html') {
        // It is a singleton lease host, not a user-openable page. The remote
        // module and repository probes above exercise the real packaged host;
        // opening a second tab copy would create an impossible competing host.
        log(`  ✓ [${channel}] ${page} exercised through its singleton host`);
        continue;
      }
      const app = isAppPage(root, page);
      let p = null; let mounted = true; let openErr = null;
      const launchSidepanel = page === 'sidepanel/sidepanel.html';
      try {
        // launchPeerd already opened and mounted the real side panel. Opening a
        // second copy races the single named UI port and tests an impossible
        // product posture, so validate the existing surface in place.
        p = launchSidepanel ? ctx.page : await openExtPage(ctx, page);
        const ready = app
          ? appReadyProbe(page)
          : `document.readyState === 'complete'`;
        const budgetMs = page === 'sidepanel/sidepanel.html' || page === 'home/home.html'
          ? 60_000
          : 12_000;
        mounted = await waitFor(() => evalIn(p, ready), { budgetMs, pollMs: 200 });
        await sleep(SETTLE_MS);
      } catch (e) { openErr = e?.message ?? String(e); }
      const netFails = p ? sameOriginNetFails(p.events) : [];
      const excs = p ? exceptions(p.events) : [];
      if (!launchSidepanel) await closeProbePage(p);
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
