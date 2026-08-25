#!/usr/bin/env bun
// Installed Firefox passphrase/route floor for the test-only vault kernel.
// Builds only in a throwaway temp tree; shared artifacts/staging and live
// manifests are never read as mutable package output.

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  FIREFOX_BACKGROUND_ENTRY,
  generateManifest,
} from '../../packaging/gen-manifest.ts';
import { genBuildConfigSource } from '../../packaging/gen-build-config.ts';
import { genChannelConfigSource } from '../../packaging/gen-channel-config.ts';
import { startGeckodriver } from './webdriver.mjs';
import { assertLiveKernelAssembly } from '../acceptance/live-kernel-assembly.mjs';
import {
  FIREFOX_DRIVEN_CHILD_IDS_KEY,
  FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
} from '../../extension/background/driven-child-request-guard.js';
import {
  WEB_ACTOR_SOURCE_PROJECTION_KEY,
} from '../../extension/shared/web-actor-source-projection.js';

const ROOT = resolve(import.meta.dir, '..', '..');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html#vault-kernel-physical`;
const EVENT_PAGE_IDLE_MS = 45_000;
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });
const firefoxBinary = () => process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || '/private/tmp/Firefox153-installed-copy.app/Contents/MacOS/firefox';
const geckodriverBinary = () => process.env.GECKODRIVER_PATH || onPath('geckodriver');

const call = async (driver, message) => JSON.parse(await driver.executeAsync(`
  const message = arguments[0];
  const done = arguments[arguments.length - 1];
  // WebDriver treats an object-valued result with an \`error\` field as a
  // protocol failure. Encode the extension reply across that boundary.
  browser.runtime.sendMessage(message).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({
      ok: false, transportError: error?.message || String(error),
    })),
  );
`, [message]));

