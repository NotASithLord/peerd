#!/usr/bin/env bun
// Physical Store-Chrome controller fault oracle. It retires the real offscreen
// host while an admitted turn is live; production receives only ordinary
// browser lifecycle signals and has no test hook. Dedicated-Worker generation
// loss is covered at the exact MessagePort/channel seam because pinned Chrome
// exposes its inspector target but cannot physically terminate that Worker.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  digestTree, PRODUCTION_BACKGROUND_ENTRY, readChromeIdentity, sha256File,
} from './passkey-signup-lane.mjs';
import {
  readActiveFeatureLease, startOllamaAcceptanceFixture,
} from './product-acceptance-probes.mjs';
import {
  attach, evalIn, launchPeerd, rpc, sseText, sseToolCall, unlockAndReady, waitFor,
} from './e2e-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
export const CONTROLLER_FAULT_REPORT = join(
  ARTIFACTS_DIR, 'e2e', 'controller-fault-evidence.json',
);
export const CONTROLLER_FAULT_BUDGETS = Object.freeze({
  startupMs: 180_000,
  baselineMs: 30_000,
  lossMs: 30_000,
  retryMs: 45_000,
});
const BASELINE_PROMPT = 'establish a successful semantic controller baseline';
const BASELINE_TEXT = 'controller physical baseline ok';
const HOST_FAULT_TEXT = 'controller whole host physical fault turn';
const HOST_RETRY_TEXT = 'controller whole host retry opening one blank tab';
const HOST_RETRY_REPLY = 'controller whole host retry ok';
const POST_EFFECT_FAULT_TEXT = 'controller post effect physical fault opening one blank tab';
const POST_EFFECT_WAKE_TEXT = 'wake after controller post effect fault without replay';
const POST_EFFECT_WAKE_REPLY = 'controller post effect wake ok';
const UNKNOWN_TURN_TEXT = 'Turn outcome unknown. Check the session before retrying.';
const HEX_256 = /^[a-f0-9]{64}$/;

const assert = (condition, message) => {
  if (!condition) throw new Error(`controller fault report: ${message}`);
};

const sourceVersion = (root) => String(JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).version);

const digestHarness = async (sourceRoot) => {
  const graph = [...await collectStaticModuleGraph(sourceRoot, ENTRY)].sort();
  const inputs = [...new Set([
    ...graph,
    join(sourceRoot, 'package.json'),
    join(sourceRoot, 'bun.lock'),
    join(HERE, 'chrome-version.txt'),
  ])].sort();
  const digest = createHash('sha256');
  for (const path of inputs) {
    const rel = relative(sourceRoot, path).split('\\').join('/');
    const bytes = readFileSync(path);
    digest.update(`input\0${rel}\0${bytes.byteLength}\0`);
    digest.update(bytes);
    digest.update('\0');
  }
  return { sha256: digest.digest('hex'), files: inputs.length };
};

const offscreenContexts = (page) => evalIn(page, `(async () => {
  if (typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('runtime.getContexts unavailable in pinned Chrome');
  }
  return (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  })).filter((context) => String(context.documentUrl || '').split('#', 1)[0]
    .endsWith('/offscreen/offscreen.html'))
    .map((context) => ({
      contextId: context.contextId,
      contextType: context.contextType,
      documentUrl: context.documentUrl,
    }));
})()`, true);

const exactOffscreenContext = async (page) => {
  const contexts = await offscreenContexts(page);
  if (contexts.length !== 1 || typeof contexts[0].contextId !== 'string') {
    throw new Error(`expected one exact offscreen controller host: ${JSON.stringify(contexts)}`);
  }
  return contexts[0];
};

