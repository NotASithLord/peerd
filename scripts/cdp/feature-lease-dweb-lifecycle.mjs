#!/usr/bin/env bun
// Packaged Preview-Chrome dweb feature-lease continuity oracle.
//
// This is intentionally not the raw-source two-peer harness. It loads the
// exact staged Preview tree, proves a usable unlocked UI, then physically
// stops the installed MV3 worker while the offscreen dweb host owns a room and
// served App bytes. A successful result requires the successor kernel to adopt
// the same host realm without losing either state, and requires both the dweb
// setting and vault lock to tear the host down completely.

import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { FEATURE_LEASE_HOST_PROTOCOL } from '../../extension/shared/feature-lease-protocol.js';
import {
  digestTree, PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY, readChromeIdentity, readUi, sha256File,
} from './passkey-signup-lane.mjs';
import {
  kernelIdentityFromReply, runPackagedAppGitProbe, verifyPackagedAcceptanceAppPayload,
} from './product-acceptance-probes.mjs';
import {
  assertLiveKernelAssembly,
} from '../acceptance/live-kernel-assembly.mjs';
import {
  evalIn, hostMonotonicMs, launchPeerd, rpc, unlockAndReady, waitFor,
} from './e2e-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const CHROME_PIN = join(HERE, 'chrome-version.txt');
export const FEATURE_LEASE_DWEB_REPORT = join(
  ARTIFACTS_DIR, 'e2e', 'feature-lease-dweb-lifecycle.json',
);
export const FEATURE_LEASE_DWEB_BUDGETS = Object.freeze({
  startupMs: 180_000,
  dwebMs: 60_000,
  recycleMs: 60_000,
  rendererMs: 60_000,
  teardownMs: 20_000,
});

const assert = (condition, message) => {
  if (!condition) throw new Error(`feature-lease dweb report: ${message}`);
};
const isHex256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sourceVersion = (root) => String(readJson(join(root, 'package.json')).version);

const digestHarness = async (sourceRoot) => {
  const graph = [...await collectStaticModuleGraph(sourceRoot, ENTRY)].sort();
  const files = [...new Set([
    ...graph,
    join(sourceRoot, 'package.json'),
    join(sourceRoot, 'bun.lock'),
    CHROME_PIN,
  ])].sort();
  const entries = await Promise.all(files.map(async (path) => ({
    path: relative(sourceRoot, path).split('\\').join('/'),
    sha256: await sha256File(path),
  })));
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(`${entry.path}\0${entry.sha256}\0`);
  // TypeScript packaging imports are executed by Bun but are not traversed by
  // the browser ESM lexer. Bind the complete packaging toolchain tree rather
  // than maintaining a list that can silently miss a new helper.
  const packaging = await digestTree(join(sourceRoot, 'packaging'));
  hash.update(`packaging\0${packaging.sha256}\0${packaging.files}\0${packaging.bytes}\0`);
  return { sha256: hash.digest('hex'), files: entries, packaging };
};

const offscreenContexts = (page) => evalIn(page, `(async () => {
  if (typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('runtime.getContexts unavailable in pinned Chrome');
  }
  return (await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  })).map((context) => ({
    contextId: context.contextId,
    contextType: context.contextType,
    documentUrl: context.documentUrl,
  }));
})()`, true);

const hostStatus = (ctx) => {
  if (!ctx.swConn) throw new Error('service-worker CDP connection unavailable');
  return evalIn(ctx.swConn, `new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'host-status-timeout' }), 5000);
    chrome.runtime.sendMessage({
      type: 'feature-lease/host-status',
      protocol: ${FEATURE_LEASE_HOST_PROTOCOL},
    }, (reply) => {
      clearTimeout(timer);
      const error = chrome.runtime.lastError?.message;
      resolve(error ? { ok: false, error } : reply);
    });
  })`, true);
};

