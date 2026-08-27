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
const PROGRESS_KEY = 'peerd.e2e.lifecycleFault.progress';
const FAULT_PAGE = 'lifecycle-fault.html';
const FAULT_CODE = "return 'peerd-lifecycle-fault';";
const PASSPHRASE = 'peerd-physical-lifecycle-passphrase';
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
  'lifecycle-fault/dispatch': async (message, sender) => {
    try {
      if (message?.reached === true) {
        if (!offscreenUi(sender)
            || typeof message.runId !== 'string'
            || typeof message.ownerSessionId !== 'string'
            || scriptRuns.ownerFor(message.runId) !== message.ownerSessionId) {
          throw new Error('lifecycle fault offscreen custody proof refused');
        }
        await kv.set(${JSON.stringify(REACHED_KEY)}, [{
          toolName: 'script', phase: 'offscreen.runJob', at: Date.now(),
        }]);
        return { recorded: true };
      }
      if (message?.recoverOnly === true) {
        if (typeof message.passphrase !== 'string') {
          throw new Error('lifecycle recovery passphrase missing');
        }
        // Join the production boot transaction before attempting a manual
        // unlock; racing boot and unlock can make the locked boot finalizer
        // retire the exact authority channel serving the other call.
        await kv.set(${JSON.stringify(PROGRESS_KEY)}, 'recovery:kernel-ready');
        await kernelReady;
        await kv.set(${JSON.stringify(PROGRESS_KEY)}, 'recovery:vault-unlock');
        if (vault.isLocked()) {
          await vault.unlock(message.passphrase);
          await kv.set(${JSON.stringify(PROGRESS_KEY)}, 'recovery:feature-host');
          await featureHost.vaultUnlocked();
          await kv.set(${JSON.stringify(PROGRESS_KEY)}, 'recovery:custody');
          await recoveryCustody.resume();
        }
        // Force the production turn owner and its lifecycle reconciler to load;
        // reading storage alone would only prove that old bytes survived.
        await kv.set(${JSON.stringify(PROGRESS_KEY)}, 'recovery:controller-relays');
        await getControllerRelays();
        await kv.delete(${JSON.stringify(PROGRESS_KEY)});
        return {
          recovered: true,
          generation: await kv.get('peerd.lifecycle.generation'),
        };
      }
      if (message?.start === true && typeof message.passphrase === 'string') {
        await kernelReady;
        // This test-only route owns its setup transaction. Await the host
        // transition instead of racing the production route's deliberately
        // fire-and-forget post-initialize notification against turn startup.
        await vault.initialize(message.passphrase);
        await featureHost.vaultInitialized();
        const onboarded = await kernelProfile.complete({ peerName: 'peerd', facts: null });
        if (onboarded?.ok !== true) throw new Error('lifecycle fault onboarding failed');
        await settingsStore.update({ providerName: 'ollama', providerModel: 'qwen3:8b' });
        const relays = await getControllerRelays();
        if (typeof relays.sessions?.create !== 'function') {
          throw new Error('lifecycle fault session authority unavailable');
        }
        const session = await relays.sessions.create({
          provider: 'ollama', model: 'qwen3:8b',
          permissionMode: 'act', confirmActions: false,
        });
        if (typeof session?.sessionId !== 'string') {
          throw new Error('lifecycle fault session creation failed');
        }
        await sessionCache.sessionSet('currentSessionId', session.sessionId);
        // The exact authority effect intentionally never settles, so the
        // request cannot be awaited. Its durable marker below is the proof of
        // admission; any early refusal is persisted as a harness failure.
        void demandRoutes['agent/send']({
          text: 'Run the lifecycle fault script exactly once.',
          sessionId: session.sessionId,
        }).then((started) => {
          if (started?.ok !== true) {
            throw new Error('lifecycle fault turn did not start: ' + JSON.stringify(started));
          }
        }).catch((cause) => kv.set(${JSON.stringify(BOOT_ERROR_KEY)},
          cause?.stack || cause?.message || String(cause)));
        return { started: true };
      }
      throw new Error('lifecycle fault request is invalid');
    } catch (cause) {
      const detail = (cause?.stack || cause?.message || String(cause))
        + '\\nfeature leases: ' + JSON.stringify(featureHost.runtime.snapshot());
      await kv.set(${JSON.stringify(BOOT_ERROR_KEY)}, detail);
      throw new Error(detail);
    }
  },
  ...demandRoutes,`, 'source fault route');
};

export const injectLifecycleFaultTurnBudget = (input) => replaceExact(
  input,
  'const TURN_RUNTIME_LOAD_TIMEOUT_MS = 15_000;',
  'const TURN_RUNTIME_LOAD_TIMEOUT_MS = 120_000;',
  'source lifecycle turn-load budget',
);

export const injectLifecycleFaultEffect = (input) => {
  const anchor = '        const result = await client.execHeadless(code, opts);';
  const injected = replaceExact(input, anchor, `        if (code === ${JSON.stringify(FAULT_CODE)}) {
          if (call?.name !== 'script') {
            throw new Error('lifecycle fault execution target changed');
          }
          if (typeof ctx.lifecycle?.beginTracking !== 'function') {
            throw new Error('lifecycle fault tracking unavailable');
          }
          for (const [toolName, retryClass, callId] of [
            ['fetch_url', 'B', 'chrome-fault-b'],
            ['remember', 'C', 'chrome-fault-c'],
            ['dweb_share', 'D', 'chrome-fault-d'],
          ]) {
            const tracking = await ctx.lifecycle.beginTracking({
              callId, tool: { name: toolName, retryClass },
              sessionId, ownerSessionId: sessionId,
              target: 'tool:' + toolName,
              args: { lifecycleFault: true },
              turnId: 'chrome-physical-fault-turn',
              userInitiated: true,
            });
            if (!tracking?.handle) throw new Error('lifecycle fault tracking failed');
          }
        }