const closeOffscreenHost = async (serviceWorkerConnection, page, context) => {
  const result = await evalIn(serviceWorkerConnection, `(async () => {
    if (typeof chrome.offscreen?.closeDocument !== 'function') {
      return { ok: false, error: 'offscreen-close-unavailable' };
    }
    await chrome.offscreen.closeDocument();
    return { ok: true };
  })()`, true);
  if (result?.ok !== true) {
    throw new Error(`authoritative offscreen close failed: ${JSON.stringify(result)}`);
  }
  const gone = await waitFor(async () => !(await offscreenContexts(page))
    .some((candidate) => candidate.contextId === context.contextId), {
    budgetMs: 10_000, pollMs: 10,
  });
  if (!gone) throw new Error('offscreen controller host remained after physical close');
  return { method: 'chrome.offscreen.closeDocument', success: true };
};

const exactControllerHost = async (page) => {
  const { lease } = await readActiveFeatureLease(page, 'controller');
  return {
    hostEpoch: lease.hostEpoch,
    leaseId: lease.leaseId,
    generation: lease.generation,
    kernelEpoch: lease.kernelEpoch,
  };
};

const auditEntries = async (page) => {
  const result = await rpc(page, { type: 'audit/list', limit: 1000 });
  if (result?.ok !== true || !Array.isArray(result.entries)) {
    throw new Error(`audit/list failed: ${JSON.stringify(result)}`);
  }
  return result.entries;
};

const auditDelta = async (page, priorIds) => {
  const entries = (await auditEntries(page)).filter((entry) => !priorIds.has(entry.id));
  const toolEntries = entries.filter(
    (entry) => entry.type === 'tool_executed' || entry.type === 'tool_failed',
  );
  return {
    entries: entries.length,
    types: entries.map((entry) => entry.type),
    toolEffects: toolEntries.length,
    openTabEffects: toolEntries.filter((entry) => entry.type === 'tool_executed'
      && entry.details?.tool === 'open_tab' && entry.details?.performed === true).length,
  };
};

const tabIds = (page) => evalIn(page, `(async () =>
  (await chrome.tabs.query({})).map((tab) => tab.id).filter(Number.isInteger))()`, true);

const terminalState = (page, text, assistantText = null) => evalIn(page, `(() => {
  const user = [...document.querySelectorAll('.message-user')]
    .some((node) => (node.textContent || '').includes(${JSON.stringify(text)}));
  const assistants = [...document.querySelectorAll('.message-assistant .bubble')]
    .map((node) => (node.textContent || '').trim());
  const busy = !!document.querySelector('.message-assistant.streaming, form.input-bar button.stop');
  const expected = ${JSON.stringify(assistantText)};
  return user && !busy && (expected === null || assistants.includes(expected))
    ? { user, assistants, busy } : null;
})()`);

const sendTurn = async (page, text) => {
  const result = await rpc(page, { type: 'agent/send', text });
  if (result?.ok !== true) throw new Error(`agent/send failed: ${JSON.stringify(result)}`);
  return result;
};

const currentSessionId = async (page) => {
  const result = await rpc(page, { type: 'session/list' });
  const sessionId = result?.sessions?.[0]?.sessionId;
  if (result?.ok !== true || typeof sessionId !== 'string') {
    throw new Error(`session/list did not expose the live chat: ${JSON.stringify(result)}`);
  }
  return sessionId;
};

/**
 * @param {Array<Record<string, any>>} messages
 * @param {string} prompt
 * @param {string|null} [assistantId]
 * @returns {{ user: Record<string, any>, assistant: Record<string, any> }|null}
 */
export const selectDurableTurn = (messages, prompt, assistantId = null) => {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index]?.content === prompt) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  const tail = messages.slice(userIndex + 1);
  const assistant = assistantId === null
    ? tail.filter((message) => message?.role === 'assistant').at(-1)
    : tail.find((message) => message?.role === 'assistant' && message?.id === assistantId);
  return assistant ? { user: messages[userIndex], assistant } : null;
};