const exactDwebHost = async (ctx) => {
  const [contexts, status] = await Promise.all([
    offscreenContexts(ctx.page),
    hostStatus(ctx),
  ]);
  if (contexts.length !== 1
      || !String(contexts[0]?.documentUrl ?? '').endsWith('/offscreen/offscreen.html')) {
    throw new Error(`expected one exact offscreen host: ${JSON.stringify(contexts)}`);
  }
  const dweb = status?.leases?.filter((lease) => lease?.scope === 'dweb') ?? [];
  if (status?.ok !== true || status.protocol !== FEATURE_LEASE_HOST_PROTOCOL
      || typeof status.hostEpoch !== 'string' || dweb.length !== 1
      || status.leases.length !== 1 || dweb[0].orphaned === true) {
    throw new Error(`expected one exact active dweb lease: ${JSON.stringify(status)}`);
  }
  return { contexts, status, lease: dweb[0] };
};

const closeOffscreenRenderer = async (ctx) => {
  if (!ctx.swConn) throw new Error('service-worker CDP connection unavailable');
  const result = await evalIn(ctx.swConn, `(async () => {
    if (typeof chrome.offscreen?.closeDocument !== 'function') {
      return { ok: false, error: 'offscreen-close-unavailable' };
    }
    await chrome.offscreen.closeDocument();
    return { ok: true };
  })()`, true);
  if (result?.ok !== true) {
    throw new Error(`authoritative offscreen close failed: ${JSON.stringify(result)}`);
  }
  return result;
};

const waitForDweb = (page) => waitFor(async () => {
  const result = await rpc(page, { type: 'dweb/base/status' }, { timeoutMs: 10_000 });
  return result?.ok === true && result.running === true && typeof result.did === 'string'
    ? result : null;
}, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.dwebMs, pollMs: 100 });

const roomCall = (page, roomId, op, args = {}) => rpc(page, {
  type: 'dweb/base/room', roomId, op, ...args,
}, { timeoutMs: 30_000 });

const waitForAppReady = (page) => waitFor(async () => {
  const ui = await readUi(page);
  return ui.stage === 'app-ready' && ui.rootVisible && ui.appShell && !ui.gate
    && !ui.failure && !ui.spinnerTerminal ? ui : null;
}, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.startupMs, pollMs: 25 });

const readKernel = async (page) => {
  const reply = await rpc(page, { type: 'state/get' }, { timeoutMs: 10_000 });
  const identity = kernelIdentityFromReply(reply);
  if (!identity) throw new Error(`kernel identity unavailable: ${JSON.stringify(reply)}`);
  return { identity, reply };
};

const requireCompleteCutover = async (page) => {
  const reply = await rpc(page, { type: 'bootstrap/ready' }, { timeoutMs: 10_000 });
  if (reply?.ok !== true) {
    throw new Error(`Preview packaged kernel assembly is incomplete: ${JSON.stringify(reply)}`);
  }
  return assertLiveKernelAssembly(reply.assembly, 'preview-chrome');
};

const immutableInputs = (before, after) => before.artifact.sha256 === after.artifact.sha256
  && before.artifact.bytes === after.artifact.bytes
  && before.tree.sha256 === after.tree.sha256
  && before.tree.files === after.tree.files
  && before.tree.bytes === after.tree.bytes;

