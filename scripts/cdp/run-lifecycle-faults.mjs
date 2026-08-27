#!/usr/bin/env bun
// Pipe-backed physical MV3 lifecycle fault lane.

import {
  closeSync, constants, cpSync, fstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { bundleChromeNativeKernel } from '../../packaging/bundle-chrome-native-kernel.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { readVersion } from '../../packaging/lib.ts';
import { resolveChrome } from './e2e-harness.mjs';

const ROOT = resolve(import.meta.dir, '..', '..');
const RESULT_DIR = join(ROOT, 'artifacts', 'chrome-lifecycle');
const REACHED_KEY = 'peerd.e2e.lifecycleFault.reached';
const OPERATION_KEY = 'peerd.lifecycle.operations';
const NOTICE_KEY = 'peerd.lifecycle.pendingNotices';
const BOOT_ERROR_KEY = 'peerd.e2e.lifecycleFault.bootError';
const STABILITY_WINDOW_MS = 1_500;
const SOURCE_TARGET = 'source';
const STORE_TARGET = 'store';

const withDeadline = async (promise, budgetMs, label) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const overwriteRegularFile = (path, contents) => {
  const descriptor = openSync(path,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`refusing to overwrite non-file: ${path}`);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
};

const replaceExact = (source, anchor, replacement, label) => {
  if (source.split(anchor).length !== 2) throw new Error(`${label} seam changed`);
  return source.replace(anchor, replacement);
};

export const injectLifecycleFaultKernel = (input) => {
  const routeAnchor = '  ...systemReadRoutes,\n  ...sessionSupportRoutes,\n  ...demandRoutes,';
  return replaceExact(input, routeAnchor, `  ...systemReadRoutes,
  ...sessionSupportRoutes,
  'lifecycle-fault/dispatch': async (message) => {
    try {
      const relays = await getControllerRelays();
      if (typeof relays.buildActorContext !== 'function') {
        throw new Error('lifecycle fault relays are unavailable');
      }
      const sessionId = message?.sessionId;
      const callId = message?.callId;
      const context = await relays.buildActorContext({
        ...(typeof sessionId === 'string' ? { sessionId } : {}),
        exposure: 'main',
        lifecycleTurnId: 'chrome-physical-fault-turn',
        lifecycleUserInitiated: true,
      });
      if (message?.recoverOnly === true) {
        return {
          recovered: true,
          generation: await kv.get('peerd.lifecycle.generation'),
        };
      }
      if (typeof sessionId !== 'string' || typeof callId !== 'string'
          || typeof context.lifecycle?.beginTracking !== 'function') {
        throw new Error('lifecycle fault request is invalid');
      }
      await kv.set(${JSON.stringify(REACHED_KEY)}, []);
      const generation = await kv.get('peerd.lifecycle.generation');
      if (!generation?.id) throw new Error('lifecycle generation is not ready');
      for (const [toolName, retryClass, trackedCallId] of [
        ['fetch_url', 'B', 'chrome-fault-b'],
        ['remember', 'C', 'chrome-fault-c'],
        ['dweb_share', 'D', 'chrome-fault-d'],
        ['script', 'E', callId],
      ]) {
        const tracking = await context.lifecycle.beginTracking({
          callId: trackedCallId,
          tool: { name: toolName, retryClass },
          sessionId,
          ownerSessionId: sessionId,
          target: 'tool:' + toolName,
          args: { lifecycleFault: true },
          turnId: 'chrome-physical-fault-turn',
          userInitiated: true,
        });
        if (!tracking?.handle) throw new Error('lifecycle fault tracking failed');
      }
      const reached = await kv.get(${JSON.stringify(REACHED_KEY)}) ?? [];
      await kv.set(${JSON.stringify(REACHED_KEY)}, [
        ...reached, { toolName: 'script', at: Date.now() },
      ]);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const reached = await kv.get(${JSON.stringify(REACHED_KEY)});
        if (reached?.length === 1) return { started: true };
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      throw new Error('fault probe did not reach the tool body');
    } catch (cause) {
      await kv.set(${JSON.stringify(BOOT_ERROR_KEY)},
        cause?.stack || cause?.message || String(cause));
      throw cause;
    }
  },
  ...demandRoutes,`, 'source fault route');
};

export const assertLifecycleFaultExecutionSeam = (source) => {
  const dispatched = 'await operationLog.markDispatched(operationId);';
  const handle = 'return { handle: { operationId, retryClass, toolName: tool.name ?? \'unknown-tool\' } };';
  const dispatchedAt = source.lastIndexOf(dispatched);
  const handleAt = source.indexOf(handle);
  if (dispatchedAt < 0 || handleAt < 0 || dispatchedAt >= handleAt) {
    throw new Error('source lifecycle dispatch seam changed');
  }
};

const injectLifecycleFaultTree = (extension) => {
  const kernel = join(extension, 'background', 'vault-kernel.js');
  overwriteRegularFile(
    kernel,
    injectLifecycleFaultKernel(readFileSync(kernel, 'utf8')),
  );
  const tracking = join(extension, 'peerd-runtime', 'lifecycle', 'dispatch-tracking.js');
  assertLifecycleFaultExecutionSeam(readFileSync(tracking, 'utf8'));
};

const makeSourceFaultExtension = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-chrome-lifecycle-fault-'));
  const extension = join(directory, 'extension');
  cpSync(join(ROOT, 'extension'), extension, { recursive: true });
  injectLifecycleFaultTree(extension);
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
  const backgroundEntry = manifest.background?.service_worker;
  if (typeof backgroundEntry !== 'string') {
    throw new Error('source lifecycle target has no service worker entry');
  }
  await bundleChromeNativeKernel(extension, backgroundEntry);
  return {
    directory, extension, backgroundEntry,
  };
};

