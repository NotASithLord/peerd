#!/usr/bin/env bun
// Packaged Firefox proof for the protocol-v2 direct controller. The probe adds
// one background module and a deterministic test runtime to a throwaway copy
// of the verified Store staging tree; production controller modules are used
// unchanged and the resulting XPI is installed through WebDriver.

import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { startGeckodriver } from './webdriver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const FIREFOX_ORIGIN = `moz-extension://${FIREFOX_UUID}`;
const WORKER_IDLE_MS = 75;
const EVENT_PAGE_IDLE_MS = 45_000;
const BUILD_DIGEST = 'd'.repeat(64);
const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });

const firefoxBinary = () => process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || [
    '/private/tmp/Firefox153-installed-copy.app/Contents/MacOS/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  ].find(existsSync)
  || onPath('firefox');
const geckodriverBinary = () => process.env.GECKODRIVER_PATH || onPath('geckodriver');

const PROBE_BACKGROUND_SOURCE = `
import {
  connectDirectController,
  makeIdleDirectControllerLoader,
} from './direct-controller-client.js';
import { CONTROLLER_CHANNEL_PROTOCOL } from '../shared/structured-clone-size.js';

const runtime = globalThis.browser ?? globalThis.chrome;
const buildDigest = '${BUILD_DIGEST}';
const authority = Object.freeze({
  ownerId: 'root:firefox-physical',
  sessionId: 'session:firefox-physical',
  instanceId: null,
  origin: null,
  target: null,
  replayClass: 'E',
});

globalThis.__peerdDirectControllerBootId = crypto.randomUUID();
let controller = null;
const openController = async () => {
  controller ??= await connectDirectController({
    capabilities: ['probe.read'],
    supportedCapabilities: ['probe.read'],
    buildDigest,
    authorizeCall: () => authority,
    loader: makeIdleDirectControllerLoader({
      workerUrl: runtime.runtime.getURL('offscreen/controller-worker.js'),
      idleMs: ${WORKER_IDLE_MS},
    }),
  });
  return controller;
};

globalThis.__peerdDirectControllerProbe = async (operation = 'call') => {
  if (operation === 'retire') {
    const retired = await openController();
    const retiredEpoch = retired.epoch;
    retired.close();
    controller = null;
    const replacement = await openController();
    const result = await replacement.call('probe.read', { value: 7 });
    const retiredRefusal = await retired.call('probe.read', { value: 99 });
    return {
      protocol: CONTROLLER_CHANNEL_PROTOCOL,
      bootId: globalThis.__peerdDirectControllerBootId,
      retiredEpoch,
      replacementEpoch: replacement.epoch,
      retiredRefusal,
      result,
    };
  }
  const active = await openController();
  return {
    protocol: CONTROLLER_CHANNEL_PROTOCOL,
    bootId: globalThis.__peerdDirectControllerBootId,
    epoch: active.epoch,
    result: await active.call('probe.read', { value: 7 }),
  };
};
`;

const PROBE_CONTROLLER_RUNTIME_SOURCE = `
const generation = crypto.randomUUID();
const attempt = (operation) => {
  try { operation(); return { blocked: false, error: null }; }
  catch (error) { return { blocked: true, error: error?.message || String(error) }; }
};
const sealed = (value) => String(value).includes('controller ambient capability denied');

export const createController = async () => ({
  call: async (capability, payload, options) => ({
    ok: true,
    generation,
    capability,
    payload,
    authority: options.authority,
    realm: {
      browser: typeof browser,
      chrome: typeof chrome,
      document: typeof document,
      window: typeof window,
      fetchAttempt: attempt(() => fetch('data:text/plain,blocked')),
      workerAttempt: attempt(() => new Worker('data:text/javascript,')),
      indexedDbAttempt: attempt(() => globalThis.indexedDB()),
      postMessageAttempt: attempt(() => globalThis.postMessage({})),
      fetchSealed: sealed(globalThis.fetch),
      workerSealed: sealed(globalThis.Worker),
      indexedDbSealed: sealed(globalThis.indexedDB),
      postMessageSealed: sealed(globalThis.postMessage),
      navigatorStorage: typeof navigator.storage,
      navigatorServiceWorker: typeof navigator.serviceWorker,
      navigatorLocks: typeof navigator.locks,
    },
  }),
});
`;

const assertWorkerSample = (sample, label) => {
  const result = sample?.result;
  const realm = result?.realm;
  if (result?.ok !== true
      || result?.phase !== 'settled'
      || result?.outcomeKnown !== true
      || result?.capability !== 'probe.read'
      || result?.payload?.value !== 7
      || result?.authority?.ownerId !== 'root:firefox-physical'
      || result?.authority?.replayClass !== 'E'
      || typeof result?.generation !== 'string'
      || realm?.browser !== 'undefined'
      || realm?.chrome !== 'undefined'
      || realm?.document !== 'undefined'
      || realm?.window !== 'undefined'
      || realm?.fetchAttempt?.blocked !== true
      || realm?.workerAttempt?.blocked !== true
      || realm?.indexedDbAttempt?.blocked !== true
      || realm?.postMessageAttempt?.blocked !== true
      || realm?.fetchSealed !== true
      || realm?.workerSealed !== true
      || realm?.indexedDbSealed !== true
      || realm?.postMessageSealed !== true
      || realm?.navigatorStorage !== 'undefined'
      || realm?.navigatorServiceWorker !== 'undefined'
      || realm?.navigatorLocks !== 'undefined') {
    throw new Error(`${label} did not settle in the sealed protocol-v2 Worker: ${JSON.stringify(sample)}`);
  }
};

/** @param {any} report */
export const assertDirectControllerPhysicalReport = (report) => {
  assertWorkerSample(report?.first, 'first call');
  assertWorkerSample(report?.afterWorkerIdle, 'post-worker-idle call');
  assertWorkerSample(report?.retirement, 'replacement after explicit retirement');
  assertWorkerSample(report?.afterEventPageIdle, 'post-event-page-idle call');
  if ([report.first, report.afterWorkerIdle, report.retirement, report.afterEventPageIdle]
    .some((sample) => sample.protocol !== 2)) {
    throw new Error('packaged direct-controller probe did not use protocol v2');
  }
  if (report.first.epoch !== report.afterWorkerIdle.epoch) {
    throw new Error('idle Worker replacement changed the live kernel epoch');
  }
  if (report.first.result.generation === report.afterWorkerIdle.result.generation) {
    throw new Error('Dedicated Worker was not replaced after idle discard');
  }
  if (report.retirement.retiredEpoch !== report.afterWorkerIdle.epoch
      || report.retirement.replacementEpoch === report.retirement.retiredEpoch) {
    throw new Error('explicit controller retirement did not create a fresh epoch');
  }
  if (report.retirement.retiredRefusal?.ok !== false
      || report.retirement.retiredRefusal?.code !== 'controller-channel-closed'
      || report.retirement.retiredRefusal?.phase !== 'startup'
      || report.retirement.retiredRefusal?.outcomeKnown !== true) {
    throw new Error(`retired epoch accepted a late call: ${JSON.stringify(report.retirement.retiredRefusal)}`);
  }
  if (report.afterEventPageIdle.bootId === report.retirement.bootId) {
    throw new Error('Firefox event page was not discarded');
  }
  if (report.afterEventPageIdle.epoch === report.retirement.replacementEpoch) {
    throw new Error('discarded event page reused its retired kernel epoch');
  }
  if (report.afterEventPageIdle.result.generation === report.retirement.result.generation) {
    throw new Error('discarded event page reused its retired Worker generation');
  }
  return report;
};

const invokeProbe = async (driver, operation = 'call') => {
  const started = hostNowMs();
  const value = await driver.executeAsync(`
    const operation = arguments[0];
    const done = arguments[arguments.length - 1];
    browser.runtime.getBackgroundPage().then(
      (page) => page.__peerdDirectControllerProbe(operation).then(done, (error) => done({
        error: error?.message || String(error),
      })),
      (error) => done({ error: error?.message || String(error) }),
    );
  `, [operation]);
  if (value?.error) throw new Error(`Firefox direct-controller probe failed: ${value.error}`);
  return { ...value, hostRoundTripMs: hostNowMs() - started };
};

export const runDirectControllerPhysicalSmoke = async () => {
  const firefox = firefoxBinary();
  const geckodriver = geckodriverBinary();
  if (!firefox || !geckodriver) {
    throw new Error('Firefox or geckodriver is unavailable; set FIREFOX_PATH and GECKODRIVER_PATH');
  }
  await packageArtifact({
    channel: 'store', browser: 'firefox', version: VERSION, sign: false, verify: true,
  });
  const source = join(ROOT, 'artifacts', 'staging', 'store-firefox');
  const tree = mkdtempSync(join(tmpdir(), 'peerd-direct-controller-physical-'));
  const xpi = join(tmpdir(), `peerd-direct-controller-physical-${crypto.randomUUID()}.xpi`);
  let driver;
  try {
    cpSync(source, tree, { recursive: true });
    const manifestPath = join(tree, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.background?.scripts)) {
      throw new Error('packaged Firefox manifest has no background scripts');
    }
    manifest.background.scripts = [
      'background/direct-controller-physical-probe.js',
      ...manifest.background.scripts,
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(tree, 'background', 'direct-controller-physical-probe.js'),
      PROBE_BACKGROUND_SOURCE,
    );
    writeFileSync(
      join(tree, 'offscreen', 'controller-runtime.js'),
      PROBE_CONTROLLER_RUNTIME_SOURCE,
    );
    writeFileSync(
      join(tree, 'direct-controller-physical.html'),
      '<!doctype html><meta charset="utf-8"><title>Firefox controller probe</title>\n',
    );
    execFileSync('zip', ['-q', '-X', '-r', xpi, '.'], {
      cwd: tree,
      env: { ...process.env, TZ: 'UTC' },
    });

    driver = await startGeckodriver({
      binary: geckodriver,
      firefoxBinary: firefox,
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
        'app.update.silent': false,
      },
    });
    // startGeckodriver checked identity before this throwaway artifact install.
    const runtimeIdentity = driver.runtimeIdentity;
    const installed = await driver.installAddon(xpi);
    if (installed !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installed}`);
    await driver.navigate(`${FIREFOX_ORIGIN}/direct-controller-physical.html`);

    const first = await invokeProbe(driver);
    await sleep(WORKER_IDLE_MS + 75);
    const afterWorkerIdle = await invokeProbe(driver);
    const retirement = await invokeProbe(driver, 'retire');

    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    await sleep(EVENT_PAGE_IDLE_MS);
    await driver.navigate(`${FIREFOX_ORIGIN}/direct-controller-physical.html`);
    const afterEventPageIdle = await invokeProbe(driver);

    return assertDirectControllerPhysicalReport({
      runtimeIdentity,
      workerIdleMs: WORKER_IDLE_MS,
      eventPageIdleMs: EVENT_PAGE_IDLE_MS,
      first,
      afterWorkerIdle,
      retirement,
      afterEventPageIdle,
    });
  } finally {
    await driver?.close();
    rmSync(tree, { recursive: true, force: true });
    rmSync(xpi, { force: true });
  }
};

if (import.meta.main) {
  console.log(JSON.stringify(await runDirectControllerPhysicalSmoke(), null, 2));
}