export const assertFeatureLeaseDwebReport = (report) => {
  assert(report?.schema === 2 && report.ok === true, 'schema/result');
  const budgetKeys = Object.keys(FEATURE_LEASE_DWEB_BUDGETS).sort();
  assert(report?.budgets && typeof report.budgets === 'object'
    && !Array.isArray(report.budgets)
    && JSON.stringify(Object.keys(report.budgets).sort()) === JSON.stringify(budgetKeys)
    && budgetKeys.every((key) => report.budgets[key] === FEATURE_LEASE_DWEB_BUDGETS[key]),
  'fixed lifecycle budgets');
  assert(report?.bindings?.channel === 'preview'
    && report?.bindings?.browser === 'chrome', 'target');
  assert(isHex256(report?.bindings?.artifact?.sha256)
    && isHex256(report?.bindings?.tree?.sha256)
    && isHex256(report?.bindings?.manifest?.sha256)
    && isHex256(report?.bindings?.harness?.sha256), 'digest bindings');
  assert(report?.bindings?.browserIdentity?.expectedVersion
    === report?.bindings?.browserIdentity?.actualVersion
    && isHex256(report?.bindings?.browserIdentity?.sha256)
    && Number.isSafeInteger(report?.bindings?.browserIdentity?.bytes)
    && report.bindings.browserIdentity.bytes > 0, 'pinned browser identity');
  assert(report?.postRun?.artifact?.sha256 === report.bindings.artifact.sha256
    && report?.postRun?.artifact?.bytes === report.bindings.artifact.bytes
    && report?.postRun?.tree?.sha256 === report.bindings.tree.sha256
    && report?.postRun?.tree?.bytes === report.bindings.tree.bytes
    && report?.postRun?.tree?.files === report.bindings.tree.files, 'post-run digest equality');
  assert(report?.bindings?.manifest?.backgroundEntry === PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY,
    'production manifest background entry');
  assertLiveKernelAssembly(report?.observations?.cutover, 'preview-chrome');
  assert(report?.observations?.ui?.before?.stage === 'app-ready'
    && report?.observations?.ui?.after?.stage === 'app-ready', 'visible app-ready');
  assert(report?.observations?.vault?.initialized === true
    && report?.observations?.vault?.locked === false, 'unlocked vault');
  const before = report?.observations?.continuity?.before;
  const after = report?.observations?.continuity?.after;
  const renderer = report?.observations?.continuity?.renderer;
  assert(before?.contexts?.length === 1 && after?.contexts?.length === 1, 'one host');
  assert(before?.hostEpoch === after?.hostEpoch, 'same host realm');
  assert(before?.kernelEpoch !== after?.kernelEpoch, 'fresh kernel generation');
  assert(before?.did === after?.did, 'stable mesh identity');
  assert(before?.dwebLeases === 1 && after?.dwebLeases === 1
    && before?.meshCount === 1 && after?.meshCount === 1, 'one dweb lease/mesh');
  assert(before?.meshGeneration === 1
    && after?.meshGeneration === before.meshGeneration, 'no second mesh start');
  assert(after?.retainedRoom === true && after?.discoveryReadable === true,
    'worker room/discovery continuity');
  assert(renderer?.contexts?.length === 1
    && renderer?.priorHostEpoch === after?.hostEpoch
    && renderer?.hostEpoch !== after?.hostEpoch
    && renderer?.kernelEpoch === after?.kernelEpoch,
  'fresh renderer host under current kernel');
  assert(renderer?.did === after?.did && renderer?.dwebLeases === 1
    && renderer?.meshCount === 1 && renderer?.meshGeneration === 1,
  'one recovered renderer mesh with stable identity');
  assert(renderer?.roomRejoined === true && renderer?.servedAppInstalled === true
    && renderer?.discoveryReadable === true,
  'renderer room/seed/discovery recovery');
  assert(report?.observations?.teardown?.disabledContexts === 0
    && report?.observations?.teardown?.lockedContexts === 0
    && report?.observations?.teardown?.vaultLocked === true, 'disable/lock teardown');
  assert(report?.observations?.worker?.newTarget === true
    && report?.observations?.worker?.newKernel === true
    && typeof report?.observations?.worker?.versionId === 'string'
    && report.observations.worker.versionId.length > 0
    && report?.observations?.worker?.stoppedRunningStatus === 'stopped',
  'physical worker replacement');
  assert(report?.observations?.inputsImmutable === true, 'immutable archive/tree');
  const timings = report?.timings;
  const ordered = [
    timings?.appReadyMs,
    timings?.dwebReadyMs,
    timings?.recycleStartedMs,
    timings?.recycleReadyMs,
    timings?.rendererCloseStartedMs,
    timings?.rendererReadyMs,
    timings?.disableStartedMs,
    timings?.disableColdMs,
    timings?.reenabledReadyMs,
    timings?.lockStartedMs,
    timings?.lockColdMs,
  ];
  assert(timings?.clock === 'host-monotonic-ms'
    && ordered.every((value) => Number.isFinite(value) && value >= 0)
    && ordered.every((value, index) => index === 0 || value >= ordered[index - 1]),
  'ordered host-monotonic milestones');
  assert(timings.appReadyMs <= report.budgets.startupMs
    && timings.dwebReadyMs - timings.appReadyMs <= report.budgets.dwebMs
    && timings.recycleReadyMs - timings.recycleStartedMs <= report.budgets.recycleMs
    && timings.rendererReadyMs - timings.rendererCloseStartedMs <= report.budgets.rendererMs
    && timings.disableColdMs - timings.disableStartedMs <= report.budgets.teardownMs
    && timings.reenabledReadyMs - timings.disableColdMs <= report.budgets.dwebMs
    && timings.lockColdMs - timings.lockStartedMs <= report.budgets.teardownMs,
  'lifecycle hang ceilings');
  return report;
};