const durableTurn = async (page, sessionId, prompt, assistantId = null) => {
  const result = await rpc(page, { type: 'session/get', sessionId });
  if (result?.ok !== true || !Array.isArray(result?.session?.messages)) {
    throw new Error(`session/get failed for fault evidence: ${JSON.stringify(result)}`);
  }
  const messages = result.session.messages;
  const selected = selectDurableTurn(messages, prompt, assistantId);
  if (!selected) throw new Error(`durable assistant settlement missing: ${prompt}`);
  const { user, assistant } = selected;
  return {
    sessionId,
    userMessageId: user.id,
    assistant: {
      id: assistant.id,
      content: assistant.content ?? '',
      streaming: assistant.streaming === true,
      error: assistant.error ?? null,
      errorCode: assistant.errorCode ?? null,
      outcomeKnown: assistant.outcomeKnown ?? null,
      retryable: assistant.retryable ?? null,
      stopReason: assistant.stopReason ?? null,
      toolUseNames: Array.isArray(assistant.toolUses)
        ? assistant.toolUses.map((tool) => tool.name) : [],
    },
  };
};

const unknownSettlement = (fault) => fault?.terminal?.busy === false
  && fault?.lifecycle?.assistant?.streaming === false
  && fault?.lifecycle?.assistant?.error === UNKNOWN_TURN_TEXT
  && typeof fault?.lifecycle?.assistant?.errorCode === 'string'
  && fault.lifecycle.assistant.errorCode.length > 0
  && fault?.lifecycle?.assistant?.outcomeKnown === false
  && fault?.lifecycle?.assistant?.retryable === false;

const durableUnknown = (lifecycle) => lifecycle?.assistant?.streaming === false
  && lifecycle?.assistant?.error === UNKNOWN_TURN_TEXT
  && typeof lifecycle?.assistant?.errorCode === 'string'
  && lifecycle.assistant.errorCode.length > 0
  && lifecycle?.assistant?.outcomeKnown === false
  && lifecycle?.assistant?.retryable === false;

const exactRetry = (recovery, reply) => recovery?.modelCalls === 2
  && recovery?.audit?.openTabEffects === 1
  && recovery?.openedTabIds?.length === 1
  && recovery?.terminal?.assistants?.includes(reply)
  && recovery?.terminal?.busy === false
  && recovery?.lifecycle?.assistant?.content === reply
  && recovery?.lifecycle?.assistant?.streaming === false
  && recovery?.lifecycle?.assistant?.error === null;