${anchor}`, 'source exact script effect');
  return injected;
};

export const injectLifecycleFaultJob = (input) => {
  const anchor = 'const _runJob = async ({ code, timeoutMs = 30000, startedAt, deadlineAt, a2a = false, actors = false, siteFetch = \'\', caps, ownerSessionId, ownerToolUseId, runId, pageProgramSemanticToken, workspaceSessionId, workspaceBudgetBytes = WORKSPACE_BUDGET_BYTES }, { sendToSW, extractMarkdown, opfsForRoot = opfsHelpers }) => {';
  return replaceExact(input, anchor, `${anchor}
  if (code === ${JSON.stringify(FAULT_CODE)}) {
    const recorded = await sendToSW('lifecycle-fault/dispatch', {
      reached: true, runId, ownerSessionId,
    });
    if (recorded?.recorded !== true) {
      throw new Error('lifecycle fault offscreen custody proof failed');
    }
    // The physical lane kills Chrome only after the real offscreen job host
    // accepts custody. Ignore cancellation to model loss during execution.
    await new Promise(() => {});
  }`, 'source exact offscreen job effect');
};

export const assertLifecycleFaultExecutionSeam = ({ tracking, controller, bridge, authority }) => {
  const canaries = [
    [tracking, 'await operationLog.markDispatched(operationId);'],
    [controller, "rpc('turn.tool.prepare', {"],
    [controller, "rpc('turn.execution.run-script', { ...binding, ...scriptRequest })"],
    [controller, "rpc('turn.tool.settle', {"],
    [bridge, "case 'turn.execution.run-script':"],
    [authority, 'const result = await client.execHeadless(code, opts);'],
  ];
  if (canaries.some(([source, canary]) => source.split(canary).length !== 2)) {
    throw new Error('source lifecycle controller execution seam changed');
  }
};

const injectLifecycleFaultTree = (extension) => {
  const kernel = join(extension, 'background', 'vault-kernel.js');
  overwriteRegularFile(
    kernel,
    injectLifecycleFaultKernel(readFileSync(kernel, 'utf8')),
  );
  const authority = join(extension, 'background', 'execution-tool-authority.js');
  const authoritySource = readFileSync(authority, 'utf8');
  assertLifecycleFaultExecutionSeam({
    tracking: readFileSync(join(extension, 'peerd-runtime', 'lifecycle', 'dispatch-tracking.js'), 'utf8'),
    controller: readFileSync(join(extension, 'offscreen', 'controller-turn-runtime.js'), 'utf8'),
    bridge: readFileSync(join(extension, 'background', 'controller-turn-bridge.js'), 'utf8'),
    authority: authoritySource,
  });
  overwriteRegularFile(authority, injectLifecycleFaultEffect(authoritySource));
  const jobRunner = join(extension, 'offscreen', 'job-runner.js');
  overwriteRegularFile(
    jobRunner,
    injectLifecycleFaultJob(readFileSync(jobRunner, 'utf8')),
  );
  const turnOwner = join(extension, 'background', 'kernel-turn-owner.js');
  overwriteRegularFile(
    turnOwner,
    injectLifecycleFaultTurnBudget(readFileSync(turnOwner, 'utf8')),
  );
  // A blank extension-origin caller avoids side-panel startup issuing its own
  // concurrent vault/status lease while the fault fixture initializes.
  writeFileSync(join(extension, FAULT_PAGE), '<!doctype html><title>lifecycle fault</title>\n');
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
    readFileSync(join(staging, 'background/execution-tool-authority.js'), 'utf8'),
    readFileSync(join(staging, 'offscreen/controller-turn-runtime.js'), 'utf8'),
    readFileSync(join(staging, 'offscreen/job-runner.js'), 'utf8'),
  ].join('\n');
  for (const canary of [
    REACHED_KEY, BOOT_ERROR_KEY, 'lifecycle-fault/dispatch',
    'turn.execution.run-script', FAULT_CODE, 'lifecycle fault execution target changed',
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

const lifecycleToolSse = () => {
  const toolCall = {
    index: 0,
    id: 'chrome-physical-script-call',
    type: 'function',
    function: { name: 'script', arguments: JSON.stringify({ code: FAULT_CODE }) },
  };
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}`,
    'data: [DONE]', '',
  ].join('\n\n') + '\n\n';
};

