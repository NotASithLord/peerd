#!/usr/bin/env bun
// Firefox runtime gate, first slice.
//
// This installs the real staged Store XPI as a temporary add-on, boots its
// background page and primary UI pages, and exercises the real Firefox
// scripting fallback. It then runs the shared browser suite from source under
// Gecko. That second signal is web-platform coverage, not packaged-XPI parity.
// Chrome remains the only pixel-baseline authority; Firefox screenshots are
// diagnostic.

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { startGeckodriver, waitFor } from './webdriver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXTENSION = join(ROOT, 'extension');
const OUTPUT = join(ROOT, 'artifacts', 'firefox-runtime');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const TEST_UUID = '7d12f198-31fc-4e95-9184-e954123981a6';
const EXTENSION_ORIGIN = `moz-extension://${TEST_UUID}`;
const FIXTURE_PATH = '/__firefox-runtime-fixture';
const RESULT_BUDGET_MS = 180_000;

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });

const firefoxBinary = process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  ].find(existsSync)
  || onPath('firefox');
const geckodriverBinary = process.env.GECKODRIVER_PATH || onPath('geckodriver');

const assert = (condition, message, detail = '') => {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  console.log(`  ✓ ${message}`);
};

const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.mjs': 'text/javascript', '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

const startTestServer = async () => {
  const server = createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400); response.end('bad request'); return; }
    if (pathname === FIXTURE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Firefox runtime fixture</title>
<body>
  <button id="firefox-action" type="button">Firefox parity action</button>
  <label for="firefox-input">Firefox parity input</label>
  <input id="firefox-input">
  <output id="firefox-status" role="status">ready</output>
  <script>
    document.getElementById('firefox-action').addEventListener('click', () => {
      document.body.dataset.clicked = 'yes';
    });
    document.getElementById('firefox-input').addEventListener('input', (event) => {
      document.getElementById('firefox-status').textContent = event.target.value;
    });
  </script>
</body></html>`);
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = join(EXTENSION, pathname);
    if (!file.startsWith(`${EXTENSION}${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404); response.end('not found'); return;
    }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) throw new Error('Firefox test server did not receive a port');
  return { port, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
};