export async function runVaultKernelFirefoxPhysical() {
  const firefox = firefoxBinary();
  const geckodriver = geckodriverBinary();
  if (!firefox || !existsSync(firefox) || !geckodriver || !existsSync(geckodriver)) {
    throw new Error('pinned Firefox/geckodriver unavailable; set FIREFOX_PATH and GECKODRIVER_PATH');
  }
  const tree = mkdtempSync(join(tmpdir(), 'peerd-vault-kernel-firefox-'));
  const xpi = join(tmpdir(), `peerd-vault-kernel-firefox-${crypto.randomUUID()}.xpi`);
  const privateRequests = [];
  const ordinaryServer = Bun.serve({
    port: 0,
    fetch: (request) => {
      privateRequests.push(new URL(request.url).pathname);
      return new Response('ordinary-firefox-tab');
    },
  });
  const proxyRequests = [];
  const proxyServer = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      proxyRequests.push({ host: url.hostname, path: url.pathname });
      return new Response(url.hostname === 'public.peerd.test'
        ? 'restored-public-child' : 'unexpected-sensitive-request');
    },
  });
  let driver;
  try {
    cpSync(join(ROOT, 'extension'), tree, { recursive: true });
    const manifest = generateManifest({ channel: 'store', browser: 'firefox', version: VERSION });
    manifest.name = `${manifest.name} vault kernel floor`;
    manifest.background = { scripts: [FIREFOX_BACKGROUND_ENTRY], type: 'module' };
    writeFileSync(join(tree, 'shared', 'build-config.js'), genBuildConfigSource(manifest, {
      channel: 'store', browser: 'firefox', dwebEnabled: false,
    }));
    writeFileSync(
      join(tree, 'shared', 'channel-config.js'),
      genChannelConfigSource('store', 'firefox'),
    );
    writeFileSync(join(tree, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('zip', ['-q', '-X', '-r', xpi, '.'], {
      cwd: tree, env: { ...process.env, TZ: 'UTC' },
    });

    driver = await startGeckodriver({
      binary: geckodriver,
      firefoxBinary: firefox,
      proxy: {
        proxyType: 'manual',
        httpProxy: `127.0.0.1:${proxyServer.port}`,
        noProxy: ['localhost', 'localhost.', '127.0.0.1'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
      },
    });
    const installed = await driver.installAddon(xpi);
    if (installed !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installed}`);
    await driver.navigate(HOME_URL);

    const initialBoot = await call(driver, { type: 'bootstrap/ready' });
    if (initialBoot?.ok !== true) {
      throw new Error(`Firefox kernel unavailable: ${JSON.stringify(initialBoot)}; ${
        driver.logs.join('')}`);
    }
    const initial = await call(driver, { type: 'state/get' });
    const settingsProjection = await call(driver, {
      type: 'settings/update', patch: { vaultAutoLockMs: 60_000, providerName: 'ollama' },
    });
    const policy = await call(driver, {
      type: 'settings/update', patch: { vaultAutoLockMs: 1_000 },
    });
    const initialized = await call(driver, {
      type: 'vault/initialize', passphrase: 'firefox-vault-kernel-passphrase',
    });
    const unlockedState = await call(driver, { type: 'state/get' });
    const locked = await call(driver, { type: 'vault/lock' });
    const lockedState = await call(driver, { type: 'state/get' });
    const unlocked = await call(driver, {
      type: 'vault/unlock', passphrase: 'firefox-vault-kernel-passphrase',
    });
    const resumedState = await call(driver, { type: 'state/get' });

    // Close the only extension document so Firefox may discard its event page,
    // then wake it from a plain surviving browser tab after the pinned 45s
    // lifecycle window. A fresh boot must claim a fresh epoch while preserving
    // the durable vault and session-mirror behavior.
    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    const restoredTabs = await driver.executeAsync(`
      const [markersKey, idsKey, sourceProjectionKey] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const source = await browser.tabs.create({ url: 'about:blank', active: false });
        const children = await Promise.all(Array.from({ length: 3 }, () =>
          browser.tabs.create({ url: 'about:blank', active: false, openerTabId: source.id })));
        await new Promise((resolveWait) => setTimeout(resolveWait, 16000));
        await browser.storage.session.set({
          webActorTabBindings: [[source.id, 'firefox-physical-web-actor']],
          [sourceProjectionKey]: [{
            tabId: source.id,
            sessionId: 'firefox-physical-web-actor',
            url: source.url,
            openerTabId: Number.isInteger(source.openerTabId) ? source.openerTabId : null,
            cookieStoreId: typeof source.cookieStoreId === 'string' ? source.cookieStoreId : null,
          }],
        });
        const markers = children.map((tab) => ({
          sourceTabId: source.id, tabId: tab.id,
        }));
        localStorage.setItem(idsKey, JSON.stringify(children.map((tab) => tab.id)));
        localStorage.setItem(markersKey, JSON.stringify(markers));
        done({ sourceTabId: source.id, childTabIds: children.map((tab) => tab.id) });
      })().catch((error) => done({ error: error?.message || String(error) }));
    `, [
      FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
      FIREFOX_DRIVEN_CHILD_IDS_KEY,
      WEB_ACTOR_SOURCE_PROJECTION_KEY,
    ]);
    if (!Number.isInteger(restoredTabs?.sourceTabId)
        || restoredTabs?.childTabIds?.length !== 3) {
      throw new Error(`Firefox restored child setup failed: ${JSON.stringify(restoredTabs)}`);
    }
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    const handlesAfterClose = await driver.windowHandles();
    await sleep(EVENT_PAGE_IDLE_MS + 1_000);
    const handlesAfterIdle = await driver.windowHandles();
    await driver.navigate(`http://127.0.0.1:${ordinaryServer.port}/`);
    const ordinaryPage = await driver.execute('return document.body.textContent;');
    const reopenStartedAt = performance.now();
    await driver.navigate(HOME_URL);
    const homeReadyAt = performance.now();
    const beforeBootstrapTabs = await driver.executeAsync(`
      const [sourceTabId, childTabIds, markersKey] = arguments;
      const done = arguments[arguments.length - 1];
      Promise.all([sourceTabId, ...childTabIds].map((tabId) =>
        browser.tabs.get(tabId).then(
          (tab) => ({ id: tab.id, url: tab.url, openerTabId: tab.openerTabId ?? null }),
          () => null,
        ))).then((tabs) => done({ tabs, markers: localStorage.getItem(markersKey) }));
    `, [
      restoredTabs.sourceTabId, restoredTabs.childTabIds,
      FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
    ]);
    const afterIdleBoot = await call(driver, { type: 'bootstrap/ready' });
    const bootReadyAt = performance.now();
    const afterIdleState = await call(driver, { type: 'state/get' });
    const stateReadyAt = performance.now();
    const restoredChildren = await driver.executeAsync(`
      const [tabIds, publicUrl, privateUrl, sensitiveUrl] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
        const navigate = async (tabId, url) => {
          const update = await Promise.race([
            browser.tabs.update(tabId, { url, active: false }).then(
              () => ({ ok: true }),
              (error) => ({ ok: false, error: error?.message || String(error) }),
            ),
            wait(5000).then(() => ({ ok: false, error: 'tabs-update-timeout' })),
          ]);
          await wait(300);
          const tab = await browser.tabs.get(tabId).catch(() => null);
          return { update, url: tab?.url ?? null, status: tab?.status ?? null };
        };
        const publicResult = await navigate(tabIds[0], publicUrl);
        let publicBody = null;
        try {
          const [result] = await browser.scripting.executeScript({
            target: { tabId: tabIds[0] }, func: () => document.body?.textContent ?? '',
          });
          publicBody = result?.result ?? null;
        } catch {}
        done({
          public: { ...publicResult, body: publicBody },
          private: await navigate(tabIds[1], privateUrl),
          sensitive: await navigate(tabIds[2], sensitiveUrl),
        });
      })().catch((error) => done({ error: error?.message || String(error) }));
    `, [
      restoredTabs.childTabIds,
      `http://public.peerd.test:${proxyServer.port}/restored-public`,
      `http://127.0.0.1:${ordinaryServer.port}/restored-private`,
      `http://chase.com:${proxyServer.port}/restored-sensitive`,
    ]);
    const childAudit = await call(driver, { type: 'audit/list', limit: 100 });
    const childReceipts = (childAudit?.entries ?? [])
      .filter((entry) => entry?.type === 'browser_child_request_blocked')
      .map((entry) => entry.details?.browserPolicy);

    const report = {
      schema: 1,
      runtimeIdentity: driver.runtimeIdentity,
      initialBoot, initial, settingsProjection, policy, initialized, unlockedState,
      locked, lockedState, unlocked, resumedState, afterIdleBoot, afterIdleState,
      ordinaryPage, restoredTabs, restoredChildren, childReceipts,
      beforeBootstrapTabs,
      handleCounts: {
        afterClose: handlesAfterClose.length,
        afterIdle: handlesAfterIdle.length,
      },
      reopenTimings: {
        homeMs: homeReadyAt - reopenStartedAt,
        bootstrapMs: bootReadyAt - homeReadyAt,
        stateMs: stateReadyAt - bootReadyAt,
      },
      privateRequests, proxyRequests,
    };
    const identityBound = (value) => value?.schema === 1
      && typeof value?.buildId === 'string' && value.buildId.startsWith(`${VERSION}:`)
      && typeof value?.bootId === 'string' && typeof value?.kernelEpoch === 'string';
    let initialAssembly;
    let afterIdleAssembly;
    try {
      initialAssembly = assertLiveKernelAssembly(initialBoot?.assembly, 'store-firefox');
      afterIdleAssembly = assertLiveKernelAssembly(afterIdleBoot?.assembly, 'store-firefox');
    } catch (cause) {
      throw new Error(`Firefox bootstrap did not prove the complete live assembly: ${
        cause instanceof Error ? cause.message : String(cause)
      }; ${JSON.stringify(report)}; ${driver.logs.join('')}`);
    }
    const bootBound = (value, assembly) => identityBound(value)
      && value?.ok === true && value?.kernel === true
      && assembly === value?.assembly
      && assembly.identity.schema === value.schema
      && assembly.identity.buildId === value.buildId
      && assembly.identity.bootId === value.bootId
      && assembly.identity.kernelEpoch === value.kernelEpoch;
    const stateBound = (value) => identityBound(value)
      && value.state?.kernel?.schema === value.schema
      && value.state?.kernel?.buildId === value.buildId
      && value.state?.kernel?.bootId === value.bootId
      && value.state?.kernel?.kernelEpoch === value.kernelEpoch;
    if (!bootBound(initialBoot, initialAssembly) || !stateBound(initial)
        || initial?.ok !== true || initial.state?.vault?.initialized !== false
        || settingsProjection?.settings?.providerName !== 'ollama'
        || policy?.settings?.vaultAutoLockMs !== 60_000
        || initialized?.ok !== true
        || unlockedState?.state?.vault?.initialized !== true
        || unlockedState?.state?.vault?.locked !== false
        || locked?.ok !== true || lockedState?.state?.vault?.locked !== true
        || unlocked?.ok !== true || resumedState?.state?.vault?.locked !== false
        || !bootBound(afterIdleBoot, afterIdleAssembly) || !stateBound(afterIdleState)
        || afterIdleBoot.bootId === initialBoot.bootId
        || afterIdleBoot.kernelEpoch === initialBoot.kernelEpoch
        || ordinaryPage !== 'ordinary-firefox-tab'
        || restoredChildren?.public?.body !== 'restored-public-child'
        || proxyRequests.filter((request) => request.path === '/restored-public').length !== 1
        || proxyRequests.some((request) => request.path === '/restored-sensitive')
        || privateRequests.some((path) => path === '/restored-private')
        || childReceipts.length < 2
        || childReceipts.some((receipt) => JSON.stringify(receipt).includes('127.0.0.1')
          || JSON.stringify(receipt).includes('chase.com')
          || receipt?.outcome !== 'not_run' || receipt?.child !== 'guarded')
        || afterIdleState.state?.vault?.initialized !== true
        || afterIdleState.state?.vault?.locked !== false) {
      throw new Error(`Firefox vault kernel floor failed: ${JSON.stringify(report)}`);
    }
    return report;
  } finally {
    await driver?.close();
    ordinaryServer.stop(true);
    proxyServer.stop(true);
    rmSync(tree, { recursive: true, force: true });
    rmSync(xpi, { force: true });
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await runVaultKernelFirefoxPhysical(), null, 2));
}