const makePackagedFaultExtension = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-chrome-lifecycle-store-fault-'));
  const sourceRoot = join(directory, 'source');
  const artifactRoot = join(directory, 'artifacts');
  const extension = join(sourceRoot, 'extension');
  mkdirSync(sourceRoot, { recursive: true });
  cpSync(join(ROOT, 'extension'), extension, { recursive: true });
  cpSync(join(ROOT, 'manifests'), join(sourceRoot, 'manifests'), { recursive: true });
  mkdirSync(join(sourceRoot, 'packaging'), { recursive: true });
  cpSync(
    join(ROOT, 'packaging', 'default-settings.mjs'),
    join(sourceRoot, 'packaging', 'default-settings.mjs'),
  );
  injectLifecycleFaultTree(extension);
  await packageArtifact({
    channel: 'store', browser: 'chrome', version: readVersion(),
    sign: false, verify: true, minify: true, sourceRoot, artifactRoot,
    coldBudgetMode: 'measure-only',
  });
  const staging = join(artifactRoot, 'staging', 'store-chrome');
  const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
  const backgroundEntry = manifest.background?.service_worker;
  if (backgroundEntry !== 'background/vault-kernel.js') {
    throw new Error(`packaged lifecycle target changed: ${backgroundEntry ?? '(missing)'}`);
  }
  const stagedSources = [
    readFileSync(join(staging, backgroundEntry), 'utf8'),
    readFileSync(join(staging, 'peerd-runtime/tools/dispatcher.js'), 'utf8'),
  ].join('\n');
  for (const canary of [
    REACHED_KEY, BOOT_ERROR_KEY, 'lifecycle-fault/dispatch',
    'lifecycle fault execution target changed',
  ]) {
    if (!stagedSources.includes(canary)) {
      throw new Error(`packaged lifecycle probe was removed before launch: ${canary}`);
    }
  }
  return {
    directory, extension: staging, backgroundEntry,
  };
};

const waitFor = async (fn, budgetMs = 30_000) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await withDeadline(Promise.resolve().then(fn), 5_000, 'lifecycle poll');
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
};

const assert = (value, message) => {
  if (!value) throw new Error(message);
  console.log(`  PASS ${message}`);
};

const targetArgument = process.argv.find((argument) => argument.startsWith('--target='));
const lifecycleTarget = targetArgument?.slice('--target='.length) ?? SOURCE_TARGET;
if (![SOURCE_TARGET, STORE_TARGET].includes(lifecycleTarget)) {
  throw new Error(`unknown lifecycle target: ${lifecycleTarget}`);
}