const main = async () => {
  if (!firefoxBinary) throw new Error('Firefox not found. Set FIREFOX_PATH.');
  if (!geckodriverBinary) throw new Error('geckodriver not found. Set GECKODRIVER_PATH.');
  mkdirSync(OUTPUT, { recursive: true });
  for (const diagnostic of ['failure.png', 'geckodriver.log', 'sidepanel.png']) {
    rmSync(join(OUTPUT, diagnostic), { force: true });
  }

  console.log('Firefox packaged Store smoke: build and install');
  const artifact = await packageArtifact({
    channel: 'store', browser: 'firefox', version: VERSION, sign: false, verify: true,
  });
  const server = await startTestServer();
  const driver = await startGeckodriver({
    binary: geckodriverBinary,
    firefoxBinary,
    prefs: {
      'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: TEST_UUID }),
    },
  });

  try {
    await driver.setWindowRect({ width: 400, height: 900, x: 0, y: 0 });
    console.log(`  installing ${artifact}`);
    const installedId = await driver.installAddon(resolve(artifact));
    assert(installedId === ADDON_ID, 'temporary add-on id matches the Store manifest', String(installedId));

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const mounted = await waitFor(() => driver.execute(
      "return document.readyState === 'complete' && (document.getElementById('app')?.childElementCount || 0) > 0;",
    ), { budgetMs: 30_000 });
    assert(mounted === true, 'packaged Firefox side panel mounts');

    const posture = await driver.execute(`
      return {
        runtimeId: chrome.runtime.id,
        scripting: typeof chrome.scripting?.executeScript,
        sidebar: typeof chrome.sidebarAction?.open,
        debuggerApi: typeof chrome.debugger,
        offscreenApi: typeof chrome.offscreen,
      };
    `);
    assert(posture?.runtimeId === ADDON_ID, 'packaged page runs under the expected extension identity', JSON.stringify(posture));
    assert(posture?.scripting === 'function', 'Firefox exposes the scripting fallback');
    assert(posture?.sidebar === 'function', 'Firefox exposes the sidebar API');
    assert(posture?.debuggerApi === 'undefined', 'Firefox package has no debugger API path');
    assert(posture?.offscreenApi === 'undefined', 'Firefox package has no offscreen API path');

    const background = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      const send = (message) => browser.runtime.sendMessage(message);
      (async () => {
        const before = await send({ type: 'state/get' });
        const passphrase = 'firefox-runtime-passphrase-canary-7d12f198';
        const providerKey = 'sk-ant-firefox-provider-canary-7d12f198';
        const sensitiveNames = new Set([
          'key', 'plaintext', 'passphrase', 'prfoutput', 'apikey', 'secret',
          'keymaterial', 'accesstoken', 'providertoken', 'providerkey',
          'wrappeddk', 'datakey', 'masterkey', 'privatekey',
        ]);
        const scan = (value, snapshotName, path = '', leaks = []) => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            const next = path ? path + '.' + key : key;
            const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (typeof child === 'string' && child.length > 0 && sensitiveNames.has(normalized)) {
              leaks.push(snapshotName + '.' + next);
            }
            scan(child, snapshotName, next, leaks);
          }
          return leaks;
        };
        const initialized = await send({ type: 'vault/initialize', passphrase });
        const providerSaved = await send({
          type: 'provider/setKey', provider: 'anthropic', plaintext: providerKey,
        });
        const afterInitialize = await send({ type: 'state/get' });
        const sessions = await send({ type: 'session/list' });
        const locked = await send({ type: 'vault/lock' });
        const afterLock = await send({ type: 'state/get' });
        const wrongUnlock = await send({ type: 'vault/unlock', passphrase: passphrase + '-wrong' });
        const afterWrongUnlock = await send({ type: 'state/get' });
        const unlocked = await send({ type: 'vault/unlock', passphrase });
        const afterUnlock = await send({ type: 'state/get' });
        const snapshots = {
          before: before?.state,
          afterInitialize: afterInitialize?.state,
          afterLock: afterLock?.state,
          afterWrongUnlock: afterWrongUnlock?.state,
          afterUnlock: afterUnlock?.state,
        };
        const sensitivePaths = Object.entries(snapshots).flatMap(([name, state]) => scan(state, name) || []);
        const canaryPaths = Object.entries(snapshots).flatMap(([name, state]) => {
          const serialized = JSON.stringify(state) ?? '';
          return [
            ...(serialized.includes(passphrase) ? [name + '.passphrase-canary'] : []),
            ...(serialized.includes(providerKey) ? [name + '.provider-key-canary'] : []),
          ];
        });
        return {
          ok: before?.ok === true,
          initiallyLocked: before?.state?.vault?.locked,
          sensitivePaths,
          canaryPaths,
          initialized: initialized?.ok === true,
          providerSaved: providerSaved?.ok === true,
          unlockedAfterInitialize: afterInitialize?.state?.vault?.locked === false,
          sessionsReadable: sessions?.ok === true && Array.isArray(sessions.sessions),
          locked: locked?.ok === true && afterLock?.state?.vault?.locked === true,
          wrongPassphraseRefused: wrongUnlock?.ok === false
            && wrongUnlock?.error === 'wrong-passphrase'
            && afterWrongUnlock?.state?.vault?.locked === true,
          unlocked: unlocked?.ok === true && afterUnlock?.state?.vault?.locked === false,
        };
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(background?.ok === true, 'Firefox background module answers real extension RPCs', JSON.stringify(background));
    assert(background?.initiallyLocked === true, 'fresh Firefox profile starts with the vault locked', JSON.stringify(background));
    assert(background?.sensitivePaths?.length === 0 && background?.canaryPaths?.length === 0,
      'locked and unlocked state snapshots expose no secret-bearing fields', JSON.stringify(background));
    assert(background?.initialized === true && background?.unlockedAfterInitialize === true,
      'Firefox initializes the encrypted vault', JSON.stringify(background));
    assert(background?.providerSaved === true, 'Firefox stores a provider key in the encrypted vault', JSON.stringify(background));
    assert(background?.sessionsReadable === true, 'Firefox reads session storage through the live background', JSON.stringify(background));
    assert(background?.wrongPassphraseRefused === true,
      'Firefox refuses a wrong vault passphrase', JSON.stringify(background));
    assert(background?.locked === true && background?.unlocked === true,
      'Firefox locks and unlocks the vault with the same passphrase', JSON.stringify(background));

    const scriptingFlow = await driver.executeAsync(`
      const done = arguments[arguments.length - 1];
      const fixtureUrl = ${JSON.stringify(`http://127.0.0.1:${server.port}${FIXTURE_PATH}`)};
      (async () => {
        let tab;
        try {
          const [{ captureSnapshot }, { clickInjected }, { typeInjected }] = await Promise.all([
            import(browser.runtime.getURL('peerd-runtime/dom/index.js')),
            import(browser.runtime.getURL('peerd-runtime/tools/defs/click.js')),
            import(browser.runtime.getURL('peerd-runtime/tools/defs/type.js')),
          ]);
          tab = await browser.tabs.create({ url: fixtureUrl, active: true });
          let fixtureReady = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            try {
              const [probe] = await browser.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.readyState === 'complete'
                  && document.getElementById('firefox-action') !== null,
              });
              if (probe?.result === true) {
                fixtureReady = true;
                break;
              }
            } catch { /* Firefox may reject injection while navigation is in flight */ }
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
          }
          if (!fixtureReady) throw new Error('fixture tab did not become scriptable');
          const snapshot = await captureSnapshot(
            { id: tab.id }, { scripting: browser.scripting }, { budget: 4_000 },
          );
          const [typed] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: typeInjected,
            args: ['#firefox-input', 'typed in Firefox', false, null, 1],
          });
          const [clicked] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: clickInjected,
            args: ['#firefox-action', 0, null, 1],
          });
          const [observed] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
              clicked: document.body.dataset.clicked,
              value: document.getElementById('firefox-input')?.value,
              status: document.getElementById('firefox-status')?.textContent,
            }),
          });
          return {
            ok: true,
            snapshot: snapshot?.ok === true,
            source: snapshot?.source,
            snapshotHasControls: snapshot?.text?.includes('Firefox parity action')
              && snapshot?.text?.includes('Firefox parity input'),
            typed: typed?.result?.ok === true,
            clicked: clicked?.result?.ok === true,
            observed: observed?.result,
          };
        } finally {
          if (tab?.id != null) await browser.tabs.remove(tab.id).catch(() => {});
        }
      })().then(done, (error) => done({ ok: false, error: error?.message || String(error) }));
    `);
    assert(scriptingFlow?.ok === true, 'packaged Firefox runs the scripting contract', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.snapshot === true && scriptingFlow?.source === 'dom-walk',
      'Firefox captures a real tab through the DOM-walk fallback', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.snapshotHasControls === true, 'Firefox snapshot contains the target controls', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.typed === true && scriptingFlow?.observed?.value === 'typed in Firefox'
      && scriptingFlow?.observed?.status === 'typed in Firefox',
    'Firefox types through the real scripting path', JSON.stringify(scriptingFlow));
    assert(scriptingFlow?.clicked === true && scriptingFlow?.observed?.clicked === 'yes',
      'Firefox clicks through the real scripting path', JSON.stringify(scriptingFlow));

    const primaryPages = [
      ['home/home.html', '#app'],
      ['options/options.html', '#app'],
    ];
    for (const [page, selector] of primaryPages) {
      await driver.navigate(`${EXTENSION_ORIGIN}/${page}`);
      const ready = await waitFor(() => driver.execute(
        `return document.readyState === 'complete' && (document.querySelector(${JSON.stringify(selector)})?.childElementCount || 0) > 0;`,
      ), { budgetMs: 30_000 });
      assert(ready === true, `packaged Firefox ${page} mounts`);
    }

    await driver.navigate(`${EXTENSION_ORIGIN}/sidepanel/sidepanel.html`);
    const remounted = await waitFor(() => driver.execute(
      "return document.readyState === 'complete' && document.querySelector('.topbar') !== null;",
    ), { budgetMs: 30_000 });
    assert(remounted === true, 'packaged Firefox side panel receives the unlocked state');
    // Let the one-shot wordmark intro settle so diagnostics show the final UI,
    // without changing the motion preference used by the browser test suite.
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_700));
    const screenshot = await driver.screenshot();
    writeFileSync(join(OUTPUT, 'sidepanel.png'), Buffer.from(screenshot, 'base64'));

    console.log('Firefox Gecko web-platform suite: run shared browser tests');
    const only = process.env.FIREFOX_TEST_ONLY ?? '';
    const shardRequest = process.env.FIREFOX_TEST_SHARD ?? '';
    const requestedShard = only ? null : /^(\d+)\/(\d+)$/.exec(shardRequest);
    assert(!shardRequest || only || requestedShard !== null,
      'Firefox shard request uses N/TOTAL', shardRequest);
    const shardCount = only ? 1 : Number(requestedShard?.[2] ?? process.env.FIREFOX_TEST_SHARDS ?? 8);
    const resultBudgetMs = Number(process.env.FIREFOX_RESULT_BUDGET_MS ?? RESULT_BUDGET_MS);
    assert(Number.isInteger(shardCount) && shardCount >= 1 && shardCount <= 32,
      'Firefox test shard count is valid', String(shardCount));
    assert(Number.isFinite(resultBudgetMs) && resultBudgetMs >= 1_000,
      'Firefox test result budget is valid', String(resultBudgetMs));
    const shardNumbers = requestedShard
      ? [Number(requestedShard[1])]
      : Array.from({ length: shardCount }, (_, index) => index + 1);
    assert(shardNumbers.every((number) => number >= 1 && number <= shardCount),
      'requested Firefox test shard is valid', process.env.FIREFOX_TEST_SHARD ?? 'all');
    let expectedTotal = null;
    let executed = 0;
    let passed = 0;
    let runtimeMs = 0;
    for (const shardNumber of shardNumbers) {
      const query = new URLSearchParams({
        ci: '1',
        ...(only ? { only } : {}),
        ...(shardCount > 1 ? { shard: `${shardNumber}/${shardCount}` } : {}),
      });
      const runnerUrl = `http://localhost:${server.port}/tests/runner.html?${query.toString()}`;
      console.log(`  running shard ${shardNumber}/${shardCount}`);
      await driver.navigate(runnerUrl);
      const marker = await waitFor(() => driver.execute(
        "return document.getElementById('ci-marker')?.textContent || '';",
      ), { budgetMs: resultBudgetMs, pollMs: 500 });
      if (typeof marker !== 'string' || !marker.startsWith('__TEST_RESULT__')) {
        const diagnostic = await driver.execute(`
          const summary = document.getElementById('summary');
          return {
            href: location.href,
            current: summary?.textContent || document.body?.innerText?.slice(0, 600) || '(none)',
            history: JSON.parse(summary?.dataset.testHistory || '[]'),
          };
        `);
        throw new Error(`Firefox in-browser shard ${shardNumber}/${shardCount} produced no result marker: ${JSON.stringify(diagnostic)}`);
      }
      const result = JSON.parse(marker.slice('__TEST_RESULT__'.length).trim());
      if (result.crash) {
        throw new Error(`Firefox in-browser runner crashed in shard ${shardNumber}/${shardCount}: ${result.crash}`);
      }
      if (result.failed > 0) {
        const failures = await driver.execute(`
          return [...document.querySelectorAll('li.test.fail')].map((item) => {
            const name = item.querySelectorAll(':scope > span')[1]?.textContent ?? '(unnamed)';
            const error = item.querySelector('details')?.innerText?.trim() ?? '';
            return error ? name + ': ' + error : name;
          });
        `);
        throw new Error(`Firefox in-browser failures in shard ${shardNumber}/${shardCount} (${result.failed}):\n  ${(failures ?? []).join('\n  ')}`);
      }
      assert(result.shardNumber === shardNumber && result.shardCount === shardCount,
        'Firefox runner acknowledged the requested shard', JSON.stringify(result));
      if (expectedTotal === null) expectedTotal = result.total;
      assert(Number.isInteger(result.total) && result.total > 0,
        'Firefox loaded a non-empty browser test graph', String(result.total));
      assert(result.total === expectedTotal, 'Firefox shards loaded the same test graph');
      const shardExecuted = result.passed + result.failed;
      assert(shardExecuted > 0, 'Firefox shard or filter selected at least one test', `${shardNumber}/${shardCount}`);
      executed += shardExecuted;
      passed += result.passed;
      runtimeMs += result.ms;
      console.log(`  ✓ shard ${shardNumber}/${shardCount}: ${result.passed} tests in ${result.ms}ms`);
    }
    if (!only && !requestedShard) assert(executed === expectedTotal, 'Firefox shards executed every registered browser test once', `${executed}/${expectedTotal}`);
    console.log(`  ✓ ${passed} browser tests passed under Gecko in ${runtimeMs}ms`);
    console.log('Firefox Store smoke + Gecko suite OK');
  } catch (error) {
    try {
      const screenshot = await driver.screenshot();
      writeFileSync(join(OUTPUT, 'failure.png'), Buffer.from(screenshot, 'base64'));
    } catch { /* the browser may already be gone */ }
    const geckoLog = driver.logs.join('');
    if (geckoLog) writeFileSync(join(OUTPUT, 'geckodriver.log'), geckoLog);
    throw error;
  } finally {
    await driver.close();
    await server.close();
  }
};

main().catch((error) => {
  const name = error?.name ?? 'Error';
  const message = error?.message ?? String(error);
  console.error(`${name}: ${message}`);
  if (error?.stack && error.stack !== `${name}: ${message}`) console.error(error.stack);
  process.exit(1);
});