export const assertControllerFaultReport = (report) => {
  assert(report?.schema === 3 && report?.ok === true, 'schema/ok');
  assert(report?.bindings?.channel === 'store' && report?.bindings?.browser === 'chrome',
    'target');
  assert(report?.bindings?.manifest?.backgroundEntry === PRODUCTION_BACKGROUND_ENTRY,
    'production background entry');
  for (const value of [
    report?.bindings?.artifact?.sha256,
    report?.bindings?.tree?.sha256,
    report?.bindings?.browserIdentity?.sha256,
    report?.bindings?.harness?.sha256,
  ]) assert(HEX_256.test(String(value ?? '')), 'digest binding');
  assert(report?.postRun?.artifact?.sha256 === report.bindings.artifact.sha256
    && report?.postRun?.artifact?.bytes === report.bindings.artifact.bytes
    && report?.postRun?.tree?.sha256 === report.bindings.tree.sha256
    && report?.postRun?.tree?.bytes === report.bindings.tree.bytes
    && report?.postRun?.tree?.files === report.bindings.tree.files,
  'immutable package inputs');

  const hostFault = report?.observations?.wholeHostLoss?.fault;
  const hostRecovery = report?.observations?.wholeHostLoss?.recovery;
  assert(hostFault?.physicalFault?.method === 'chrome.offscreen.closeDocument'
    && hostFault?.physicalFault?.success === true && hostFault?.modelCalls === 1
    && hostFault?.audit?.toolEffects === 0 && hostFault?.openedTabIds?.length === 0
    && unknownSettlement(hostFault),
  'bounded whole-host unknown settlement');
  assert(typeof hostFault?.context?.contextId === 'string'
    && typeof hostRecovery?.context?.contextId === 'string'
    && hostRecovery.context.contextId !== hostFault.context.contextId,
  'whole-host replacement context identity');
  assert(typeof hostFault?.host?.hostEpoch === 'string'
    && typeof hostRecovery?.host?.hostEpoch === 'string'
    && hostRecovery.host.hostEpoch !== hostFault.host.hostEpoch,
  'whole-host replacement epoch');
  assert(exactRetry(hostRecovery, HOST_RETRY_REPLY), 'whole-host exact retry');

  const postEffectFault = report?.observations?.postEffectHostLoss?.fault;
  const postEffectWake = report?.observations?.postEffectHostLoss?.wake;
  assert(postEffectFault?.physicalFault?.method === 'chrome.offscreen.closeDocument'
    && postEffectFault?.physicalFault?.success === true
    && postEffectFault?.modelCalls === 2
    && postEffectFault?.audit?.toolEffects === 1
    && postEffectFault?.audit?.openTabEffects === 1
    && postEffectFault?.openedTabIds?.length === 1
    && unknownSettlement(postEffectFault),
  'post-effect whole-host unknown settlement');
  assert(typeof postEffectFault?.context?.contextId === 'string'
    && typeof postEffectWake?.context?.contextId === 'string'
    && postEffectWake.context.contextId !== postEffectFault.context.contextId
    && typeof postEffectFault?.host?.hostEpoch === 'string'
    && typeof postEffectWake?.host?.hostEpoch === 'string'
    && postEffectWake.host.hostEpoch !== postEffectFault.host.hostEpoch,
  'post-effect replacement host identity');
  assert(postEffectWake?.modelCalls === 1
    && postEffectWake?.audit?.toolEffects === 0
    && postEffectWake?.audit?.openTabEffects === 0
    && postEffectWake?.openedTabIds?.length === 0
    && postEffectWake?.terminal?.busy === false
    && postEffectWake?.terminal?.assistants?.includes(POST_EFFECT_WAKE_REPLY)
    && postEffectWake?.lifecycle?.assistant?.content === POST_EFFECT_WAKE_REPLY
    && durableUnknown(postEffectWake?.faultLifecycleAfterWake),
  'post-effect wake did not replay and retained durable uncertainty');

  assert(report?.observations?.totalCompletionCalls === 7, 'no duplicate model calls');
  assert(JSON.stringify(report?.budgets) === JSON.stringify(CONTROLLER_FAULT_BUDGETS),
    'fixed budgets');
  return report;
};