const main = async (target = SOURCE_TARGET) => {
  mkdirSync(RESULT_DIR, { recursive: true });
  rmSync(join(RESULT_DIR, 'result.json'), { force: true });
  rmSync(join(RESULT_DIR, `${target}-result.json`), { force: true });
  const writeResult = (value) => {
    const json = JSON.stringify({ target, ...value }, null, 2);
    writeFileSync(join(RESULT_DIR, 'result.json'), json);
    writeFileSync(join(RESULT_DIR, `${target}-result.json`), json);
  };
  const fault = target === STORE_TARGET
    ? await makePackagedFaultExtension()
    : await makeSourceFaultExtension();
  if (typeof fault.backgroundEntry !== 'string') {
    throw new Error(`${target} lifecycle target has no service worker entry`);
  }
  const profile = mkdtempSync(join(tmpdir(), 'peerd-pipe-lifecycle-'));
  let browser;
  let forcedTerminationAttempted = false;
  let stage = 'launch';
  const launchBrowser = () => puppeteer.launch({
    executablePath: resolveChrome(),
    enableExtensions: [fault.extension],
    headless: true,
    pipe: true,
    protocolTimeout: 30_000,
    timeout: 30_000,
    userDataDir: profile,
    args: [
      '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    ],
  });
  try {
    browser = await launchBrowser();
    stage = 'initial service-worker target';
    const discoveredTarget = await withDeadline(browser.waitForTarget((candidate) =>
      candidate.type() === 'service_worker'
      && candidate.url().endsWith(`/${fault.backgroundEntry}`), { timeout: 30_000 }),
    35_000, stage);
    const extensionId = new URL(discoveredTarget.url()).host;
    stage = 'extension page';
    let page = await withDeadline(browser.newPage(), 10_000, stage);
    await withDeadline(page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`),
      30_000, stage);
    const sessionId = 'chrome-physical-lifecycle-session';
    const callId = 'chrome-physical-script-call';
    await withDeadline(page.evaluate(() => {
      void chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null);
    }), 10_000, stage);
    stage = 'real dispatcher fault';
    await page.evaluate(({ sessionId: sid, callId: cid }) => {
      void chrome.runtime.sendMessage({ type: 'lifecycle-fault/dispatch', sessionId: sid, callId: cid });
    }, { sessionId, callId });
    stage = 'lifecycle generation';
    let bootError = null;
    const generation = await waitFor(() => page.evaluate(async (bootErrorKey) => {
      void chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null);
      const stored = await chrome.storage.local.get(['peerd.lifecycle.generation', bootErrorKey]);
      const observed = {
        generation: stored['peerd.lifecycle.generation'], bootError: stored[bootErrorKey] ?? null,
      };
      return observed.generation?.id || observed.bootError ? observed : null;
    }, BOOT_ERROR_KEY).then((observed) => {
      if (!observed) return null;
      bootError = observed.bootError;
      return observed.generation?.id ? observed.generation : null;
    }));
    if (!generation?.id) throw new Error(`production lifecycle boot did not mint a generation${bootError ? `: ${bootError}` : ''}`);
    assert(true, 'production lifecycle boot minted a generation');
    const operationId = `${sessionId}:${callId}`;
    const inFlight = await waitFor(() => page.evaluate(async ({ reachedKey, operationKey, id }) => {
      const stored = await chrome.storage.local.get([reachedKey, operationKey]);
      const record = stored[operationKey]?.[id];
      return stored[reachedKey]?.length === 1 && record?.state === 'awaiting_remote'
        && record?.dispatched === true;
    }, { reachedKey: REACHED_KEY, operationKey: OPERATION_KEY, id: operationId }));
    assert(inFlight, 'real Class E dispatch crossed its durable dispatch marker');

    stage = 'physical browser termination';
    forcedTerminationAttempted = true;
    const browserProcess = browser.process();
    if (!browserProcess) throw new Error('Chrome process is unavailable');
    const browserExited = new Promise((resolveExit) => {
      if (browserProcess.exitCode !== null) resolveExit(undefined);
      else browserProcess.once('exit', resolveExit);
    });
    browserProcess.kill('SIGKILL');
    await withDeadline(browserExited, 10_000, stage);
    browser = null;
    stage = 'service-worker restart';
    browser = await launchBrowser();
    const restartedTarget = await withDeadline(browser.waitForTarget((candidate) =>
      candidate.type() === 'service_worker'
      && candidate.url().endsWith(`/${fault.backgroundEntry}`), { timeout: 30_000 }),
    35_000, stage);
    page = await withDeadline(browser.newPage(), 10_000, stage);
    await withDeadline(page.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`),
      30_000, stage);
    await withDeadline(page.evaluate(() => chrome.runtime.sendMessage({
      type: 'lifecycle-fault/dispatch', recoverOnly: true,
    })), 30_000, 'lifecycle recovery boot');
    const restarted = await waitFor(async () => {
      await page.evaluate(() => {
        void chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null);
        return true;
      }).catch(() => null);
      const stored = await page.evaluate(async (bootErrorKey) => {
        const values = await chrome.storage.local.get(['peerd.lifecycle.generation', bootErrorKey]);
        return {
          generation: values['peerd.lifecycle.generation'],
          bootError: values[bootErrorKey] ?? null,
        };
      }, BOOT_ERROR_KEY);
      if (stored.bootError) throw new Error(`restarted lifecycle boot failed: ${stored.bootError}`);
      return stored.generation?.id !== generation.id ? stored.generation : null;
    }, 35_000);
    if (!restarted) throw new Error('service-worker restart did not mint a new generation');
    assert(restartedTarget.url().includes(extensionId),
      'a browser crash and profile restart replaced the MV3 worker');

    stage = 'lifecycle recovery';
    let lastRecoveryState = null;
    const recovered = await waitFor(async () => {
      await page.evaluate(() => {
        void chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null);
      }).catch(() => null);
      lastRecoveryState = await page.evaluate(async ({ operationKey, noticeKey, reachedKey, id, sid }) => {
      const stored = await chrome.storage.local.get([operationKey, noticeKey, reachedKey]);
      const expected = {
        [sid + ':chrome-fault-b']: 'interrupted',
        [sid + ':chrome-fault-c']: 'interrupted',
        [sid + ':chrome-fault-d']: 'outcome_unknown',
        [id]: 'outcome_unknown',
      };
      const statesMatch = Object.entries(expected).every(([operationId, state]) =>
        stored[operationKey]?.[operationId]?.state === state);
      const notices = stored[noticeKey]?.[sid] ?? [];
      return {
        pass: statesMatch
        && notices.some((notice) => notice?.recoveryRecord?.recoveryState === 'interrupted')
        && notices.some((notice) => notice?.recoveryRecord?.recoveryState === 'outcome_unknown')
        && stored[reachedKey]?.length === 1,
        operations: stored[operationKey] ?? {}, notices, reached: stored[reachedKey] ?? [],
      };
      }, { operationKey: OPERATION_KEY, noticeKey: NOTICE_KEY, reachedKey: REACHED_KEY,
        id: operationId, sid: sessionId });
      return lastRecoveryState.pass ? lastRecoveryState : null;
    });
    if (!recovered) throw new Error(`restart did not reconcile B/C/D/E: ${JSON.stringify(lastRecoveryState)}`);
    assert(true, 'restart reconciles B/C safely and preserves D/E uncertainty');
    await new Promise((resolveWait) => setTimeout(resolveWait, STABILITY_WINDOW_MS));
    const stable = await page.evaluate(async ({ operationKey, reachedKey, id, sid }) => {
      const stored = await chrome.storage.local.get([operationKey, reachedKey]);
      return stored[reachedKey]?.length === 1
        && stored[operationKey]?.[sid + ':chrome-fault-b']?.state === 'interrupted'
        && stored[operationKey]?.[sid + ':chrome-fault-c']?.state === 'interrupted'
        && stored[operationKey]?.[sid + ':chrome-fault-d']?.state === 'outcome_unknown'
        && stored[operationKey]?.[id]?.state === 'outcome_unknown';
    }, { operationKey: OPERATION_KEY, reachedKey: REACHED_KEY, id: operationId, sid: sessionId });
    assert(stable, 'the stability window observes no delayed tool-body replay');
    const nextGeneration = restarted;
    assert(nextGeneration.id !== generation.id,
      'the restarted worker minted a distinct lifecycle generation');
    writeResult({
      status: 'passed', forcedTerminationAttempted: true,
      terminationBoundary: 'SIGKILL Chrome and relaunch the same profile over CDP pipe',
      backgroundEntry: fault.backgroundEntry,
      initialGenerationId: generation.id,
      recoveredGenerationId: nextGeneration.id,
      operationIds: [
        `${sessionId}:chrome-fault-b`, `${sessionId}:chrome-fault-c`,
        `${sessionId}:chrome-fault-d`, operationId,
      ],
    });
  } catch (error) {
    writeResult({
      status: 'blocked', forcedTerminationAttempted,
      stage, backgroundEntry: fault.backgroundEntry,
      error: error?.message ?? String(error),
    });
    throw error;
  } finally {
    if (browser) {
      let closed = false;
      await Promise.race([
        browser.close().then(() => { closed = true; }),
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      ]).catch(() => {});
      // why: a broken pipe must not leave CI waiting on Chrome after the lane has produced diagnostics.
      if (!closed) browser.process()?.kill('SIGKILL');
    }
    rmSync(fault.directory, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  main(lifecycleTarget).catch((error) => {
    console.error('Chrome lifecycle fault lane failed:', error?.stack || error);
    process.exit(1);
  });
}
