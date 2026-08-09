#!/usr/bin/env bun
// Pipe-backed physical MV3 lifecycle fault lane.

import {
  closeSync, constants, cpSync, fstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { resolveChrome } from './e2e-harness.mjs';

const ROOT = resolve(import.meta.dir, '..', '..');
const RESULT_DIR = join(ROOT, 'artifacts', 'chrome-lifecycle');
const REACHED_KEY = 'peerd.e2e.lifecycleFault.reached';
const OPERATION_KEY = 'peerd.lifecycle.operations';
const NOTICE_KEY = 'peerd.lifecycle.pendingNotices';

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

const makeFaultExtension = () => {
  const directory = mkdtempSync(join(tmpdir(), 'peerd-chrome-lifecycle-fault-'));
  const extension = join(directory, 'extension');
  cpSync(join(ROOT, 'extension'), extension, { recursive: true });
  writeFileSync(join(extension, 'background', 'lifecycle-fault-probe.js'), `
const REACHED_KEY = ${JSON.stringify(REACHED_KEY)};
let armed = false;
globalThis.peerdLifecycleFaultProbe = {
  arm() { armed = true; },
  async beforeExecute(toolName) {
    if (!armed || toolName !== 'script') return;
    armed = false;
    const stored = await chrome.storage.local.get(REACHED_KEY);
    const reached = stored[REACHED_KEY] ?? [];
    await chrome.storage.local.set({
      [REACHED_KEY]: [...reached, { toolName, at: Date.now() }],
    });
    await new Promise(() => {});
  },
};
`, { flag: 'wx', mode: 0o600 });

  const serviceWorker = join(extension, 'background', 'service-worker.js');
  let source = `import './lifecycle-fault-probe.js';\n${readFileSync(serviceWorker, 'utf8')}`;
  const routeAnchor = "  'a2a/call': (/** @type {any} */ msg, /** @type {any} */ sender) => a2aCallRoute(msg, sender),";
  if (source.split(routeAnchor).length !== 2) throw new Error('fault route seam changed');
  source = source.replace(routeAnchor, `  'lifecycle-fault/dispatch': async (msg) => {
    globalThis.peerdLifecycleFaultProbe.arm();
    await chrome.storage.local.set({ [${JSON.stringify(REACHED_KEY)}]: [] });
    return dispatchToolCall({
      id: msg.callId,
      name: 'script',
      args: { code: "return 'must not run';" },
    }, await buildToolContext({
      sessionId: msg.sessionId,
      exposure: 'main',
      lifecycleTurnId: 'chrome-physical-fault-turn',
      lifecycleUserInitiated: true,
    }));
  },
${routeAnchor}`);
  overwriteRegularFile(serviceWorker, source);

  const dispatcher = join(extension, 'peerd-runtime', 'tools', 'dispatcher.js');
  source = readFileSync(dispatcher, 'utf8');
  const executeLine = '    let result = await tool.execute(args, execCtx);';
  if (source.split(executeLine).length !== 2) throw new Error('dispatcher fault seam changed');
  overwriteRegularFile(dispatcher, source.replace(executeLine,
    `    await globalThis.peerdLifecycleFaultProbe?.beforeExecute(call.name);\n${executeLine}`));
  return { directory, extension };
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

const main = async () => {
  mkdirSync(RESULT_DIR, { recursive: true });
  rmSync(join(RESULT_DIR, 'result.json'), { force: true });
  const fault = makeFaultExtension();
  const profile = mkdtempSync(join(tmpdir(), 'peerd-pipe-lifecycle-'));
  let browser;
  let forcedTerminationAttempted = false;
  let stage = 'launch';
  try {
    browser = await puppeteer.launch({
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
    stage = 'initial service-worker target';
    const discoveredTarget = await withDeadline(browser.waitForTarget((candidate) =>
      candidate.type() === 'service_worker'
      && candidate.url().endsWith('/background/service-worker.js'), { timeout: 30_000 }),
    35_000, stage);
    stage = 'service-worker attachment';
    const initialWorker = await withDeadline(discoveredTarget.worker(), 10_000, stage);
    await withDeadline(initialWorker.client.send('Runtime.evaluate', { expression: 'true' }),
      10_000, stage);
    const extensionId = new URL(discoveredTarget.url()).host;
    stage = 'extension page';
    const page = await withDeadline(browser.newPage(), 10_000, stage);
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
    const generation = await waitFor(() => page.evaluate(async () =>
      (await chrome.storage.local.get('peerd.lifecycle.generation'))['peerd.lifecycle.generation']));
    assert(generation?.id, 'production lifecycle boot minted a generation');
    const operationId = `${sessionId}:${callId}`;
    const inFlight = await waitFor(() => page.evaluate(async ({ reachedKey, operationKey, id }) => {
      const stored = await chrome.storage.local.get([reachedKey, operationKey]);
      const record = stored[operationKey]?.[id];
      return stored[reachedKey]?.length === 1 && record?.state === 'awaiting_remote'
        && record?.dispatched === true;
    }, { reachedKey: REACHED_KEY, operationKey: OPERATION_KEY, id: operationId }));
    assert(inFlight, 'real Class E dispatch crossed its durable dispatch marker');
    const target = discoveredTarget;

    stage = 'physical service-worker termination';
    forcedTerminationAttempted = true;
    await withDeadline(initialWorker.close(), 10_000, stage);
    stage = 'service-worker restart';
    await withDeadline(page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'state/get' }).catch(() => null)), 10_000, stage);
    const nextTarget = await withDeadline(browser.waitForTarget((candidate) =>
      candidate !== target && candidate.type() === 'service_worker'
      && candidate.url().endsWith('/background/service-worker.js'), { timeout: 30_000 }),
    35_000, stage);
    assert(nextTarget !== target, 'Worker.close physically replaced the MV3 target');

    stage = 'lifecycle recovery';
    const recovered = await waitFor(() => page.evaluate(async ({ operationKey, noticeKey, reachedKey, id, sid }) => {
      const stored = await chrome.storage.local.get([operationKey, noticeKey, reachedKey]);
      return stored[operationKey]?.[id]?.state === 'outcome_unknown'
        && stored[noticeKey]?.[sid]?.some((notice) =>
          notice?.recoveryRecord?.recoveryState === 'outcome_unknown')
        && stored[reachedKey]?.length === 1;
    }, { operationKey: OPERATION_KEY, noticeKey: NOTICE_KEY, reachedKey: REACHED_KEY,
      id: operationId, sid: sessionId }));
    assert(recovered, 'restart preserves uncertainty, notice, and no tool-body re-entry');
    writeFileSync(join(RESULT_DIR, 'result.json'), JSON.stringify({
      status: 'passed', forcedTerminationAttempted: true,
      terminationBoundary: 'Puppeteer WebWorker.close over CDP pipe',
    }, null, 2));
  } catch (error) {
    writeFileSync(join(RESULT_DIR, 'result.json'), JSON.stringify({
      status: 'blocked', forcedTerminationAttempted,
      stage, error: error?.message ?? String(error),
    }, null, 2));
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

main().catch((error) => {
  console.error('Chrome lifecycle fault lane failed:', error?.stack || error);
  process.exit(1);
});
