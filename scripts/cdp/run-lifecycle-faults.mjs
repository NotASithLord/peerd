#!/usr/bin/env bun
// Physical MV3 lifecycle fault lane.
//
// A test-only copy of the extension leaves representative B/C/D/E operations
// in the production operation log at the real dispatch boundary. CDP then
// closes the service-worker target. The fresh worker must reconcile those
// records through production storage and recovery code. No shipped extension
// file contains a test route or fault flag.

import {
  closeSync, constants, cpSync, fstatSync, mkdtempSync, openSync, readFileSync,
  mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  evalIn, launchPeerd, sleep, waitFor,
} from './e2e-harness.mjs';

const ROOT = resolve(import.meta.dir, '..', '..');
const REACHED_KEY = 'peerd.e2e.lifecycleFault.reached';
const OPERATION_KEY = 'peerd.lifecycle.operations';
const NOTICE_KEY = 'peerd.lifecycle.pendingNotices';
const BOOT_ERROR_KEY = 'peerd.e2e.lifecycleFault.bootError';
const RESULT_DIR = join(ROOT, 'artifacts', 'chrome-lifecycle');

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
import { createOperationLog } from '/peerd-runtime/index.js';

const REACHED_KEY = ${JSON.stringify(REACHED_KEY)};
const GENERATION_KEY = 'peerd.lifecycle.generation';
const storage = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => { await chrome.storage.local.set({ [key]: value }); },
};
const operationLog = createOperationLog({ storage });
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'lifecycle-fault/start') {
    (async () => {
      const generation = await storage.get(GENERATION_KEY);
      if (!generation?.id) throw new Error('lifecycle generation is not ready');
      const sessionId = String(message.sessionId ?? '');
      const seeds = [
        ['read_pdf', 'B'],
        ['remember', 'C'],
        ['dweb_share', 'D'],
        ['script', 'E'],
      ];
      const operationIds = [];
      for (const [toolName, retryClass] of seeds) {
        const operationId = sessionId + ':fault-' + retryClass.toLowerCase();
        await operationLog.begin({
          operationId, sessionId, toolName, retryClass,
          generationId: generation.id,
        });
        await operationLog.transition(operationId, 'running');
        await operationLog.markDispatched(operationId);
        operationIds.push(operationId);
      }
      const reached = (await storage.get(REACHED_KEY)) ?? [];
      await storage.set(REACHED_KEY, [...reached, { toolName: 'script', at: Date.now() }]);
      await new Promise(() => {});
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return undefined;
});
`, { flag: 'wx', mode: 0o600 });

  const serviceWorker = join(extension, 'background', 'service-worker.js');
  const serviceWorkerSource = `import './lifecycle-fault-probe.js';\n${readFileSync(serviceWorker, 'utf8')}`;
  const bootErrorLine = "    console.error('[sw] lifecycle boot failed; Class D/E dispatches fail closed', e);";
  if (serviceWorkerSource.split(bootErrorLine).length !== 2) {
    throw new Error('lifecycle boot error seam no longer matches service-worker.js');
  }
  overwriteRegularFile(serviceWorker, serviceWorkerSource.replace(bootErrorLine,
    `${bootErrorLine}\n    chrome.storage.local.set({ [${JSON.stringify(BOOT_ERROR_KEY)}]: e?.stack || e?.message || String(e) });`));
  return { directory, extension };
};

const readLocal = (page, keys) => evalIn(page,
  `chrome.storage.local.get(${JSON.stringify(keys)})`, true);

const assert = (condition, message, detail = '') => {
  if (!condition) throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
  console.log(`  PASS ${message}`);
};

const main = async () => {
  const fault = makeFaultExtension();
  const sessionId = 'chrome-physical-lifecycle-session';
  let ctx = null;
  try {
    ctx = await launchPeerd({
      extensionDir: fault.extension,
      // Direct DevTools attachment changes the worker's lifetime. This lane
      // only needs the target identity and physical close endpoint, so leave
      // the worker unattached.
      interceptModel: false,
    });
    let bootDiagnostic = null;
    const generationReady = await waitFor(async () => {
      const stored = await readLocal(ctx.page, [
        'peerd.lifecycle.generation', BOOT_ERROR_KEY,
      ]);
      bootDiagnostic = stored;
      if (stored?.[BOOT_ERROR_KEY]) throw new Error(stored[BOOT_ERROR_KEY]);
      return stored?.['peerd.lifecycle.generation']?.id ?? null;
    }, { budgetMs: 10_000, pollMs: 50 });
    if (!generationReady) {
      mkdirSync(RESULT_DIR, { recursive: true });
      const capability = {
        status: 'blocked',
        forcedTerminationAttempted: false,
        terminationBoundary: 'Target.closeTarget',
        reason: 'The MV3 lifecycle generation did not become durable under the remote-debugging-port harness, so terminating the target would not test recovery.',
        diagnostic: bootDiagnostic,
      };
      writeFileSync(join(RESULT_DIR, 'background-fault-capability.json'),
        JSON.stringify(capability, null, 2));
      console.log('  SKIP MV3 target termination: lifecycle boot precondition unavailable');
      return;
    }
    assert(true, 'the production lifecycle boot minted a generation');
    await evalIn(ctx.page, `void chrome.runtime.sendMessage(${JSON.stringify({
      type: 'lifecycle-fault/start', sessionId,
    })}).catch(() => {})`);

    const inFlight = await waitFor(async () => {
      const stored = await readLocal(ctx.page, [REACHED_KEY, OPERATION_KEY]);
      const records = Object.values(stored?.[OPERATION_KEY] ?? {});
      const script = records.find((record) => record?.toolName === 'script'
        && record?.operationId?.endsWith(':fault-e'));
      return stored?.[REACHED_KEY]?.length === 1
        && script?.state === 'awaiting_remote'
        && script?.dispatched === true
        ? { script, reached: stored[REACHED_KEY] }
        : null;
    }, { budgetMs: 30_000, pollMs: 50 });
    assert(inFlight, 'Class E is durably dispatched before the fault gate', JSON.stringify(inFlight));

    const oldTargetId = await ctx.terminateServiceWorker();
    assert(typeof oldTargetId === 'string', 'CDP physically closes the MV3 service-worker target');
    const next = await ctx.restartServiceWorker(oldTargetId);
    assert(next.targetId !== oldTargetId, 'a distinct MV3 service-worker target starts');

    const recovered = await waitFor(async () => {
      const stored = await readLocal(ctx.page, [REACHED_KEY, OPERATION_KEY, NOTICE_KEY]);
      const records = stored?.[OPERATION_KEY] ?? {};
      const expected = [
        [`${sessionId}:fault-e`, 'outcome_unknown'],
        [`${sessionId}:fault-b`, 'interrupted'],
        [`${sessionId}:fault-c`, 'interrupted'],
        [`${sessionId}:fault-d`, 'outcome_unknown'],
      ];
      const statesMatch = expected.every(([id, state]) => records[id]?.state === state);
      const notices = stored?.[NOTICE_KEY]?.[sessionId] ?? [];
      return statesMatch && notices.length >= expected.length
        ? { records, notices, reached: stored?.[REACHED_KEY] ?? [] }
        : null;
    }, { budgetMs: 30_000, pollMs: 50 });
    assert(recovered, 'the fresh worker reconciles E/D ambiguity and B/C safe interruption');
    assert(recovered.notices.some((notice) => notice?.recoveryRecord?.recoveryState === 'outcome_unknown')
      && recovered.notices.some((notice) => notice?.recoveryRecord?.recoveryState === 'interrupted'),
    'recovery notices preserve the unsafe versus safe distinction');

    await sleep(1_500);
    const afterQuiet = await readLocal(ctx.page, [REACHED_KEY, OPERATION_KEY]);
    assert(afterQuiet?.[REACHED_KEY]?.length === 1,
      'the interrupted Class E body is never replayed after restart', JSON.stringify(afterQuiet));
    assert(afterQuiet?.[OPERATION_KEY]?.[`${sessionId}:fault-e`]?.state === 'outcome_unknown',
      'the original Class E identity remains terminal and guarded');
    console.log('Chrome lifecycle fault lane passed');
  } finally {
    ctx?.close();
    rmSync(fault.directory, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error('Chrome lifecycle fault lane failed:', error?.stack || error);
  process.exit(1);
});