const armModelWire = async (target) => {
  const session = await target.createCDPSession();
  const requests = [];
  const diagnostics = [];
  session.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error') return;
    diagnostics.push(args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
  });
  session.on('Fetch.requestPaused', ({ requestId, request }) => {
    const url = String(request?.url ?? '');
    let tools = [];
    try {
      const requestBody = JSON.parse(request?.postData ?? '{}');
      tools = Array.isArray(requestBody?.tools)
        ? requestBody.tools.map((tool) => tool?.function?.name).filter(Boolean) : [];
    } catch { /* diagnostic only */ }
    requests.push({ url, tools });
    const body = url.includes('/v1/chat/completions')
      ? lifecycleToolSse()
      : JSON.stringify({ models: [{ name: 'qwen3:8b', size: 1 }] });
    const contentType = url.includes('/v1/chat/completions')
      ? 'text/event-stream' : 'application/json';
    void session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: contentType }],
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
  });
  await session.send('Runtime.enable');
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*11434*' }] });
  return Object.freeze({
    requests,
    diagnostics,
    detach: () => session.detach(),
  });
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
    protocolTimeout: 120_000,
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
    const modelWire = await armModelWire(discoveredTarget);
    const extensionId = new URL(discoveredTarget.url()).host;
    stage = 'extension page';
    let page = await withDeadline(browser.newPage(), 10_000, stage);
    await withDeadline(page.goto(`chrome-extension://${extensionId}/${FAULT_PAGE}`),
      30_000, stage);
    const callId = 'chrome-physical-script-call';
    stage = 'real controller tool effect';
    const started = await withDeadline(page.evaluate((passphrase) =>
      chrome.runtime.sendMessage({
        type: 'lifecycle-fault/dispatch', start: true, passphrase,
    }), PASSPHRASE), 120_000, stage);
    if (started?.started !== true) {
      const storedDetail = await page.evaluate(async (key) =>
        (await chrome.storage.local.get(key))[key], BOOT_ERROR_KEY);
      throw new Error(`lifecycle fault turn did not start: ${storedDetail ?? JSON.stringify(started)}; controller diagnostics: ${JSON.stringify(modelWire.diagnostics)}`);
    }
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
    const inFlight = await waitFor(() => page.evaluate(async ({ reachedKey, operationKey,
      bootErrorKey, cid }) => {
      const stored = await chrome.storage.local.get([
        reachedKey, operationKey, bootErrorKey,
      ]);
      if (stored[bootErrorKey]) return { failure: stored[bootErrorKey] };
      const entry = Object.entries(stored[operationKey] ?? {}).find(([id, record]) =>
        id.endsWith(':' + cid) && record?.toolName === 'script');
      const record = entry?.[1];
      return stored[reachedKey]?.[0]?.phase === 'offscreen.runJob'
        && record?.state === 'awaiting_remote' && record?.dispatched === true
        ? { operationId: entry[0], sessionId: record.sessionId } : null;
    }, {
      reachedKey: REACHED_KEY, operationKey: OPERATION_KEY,
      bootErrorKey: BOOT_ERROR_KEY, cid: callId,
    }));
    if (inFlight?.failure) {
      throw new Error(`controller fault turn failed: ${inFlight.failure}; controller diagnostics: ${JSON.stringify(modelWire.diagnostics)}; model requests: ${JSON.stringify(modelWire.requests)}`);
    }
    if (!inFlight?.operationId || !inFlight?.sessionId) {
      const faultState = await page.evaluate(async (keys) =>
        chrome.storage.local.get(keys), [
        REACHED_KEY, OPERATION_KEY, BOOT_ERROR_KEY,
      ]);
      throw new Error(`real controller Class E effect did not cross the offscreen job host; state: ${JSON.stringify(faultState)}; controller diagnostics: ${JSON.stringify(modelWire.diagnostics)}; model requests: ${JSON.stringify(modelWire.requests)}`);
    }
    const { operationId, sessionId } = inFlight;
    assert(true, 'model-issued Class E tool crossed controller prepare and exact effect authority');
    await modelWire.detach().catch(() => {});

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
    await withDeadline(page.goto(`chrome-extension://${extensionId}/${FAULT_PAGE}`),
      30_000, stage);
    try {
      await withDeadline(page.evaluate((passphrase) => chrome.runtime.sendMessage({
        type: 'lifecycle-fault/dispatch', recoverOnly: true,
        passphrase,
      }), PASSPHRASE), 120_000, 'lifecycle recovery boot');
    } catch (cause) {
      const diagnostics = await page.evaluate(async (keys) =>
        chrome.storage.local.get(keys), [PROGRESS_KEY, BOOT_ERROR_KEY]).catch(() => null);
      throw new Error(`${cause?.message ?? cause}; recovery diagnostics: ${JSON.stringify(diagnostics)}`);
    }
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