export async function runPackagedFeatureLeaseDwebLifecycle({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  reportPath = join(artifactRoot, 'e2e', 'feature-lease-dweb-lifecycle.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  reportPath = resolve(reportPath);
  const version = sourceVersion(sourceRoot);
  const artifactPath = await packageArtifact({
    // The deep no-dweb verifier is Store-specific. Preview still requests all
    // available package verification and is independently exercised below.
    channel: 'preview', browser: 'chrome', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'preview-chrome');
  const manifestPath = join(treePath, 'manifest.json');
  const manifest = readJson(manifestPath);
  const backgroundEntry = manifest?.background?.service_worker;
  if (backgroundEntry !== PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY) {
    throw new Error(
      `production cutover mismatch: expected ${PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY}, packaged ${backgroundEntry || '(missing)'}`,
    );
  }
  const beforeInputs = {
    artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
    tree: await digestTree(treePath),
  };
  const bindings = {
    channel: 'preview',
    browser: 'chrome',
    version,
    artifact: {
      path: relative(sourceRoot, artifactPath).split('\\').join('/'),
      ...beforeInputs.artifact,
    },
    tree: {
      path: relative(sourceRoot, treePath).split('\\').join('/'),
      ...beforeInputs.tree,
    },
    manifest: {
      path: relative(sourceRoot, manifestPath).split('\\').join('/'),
      sha256: await sha256File(manifestPath),
      backgroundEntry,
    },
    browserIdentity: await readChromeIdentity(),
    harness: await digestHarness(sourceRoot),
  };

  let ctx = null;
  let importedAppId = null;
  let seededAppId = null;
  try {
    ctx = await launchPeerd({
      extensionDir: treePath,
      interceptModel: true,
      captureBootTimeline: true,
      expectedBackgroundEntry: backgroundEntry,
    });
    const sinceLaunch = () => Math.round(
      (hostMonotonicMs() - ctx.bootTimeline.launchStartedAt) * 10,
    ) / 10;
    const cutover = await requireCompleteCutover(ctx.page);
    await unlockAndReady(ctx.page);
    const uiBefore = await waitForAppReady(ctx.page);
    if (!uiBefore) throw new Error('Preview UI did not reach visible app-ready');
    const appReadyMs = sinceLaunch();
    const stateBefore = await readKernel(ctx.page);
    const vault = stateBefore.reply?.state?.vault;
    if (!vault?.initialized || vault.locked !== false) {
      throw new Error(`vault did not initialize and unlock: ${JSON.stringify(vault)}`);
    }
    const dwebBefore = await waitForDweb(ctx.page);
    if (!dwebBefore) throw new Error('dweb base did not become ready');
    if (dwebBefore.meshGeneration !== 1) {
      throw new Error(`expected first mesh generation: ${JSON.stringify(dwebBefore)}`);
    }
    const dwebReadyMs = sinceLaunch();
    const hostBefore = await exactDwebHost(ctx);

    const app = await runPackagedAppGitProbe(ctx.page, { retain: true });
    importedAppId = app.appId;
    const share = await rpc(ctx.page, {
      type: 'dweb/base/share-app', appId: importedAppId, slug: 'feature-lease-physical',
    }, { timeoutMs: 60_000 });
    if (!share?.ok || typeof share.uri !== 'string' || typeof share.dwapp_id !== 'string') {
      throw new Error(`App share/seed failed: ${JSON.stringify(share)}`);
    }

    const roomId = 'feature-lease-physical';
    const roomClientId = 'physical-room-client-0001';
    const topic = 'continuity';
    const marker = `marker:${crypto.randomUUID()}`;
    const joined = await roomCall(ctx.page, roomId, 'join', {
      name: 'lease oracle', roomClientId,
    });
    if (!joined?.ok || joined.joined !== roomId) {
      throw new Error(`room join failed: ${JSON.stringify(joined)}`);
    }
    await roomCall(ctx.page, roomId, 'retain', { topic });
    const published = await roomCall(ctx.page, roomId, 'publish', {
      topic, data: { marker }, retain: true,
    });
    if (!published?.ok) throw new Error(`retained publish failed: ${JSON.stringify(published)}`);
    const historyBefore = await roomCall(ctx.page, roomId, 'history', { topic });
    if (!historyBefore?.items?.some((item) => item?.data?.marker === marker)) {
      throw new Error(`retained room marker missing before recycle: ${JSON.stringify(historyBefore)}`);
    }
    // Repository/controller work above must have released its bounded lease.
    const settledHostBefore = await waitFor(async () => {
      try { return await exactDwebHost(ctx); } catch { return null; }
    }, { budgetMs: 10_000, pollMs: 50 });
    if (!settledHostBefore) throw new Error('bounded leases did not settle before recycle');

    const recycleStartedMs = sinceLaunch();
    const oldWorker = await ctx.stopServiceWorker();
    if (oldWorker.stoppedRunningStatus !== 'stopped') {
      throw new Error(
        `ServiceWorker version ${oldWorker.versionId || '(missing)'} did not reach exact stopped state`,
      );
    }
    const newWorker = await ctx.restartServiceWorker(oldWorker);
    const uiAfter = await waitForAppReady(ctx.page);
    if (!uiAfter) throw new Error('Preview UI did not recover after worker recycle');
    const stateAfter = await waitFor(async () => {
      try {
        const candidate = await readKernel(ctx.page);
        return candidate.identity.bootId !== stateBefore.identity.bootId
          && candidate.identity.kernelEpoch !== stateBefore.identity.kernelEpoch
          ? candidate : null;
      } catch { return null; }
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.recycleMs, pollMs: 50 });
    if (!stateAfter) throw new Error('successor kernel generation was not observed');
    const dwebAfter = await waitForDweb(ctx.page);
    if (!dwebAfter) throw new Error('dweb base did not survive worker recycle');
    const recycleReadyMs = sinceLaunch();
    const hostAfter = await exactDwebHost(ctx);
    if (hostAfter.status.hostEpoch !== hostBefore.status.hostEpoch) {
      throw new Error('successor created a second offscreen realm instead of adopting');
    }
    if (hostAfter.lease.kernelEpoch === hostBefore.lease.kernelEpoch) {
      throw new Error('dweb lease retained the stale kernel generation');
    }
    if (dwebAfter.did !== dwebBefore.did) throw new Error('dweb identity changed across recycle');
    if (dwebAfter.meshGeneration !== dwebBefore.meshGeneration) {
      throw new Error('dweb mesh restarted instead of surviving kernel adoption');
    }

    const historyAfter = await roomCall(ctx.page, roomId, 'history', { topic });
    const retainedRoom = historyAfter?.items?.some((item) => item?.data?.marker === marker) === true;
    if (!retainedRoom) {
      throw new Error(`retained room state was lost across recycle: ${JSON.stringify(historyAfter)}`);
    }
    const discovered = await rpc(ctx.page, {
      type: 'dweb/base/find', dwappId: share.dwapp_id, publisherDid: share.publisher,
    }, { timeoutMs: 30_000 });
    const discoveryReadable = discovered?.ok === true && discovered.record != null;
    if (!discoveryReadable) {
      throw new Error(`shared App discovery state was lost: ${JSON.stringify(discovered)}`);
    }
    // Close the actual renderer-owned offscreen document without retiring the
    // service worker. Its authenticated Port disconnect must retire the exact
    // old host generation, create one fresh host, restart one mesh, and restore
    // the room/publication surfaces under the current kernel.
    const rendererCloseStartedMs = sinceLaunch();
    await closeOffscreenRenderer(ctx);
    const rendererHost = await waitFor(async () => {
      try {
        const candidate = await exactDwebHost(ctx);
        return candidate.status.hostEpoch !== hostAfter.status.hostEpoch ? candidate : null;
      } catch { return null; }
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.rendererMs, pollMs: 50 });
    if (!rendererHost) throw new Error('fresh dweb host was not observed after renderer close');
    const rendererDweb = await waitForDweb(ctx.page);
    if (!rendererDweb || rendererDweb.did !== dwebAfter.did
        || rendererDweb.meshGeneration !== 1) {
      throw new Error(`renderer recovery changed identity or mesh count: ${JSON.stringify(rendererDweb)}`);
    }
    const rendererReadyMs = sinceLaunch();
    const rendererMarker = `renderer:${crypto.randomUUID()}`;
    const rendererJoin = await roomCall(ctx.page, roomId, 'join', {
      name: 'lease oracle', roomClientId,
      expectedHostEpoch: rendererHost.status.hostEpoch,
    });
    const rendererPublish = await roomCall(ctx.page, roomId, 'publish', {
      topic, data: { marker: rendererMarker }, retain: true,
      roomClientId, expectedHostEpoch: rendererHost.status.hostEpoch,
    });
    const rendererHistory = await roomCall(ctx.page, roomId, 'history', {
      topic, roomClientId, expectedHostEpoch: rendererHost.status.hostEpoch,
    });
    const roomRejoined = rendererJoin?.ok === true && rendererPublish?.ok === true
      && rendererHistory?.items?.some((item) => item?.data?.marker === rendererMarker) === true;
    if (!roomRejoined) {
      throw new Error(`room did not recover on replacement renderer: ${JSON.stringify({
        rendererJoin, rendererPublish, rendererHistory,
      })}`);
    }
    const rendererDiscovery = await waitFor(async () => {
      const result = await rpc(ctx.page, {
        type: 'dweb/base/find', dwappId: share.dwapp_id, publisherDid: share.publisher,
      }, { timeoutMs: 10_000 });
      return result?.ok === true && result.record != null ? result : null;
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.dwebMs, pollMs: 100 });
    const rendererDiscoveryReadable = rendererDiscovery != null;
    if (!rendererDiscoveryReadable) throw new Error('shared App was not re-seeded after renderer replacement');

    const installed = await roomCall(ctx.page, roomId, 'install-app', {
      uri: share.uri, name: 'Feature Lease Seed Probe',
      roomClientId, expectedHostEpoch: rendererHost.status.hostEpoch,
    });
    seededAppId = installed?.appId ?? null;
    const installedPayload = installed?.ok === true && typeof seededAppId === 'string'
      ? await verifyPackagedAcceptanceAppPayload(ctx.page, seededAppId)
      : null;
    const servedAppInstalled = installedPayload?.ok === true;
    if (!servedAppInstalled) {
      throw new Error(`served App bytes were lost across recycle: ${JSON.stringify(installed)}`);
    }

    await roomCall(ctx.page, roomId, 'leave', {
      roomClientId, expectedHostEpoch: rendererHost.status.hostEpoch,
    }).catch(() => null);
    await rpc(ctx.page, { type: 'apps/delete', appId: seededAppId }, { timeoutMs: 30_000 });
    seededAppId = null;
    await rpc(ctx.page, { type: 'apps/delete', appId: importedAppId }, { timeoutMs: 30_000 });
    importedAppId = null;

    const disableStartedMs = sinceLaunch();
    const disabled = await rpc(ctx.page, {
      type: 'settings/update', patch: { dwebEnabled: false },
    }, { timeoutMs: 30_000 });
    if (!disabled?.ok) throw new Error(`dweb disable failed: ${JSON.stringify(disabled)}`);
    const disabledCold = await waitFor(async () => {
      const contexts = await offscreenContexts(ctx.page);
      return contexts.length === 0 ? contexts : null;
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.teardownMs, pollMs: 50 });
    if (!disabledCold) throw new Error('dweb disable left an offscreen context alive');
    const disableColdMs = sinceLaunch();

    const enabled = await rpc(ctx.page, {
      type: 'settings/update', patch: { dwebEnabled: true },
    }, { timeoutMs: 30_000 });
    if (!enabled?.ok || !await waitForDweb(ctx.page)) {
      throw new Error(`dweb re-enable failed: ${JSON.stringify(enabled)}`);
    }
    await exactDwebHost(ctx);
    const reenabledReadyMs = sinceLaunch();
    const lockStartedMs = sinceLaunch();
    const locked = await rpc(ctx.page, { type: 'vault/lock' }, { timeoutMs: 30_000 });
    if (!locked?.ok) throw new Error(`vault lock failed: ${JSON.stringify(locked)}`);
    const lockedCold = await waitFor(async () => {
      const contexts = await offscreenContexts(ctx.page);
      return contexts.length === 0 ? contexts : null;
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.teardownMs, pollMs: 50 });
    if (!lockedCold) throw new Error('vault lock left an offscreen context alive');
    const lockedState = await waitFor(async () => {
      const reply = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 });
      return reply?.state?.vault?.locked === true ? reply.state.vault : null;
    }, { budgetMs: FEATURE_LEASE_DWEB_BUDGETS.teardownMs, pollMs: 50 });
    if (!lockedState) throw new Error('vault lock did not reach authoritative state');
    const lockColdMs = sinceLaunch();

    const afterInputs = {
      artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
      tree: await digestTree(treePath),
    };
    const report = {
      schema: 2,
      ok: true,
      bindings,
      postRun: afterInputs,
      budgets: FEATURE_LEASE_DWEB_BUDGETS,
      timings: {
        clock: 'host-monotonic-ms', appReadyMs, dwebReadyMs,
        recycleStartedMs, recycleReadyMs,
        rendererCloseStartedMs, rendererReadyMs,
        disableStartedMs, disableColdMs, reenabledReadyMs,
        lockStartedMs, lockColdMs,
      },
      observations: {
        cutover,
        ui: { before: uiBefore, after: uiAfter },
        vault: {
          initialized: vault.initialized === true,
          locked: vault.locked === true,
        },
        worker: {
          oldTargetId: oldWorker.targetId,
          newTargetId: newWorker.targetId,
          newTarget: oldWorker.targetId !== newWorker.targetId,
          versionId: oldWorker.versionId,
          stoppedRunningStatus: oldWorker.stoppedRunningStatus,
          newKernel: stateBefore.identity.bootId !== stateAfter.identity.bootId
            && stateBefore.identity.kernelEpoch !== stateAfter.identity.kernelEpoch,
        },
        continuity: {
          before: {
            contexts: hostBefore.contexts,
            hostEpoch: hostBefore.status.hostEpoch,
            kernelEpoch: hostBefore.lease.kernelEpoch,
            dwebLeases: 1,
            meshCount: dwebBefore.running === true ? 1 : 0,
            meshGeneration: dwebBefore.meshGeneration,
            did: dwebBefore.did,
          },
          after: {
            contexts: hostAfter.contexts,
            hostEpoch: hostAfter.status.hostEpoch,
            kernelEpoch: hostAfter.lease.kernelEpoch,
            dwebLeases: 1,
            meshCount: dwebAfter.running === true ? 1 : 0,
            meshGeneration: dwebAfter.meshGeneration,
            did: dwebAfter.did,
            retainedRoom,
            discoveryReadable,
          },
          renderer: {
            contexts: rendererHost.contexts,
            priorHostEpoch: hostAfter.status.hostEpoch,
            hostEpoch: rendererHost.status.hostEpoch,
            kernelEpoch: rendererHost.lease.kernelEpoch,
            dwebLeases: 1,
            meshCount: rendererDweb.running === true ? 1 : 0,
            meshGeneration: rendererDweb.meshGeneration,
            did: rendererDweb.did,
            roomRejoined,
            discoveryReadable: rendererDiscoveryReadable,
            servedAppInstalled,
          },
        },
        teardown: {
          disabledContexts: disabledCold.length,
          lockedContexts: lockedCold.length,
          vaultLocked: lockedState.locked === true,
        },
        inputsImmutable: immutableInputs(beforeInputs, afterInputs),
      },
    };
    assertFeatureLeaseDwebReport(report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    if (ctx?.page) {
      if (seededAppId) await rpc(ctx.page, { type: 'apps/delete', appId: seededAppId }).catch(() => {});
      if (importedAppId) await rpc(ctx.page, { type: 'apps/delete', appId: importedAppId }).catch(() => {});
    }
    try { ctx?.close(); } catch { /* already closed */ }
  }
}

if (import.meta.main) {
  const artifactRoot = process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
    ? resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT)
    : ARTIFACTS_DIR;
  const reportPath = process.env.PEERD_ACCEPTANCE_REPORT
    ? resolve(process.env.PEERD_ACCEPTANCE_REPORT)
    : join(artifactRoot, 'e2e', 'feature-lease-dweb-lifecycle.json');
  try {
    const report = await runPackagedFeatureLeaseDwebLifecycle({ artifactRoot, reportPath });
    console.log(JSON.stringify(report, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  }
}