export async function runControllerFaultEvidence({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  reportPath = join(artifactRoot, 'e2e', 'controller-fault-evidence.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  reportPath = resolve(reportPath);
  const version = sourceVersion(sourceRoot);
  const artifactPath = await packageArtifact({
    channel: 'store', browser: 'chrome', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'store-chrome');
  const manifest = JSON.parse(readFileSync(join(treePath, 'manifest.json'), 'utf8'));
  if (manifest?.background?.service_worker !== PRODUCTION_BACKGROUND_ENTRY) {
    throw new Error('controller fault lane did not package the production Store-Chrome kernel');
  }
  const bindings = {
    channel: 'store', browser: 'chrome', version,
    artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
    tree: await digestTree(treePath),
    manifest: { backgroundEntry: manifest.background.service_worker },
    browserIdentity: await readChromeIdentity(),
    harness: await digestHarness(sourceRoot),
  };
  let fixture;
  let ctx;
  let serviceWorkerConnection;
  try {
    fixture = await startOllamaAcceptanceFixture({
      completionDelayMs: 1_500,
      completionResponse: async ({ completionCall }) => {
        if (completionCall === 1) return sseText(BASELINE_TEXT);
        if (completionCall === 2 || completionCall === 3) return sseToolCall('open_tab', {});
        if (completionCall === 4) return sseText(HOST_RETRY_REPLY);
        if (completionCall === 5) return sseToolCall('open_tab', {});
        if (completionCall === 6) return sseText('must not survive physical host loss');
        if (completionCall === 7) return sseText(POST_EFFECT_WAKE_REPLY);
        return { status: 409, body: JSON.stringify({ error: 'duplicate-model-call' }) };
      },
    });
    ctx = await launchPeerd({
      extensionDir: treePath,
      interceptModel: false,
      expectedBackgroundEntry: PRODUCTION_BACKGROUND_ENTRY,
    });
    await unlockAndReady(ctx.page);
    serviceWorkerConnection = await attach(ctx.sw.wsUrl);
    await serviceWorkerConnection.send('Runtime.enable');

    await sendTurn(ctx.page, BASELINE_PROMPT);
    const baseline = await waitFor(() => terminalState(ctx.page, BASELINE_PROMPT, BASELINE_TEXT), {
      budgetMs: CONTROLLER_FAULT_BUDGETS.baselineMs, pollMs: 25,
    });
    if (!baseline || fixture.completionCalls() !== 1) {
      throw new Error(`baseline controller turn failed: ${JSON.stringify({
        baseline, completionCalls: fixture.completionCalls(), requests: fixture.requests,
      })}`);
    }
    const sessionId = await currentSessionId(ctx.page);
    const baselineLifecycle = await durableTurn(ctx.page, sessionId, BASELINE_PROMPT);

    const hostFaultAuditIds = new Set((await auditEntries(ctx.page)).map((entry) => entry.id));
    const hostFaultTabIds = new Set(await tabIds(ctx.page));
    await sendTurn(ctx.page, HOST_FAULT_TEXT);
    const hostFaultContext = await waitFor(() => exactOffscreenContext(ctx.page).catch(() => null), {
      budgetMs: 15_000, pollMs: 10,
    });
    if (!hostFaultContext) throw new Error('whole-host fault did not create one exact offscreen host');
    const hostFaultHost = await waitFor(
      () => exactControllerHost(ctx.page).catch(() => null),
      { budgetMs: 15_000, pollMs: 10 },
    );
    if (!hostFaultHost) throw new Error('whole-host fault did not acquire one exact controller lease');
    const hostFaultRequest = await waitFor(() => fixture.completionCalls() === 2, {
      budgetMs: 15_000, pollMs: 10,
    });
    if (!hostFaultRequest) throw new Error('whole-host fault never reached the model request');
    const hostPhysicalFault = await closeOffscreenHost(
      serviceWorkerConnection, ctx.page, hostFaultContext,
    );
    const hostFaultTerminal = await waitFor(() => terminalState(ctx.page, HOST_FAULT_TEXT), {
      budgetMs: CONTROLLER_FAULT_BUDGETS.lossMs, pollMs: 25,
    });
    if (!hostFaultTerminal) throw new Error('whole-host loss left the UI busy beyond its budget');
    const hostFaultAudit = await auditDelta(ctx.page, hostFaultAuditIds);
    const hostFaultOpenedTabIds = (await tabIds(ctx.page)).filter((id) => !hostFaultTabIds.has(id));
    const hostFaultLifecycle = await durableTurn(ctx.page, sessionId, HOST_FAULT_TEXT);

    const hostRetryAuditIds = new Set((await auditEntries(ctx.page)).map((entry) => entry.id));
    const hostRetryTabIds = new Set(await tabIds(ctx.page));
    await sendTurn(ctx.page, HOST_RETRY_TEXT);
    const hostRecoveryContext = await waitFor(async () => {
      const candidate = await exactOffscreenContext(ctx.page).catch(() => null);
      return candidate && candidate.contextId !== hostFaultContext.contextId ? candidate : null;
    }, { budgetMs: 15_000, pollMs: 10 });
    if (!hostRecoveryContext) throw new Error('whole-host retry did not create a fresh offscreen host');
    const hostRecoveryHost = await waitFor(
      () => exactControllerHost(ctx.page).catch(() => null),
      { budgetMs: 15_000, pollMs: 10 },
    );
    if (!hostRecoveryHost) throw new Error('whole-host retry did not acquire a fresh controller lease');
    const hostRetryTerminal = await waitFor(
      () => terminalState(ctx.page, HOST_RETRY_TEXT, HOST_RETRY_REPLY),
      { budgetMs: CONTROLLER_FAULT_BUDGETS.retryMs, pollMs: 25 },
    );
    if (!hostRetryTerminal) throw new Error('whole-host retry did not finish its tool-bearing turn');
    const hostRetryAudit = await auditDelta(ctx.page, hostRetryAuditIds);
    const hostRetryOpenedTabIds = (await tabIds(ctx.page)).filter((id) => !hostRetryTabIds.has(id));
    const hostRetryLifecycle = await durableTurn(ctx.page, sessionId, HOST_RETRY_TEXT);

    const postEffectAuditIds = new Set((await auditEntries(ctx.page)).map((entry) => entry.id));
    const postEffectTabIds = new Set(await tabIds(ctx.page));
    await sendTurn(ctx.page, POST_EFFECT_FAULT_TEXT);
    const postEffectContext = await waitFor(
      () => exactOffscreenContext(ctx.page).catch(() => null),
      { budgetMs: 15_000, pollMs: 10 },
    );
    if (!postEffectContext) throw new Error('post-effect fault did not create one exact offscreen host');
    const postEffectHost = await waitFor(
      () => exactControllerHost(ctx.page).catch(() => null),
      { budgetMs: 15_000, pollMs: 10 },
    );
    if (!postEffectHost) throw new Error('post-effect fault did not acquire one exact controller lease');
    const postEffectDispatched = await waitFor(async () => {
      if (fixture.completionCalls() !== 6) return null;
      const audit = await auditDelta(ctx.page, postEffectAuditIds);
      const opened = (await tabIds(ctx.page)).filter((id) => !postEffectTabIds.has(id));
      return audit.toolEffects === 1 && audit.openTabEffects === 1 && opened.length === 1
        ? { audit, opened } : null;
    }, { budgetMs: 15_000, pollMs: 10 });
    if (!postEffectDispatched) {
      throw new Error('post-effect fault did not reach exactly one performed open_tab');
    }
    const postEffectPhysicalFault = await closeOffscreenHost(
      serviceWorkerConnection, ctx.page, postEffectContext,
    );
    const postEffectTerminal = await waitFor(
      () => terminalState(ctx.page, POST_EFFECT_FAULT_TEXT),
      { budgetMs: CONTROLLER_FAULT_BUDGETS.lossMs, pollMs: 25 },
    );
    if (!postEffectTerminal) throw new Error('post-effect host loss left the UI busy');
    const postEffectAudit = await auditDelta(ctx.page, postEffectAuditIds);
    const postEffectOpenedTabIds = (await tabIds(ctx.page))
      .filter((id) => !postEffectTabIds.has(id));
    const postEffectLifecycle = await durableTurn(
      ctx.page, sessionId, POST_EFFECT_FAULT_TEXT,
    );

    const postEffectWakeAuditIds = new Set((await auditEntries(ctx.page))
      .map((entry) => entry.id));
    const postEffectWakeTabIds = new Set(await tabIds(ctx.page));
    await sendTurn(ctx.page, POST_EFFECT_WAKE_TEXT);
    const postEffectWakeContext = await waitFor(async () => {
      const candidate = await exactOffscreenContext(ctx.page).catch(() => null);
      return candidate && candidate.contextId !== postEffectContext.contextId ? candidate : null;
    }, { budgetMs: 15_000, pollMs: 10 });
    if (!postEffectWakeContext) throw new Error('post-effect wake did not create a fresh host');
    const postEffectWakeHost = await waitFor(
      () => exactControllerHost(ctx.page).catch(() => null),
      { budgetMs: 15_000, pollMs: 10 },
    );
    if (!postEffectWakeHost) throw new Error('post-effect wake did not acquire a fresh lease');
    const postEffectWakeTerminal = await waitFor(
      () => terminalState(ctx.page, POST_EFFECT_WAKE_TEXT, POST_EFFECT_WAKE_REPLY),
      { budgetMs: CONTROLLER_FAULT_BUDGETS.retryMs, pollMs: 25 },
    );
    if (!postEffectWakeTerminal) throw new Error('post-effect wake did not settle');
    const postEffectWakeAudit = await auditDelta(ctx.page, postEffectWakeAuditIds);
    const postEffectWakeOpenedTabIds = (await tabIds(ctx.page))
      .filter((id) => !postEffectWakeTabIds.has(id));
    const postEffectWakeLifecycle = await durableTurn(
      ctx.page, sessionId, POST_EFFECT_WAKE_TEXT,
    );
    const postEffectFaultLifecycleAfterWake = await durableTurn(
      ctx.page, sessionId, POST_EFFECT_FAULT_TEXT, postEffectLifecycle.assistant.id,
    );

    const postRun = {
      artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
      tree: await digestTree(treePath),
    };
    const report = {
      schema: 3,
      ok: true,
      bindings,
      postRun,
      budgets: CONTROLLER_FAULT_BUDGETS,
      observations: {
        baseline: { modelCalls: 1, terminal: baseline, lifecycle: baselineLifecycle },
        wholeHostLoss: {
          fault: {
            context: hostFaultContext,
            host: hostFaultHost,
            physicalFault: hostPhysicalFault,
            modelCalls: 1,
            audit: hostFaultAudit,
            openedTabIds: hostFaultOpenedTabIds,
            terminal: hostFaultTerminal,
            lifecycle: hostFaultLifecycle,
          },
          recovery: {
            context: hostRecoveryContext,
            host: hostRecoveryHost,
            modelCalls: 2,
            audit: hostRetryAudit,
            openedTabIds: hostRetryOpenedTabIds,
            terminal: hostRetryTerminal,
            lifecycle: hostRetryLifecycle,
          },
        },
        postEffectHostLoss: {
          fault: {
            context: postEffectContext,
            host: postEffectHost,
            physicalFault: postEffectPhysicalFault,
            modelCalls: 2,
            audit: postEffectAudit,
            openedTabIds: postEffectOpenedTabIds,
            terminal: postEffectTerminal,
            lifecycle: postEffectLifecycle,
          },
          wake: {
            context: postEffectWakeContext,
            host: postEffectWakeHost,
            modelCalls: 1,
            audit: postEffectWakeAudit,
            openedTabIds: postEffectWakeOpenedTabIds,
            terminal: postEffectWakeTerminal,
            lifecycle: postEffectWakeLifecycle,
            faultLifecycleAfterWake: postEffectFaultLifecycleAfterWake,
          },
        },
        totalCompletionCalls: fixture.completionCalls(),
      },
    };
    assertControllerFaultReport(report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    try { serviceWorkerConnection?.close(); } catch {}
    await ctx?.close().catch(() => {});
    await fixture?.close().catch(() => {});
  }
}

if (import.meta.main) {
  const reportPath = process.env.PEERD_ACCEPTANCE_REPORT_PATH
    ? resolve(process.env.PEERD_ACCEPTANCE_REPORT_PATH) : CONTROLLER_FAULT_REPORT;
  runControllerFaultEvidence({
    ...(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT
      ? { sourceRoot: resolve(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT) } : {}),
    ...(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
      ? { artifactRoot: resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT) } : {}),
    reportPath,
  }).then((report) => console.log(JSON.stringify(report, null, 2))).catch((cause) => {
    const failurePath = join(dirname(reportPath), 'controller-fault-evidence-failure.json');
    mkdirSync(dirname(failurePath), { recursive: true });
    writeFileSync(failurePath, `${JSON.stringify({
      schema: 3, ok: false, at: new Date().toISOString(),
      error: cause?.stack ?? String(cause),
    }, null, 2)}\n`);
    console.error(cause?.stack ?? String(cause));
    console.error(`[controller-fault] failure evidence: ${failurePath}`);
    process.exit(1);
  });
}
