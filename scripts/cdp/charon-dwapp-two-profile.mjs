#!/usr/bin/env bun
// Exact packaged Preview-Chrome Charon acceptance oracle.
//
// Two independent installed-extension profiles import the pinned Charon
// envelope through the user-facing .peerd file input, attach its required App
// actor, exercise private-invite and Quick Match lobby semantics over the real
// base mesh, survive both MV3 worker and offscreen-renderer replacement, and
// enter one receipt-gated co-op simulation. The report binds every executable
// input and contains no private invite secret.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { openEnvelope } from '../../extension/peerd-engine/export.js';
import {
  digestTree, PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY, readChromeIdentity, sha256File,
} from './passkey-signup-lane.mjs';
import {
  kernelIdentityFromReply, readActiveFeatureLease,
} from './product-acceptance-probes.mjs';
import { assertLiveKernelAssembly } from '../acceptance/live-kernel-assembly.mjs';
import {
  attach, evalIn, hostMonotonicMs, launchPeerd, openExtPage, rpc, sleep,
  unlockAndReady, waitFor,
} from './e2e-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const PIN_PATH = join(HERE, 'charon-source.json');
const CHROME_PIN = join(HERE, 'chrome-version.txt');
const HEX_256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;

export const CHARON_DWAPP_REPORT = join(
  ARTIFACTS_DIR, 'e2e', 'charon-dwapp-two-profile.json',
);
export const CHARON_DWAPP_BUDGETS = Object.freeze({
  startupMs: 360_000,
  importMs: 120_000,
  networkMs: 90_000,
  lobbyMs: 45_000,
  recycleMs: 60_000,
  launchMs: 90_000,
});

const assert = (condition, message) => {
  if (!condition) throw new Error(`Charon packaged report: ${message}`);
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const slash = (path) => path.split('\\').join('/');
const roundMs = (value) => Math.round(Number(value) * 10) / 10;
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256Text = (value) => sha256Bytes(Buffer.from(String(value)));
const exactKeys = (actual, expected) => actual && typeof actual === 'object'
  && !Array.isArray(actual)
  && JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(Object.keys(expected).sort())
  && Object.entries(expected).every(([key, value]) => actual[key] === value);

const listFiles = (root, current = root, out = []) => {
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) listFiles(root, absolute, out);
    else if (entry.isFile()) out.push(absolute);
    else throw new Error(`Charon source contains unsupported entry: ${slash(relative(root, absolute))}`);
  }
  return out;
};

const digestPayloadEntries = (entries) => {
  const canonical = entries
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.path}\0${entry.kind}\0${entry.bytes}\0${entry.sha256}\0`)
    .join('');
  return sha256Text(canonical);
};

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const digestHarness = async (sourceRoot) => {
  const graph = [...await collectStaticModuleGraph(sourceRoot, ENTRY)].sort();
  const files = [...new Set([
    ...graph,
    PIN_PATH,
    CHROME_PIN,
    join(sourceRoot, 'package.json'),
    join(sourceRoot, 'bun.lock'),
  ])].sort();
  const hash = createHash('sha256');
  const inputs = [];
  for (const path of files) {
    const bytes = readFileSync(path);
    const item = { path: slash(relative(sourceRoot, path)), bytes: bytes.length, sha256: sha256Bytes(bytes) };
    inputs.push(item);
    hash.update(`${item.path}\0${item.bytes}\0${item.sha256}\0`);
  }
  const packaging = await digestTree(join(sourceRoot, 'packaging'));
  hash.update(`packaging\0${packaging.sha256}\0${packaging.files}\0${packaging.bytes}\0`);
  return { sha256: hash.digest('hex'), files: inputs, packaging };
};

export const inspectPinnedCharonSource = async (charonRoot) => {
  const pin = readJson(PIN_PATH);
  assert(pin?.schema === 1 && GIT_COMMIT.test(pin.commit), 'invalid Charon source pin');
  charonRoot = resolve(charonRoot ?? '');
  if (!charonRoot || !existsSync(join(charonRoot, '.git'))) {
    throw new Error('CHARON_ROOT must name a full checkout of the pinned Charon repository');
  }
  const commit = git(charonRoot, ['rev-parse', 'HEAD']);
  if (commit !== pin.commit) {
    throw new Error(`Charon commit mismatch: expected ${pin.commit}, got ${commit}`);
  }
  const dirty = git(charonRoot, ['status', '--porcelain']);
  if (dirty) throw new Error(`Charon checkout is dirty:\n${dirty}`);

  const sourceRoot = resolve(charonRoot, pin.sourceDirectory);
  const envelopePath = resolve(charonRoot, pin.envelope);
  const bundlePath = resolve(charonRoot, pin.bundle);
  const manifestPath = resolve(charonRoot, pin.manifest);
  for (const path of [sourceRoot, envelopePath, bundlePath, manifestPath]) {
    if (!existsSync(path)) throw new Error(`Pinned Charon input is missing: ${path}`);
  }

  const envelope = readJson(envelopePath);
  const opened = await openEnvelope(envelope);
  const sourceFiles = listFiles(sourceRoot);
  const sourcePaths = sourceFiles.map((path) => slash(relative(sourceRoot, path))).sort();
  const openedPaths = Object.keys(opened.files ?? {}).sort();
  if (JSON.stringify(sourcePaths) !== JSON.stringify(openedPaths)) {
    throw new Error('Charon envelope file list differs from its pinned readable source tree');
  }
  const payloadEntries = [];
  for (const path of sourcePaths) {
    const source = readFileSync(join(sourceRoot, path));
    const packed = opened.files[path];
    if (!(packed instanceof Uint8Array) || !Buffer.from(packed).equals(source)) {
      throw new Error(`Charon envelope bytes differ from source: ${path}`);
    }
    payloadEntries.push({
      path,
      kind: opened.fileKinds?.[path] ?? 'text',
      bytes: source.length,
      sha256: sha256Bytes(source),
    });
  }
  const manifest = readJson(manifestPath);
  if (opened.entry !== manifest.entry
      || manifest.kind !== 'dwapp'
      || manifest.agent?.kind !== 'bound-app'
      || manifest.agent?.profile !== 'developer'
      || manifest.agent?.surface !== 'code'
      || JSON.stringify(manifest.agent?.runtime) !== JSON.stringify(['observe', 'act'])
      || JSON.stringify(manifest.capabilities) !== JSON.stringify(['dweb'])) {
    throw new Error('Pinned Charon peerd.json does not declare the exact code-first dweb actor contract');
  }
  return {
    root: charonRoot,
    pin,
    envelopePath,
    sourceRoot,
    binding: {
      repository: pin.repository,
      commit,
      envelope: { path: pin.envelope, bytes: statSync(envelopePath).size, sha256: await sha256File(envelopePath) },
      source: { path: pin.sourceDirectory, ...await digestTree(sourceRoot) },
      bundle: { path: pin.bundle, bytes: statSync(bundlePath).size, sha256: await sha256File(bundlePath) },
      peerdJson: { path: pin.manifest, bytes: statSync(manifestPath).size, sha256: await sha256File(manifestPath) },
      payload: {
        sha256: digestPayloadEntries(payloadEntries),
        files: payloadEntries.length,
        bytes: payloadEntries.reduce((sum, item) => sum + item.bytes, 0),
      },
      agent: {
        kind: manifest.agent.kind,
        profile: manifest.agent.profile,
        surface: manifest.agent.surface,
        name: manifest.agent.name,
        runtime: [...manifest.agent.runtime],
      },
      capabilities: [...manifest.capabilities],
    },
  };
};

const browserDigestImportedApp = async (appId) => {
  const extensionApi = globalThis.chrome ?? globalThis.browser;
  const exported = await extensionApi.runtime.sendMessage({ type: 'export/artifact', kind: 'app', id: appId });
  if (exported?.ok !== true || !exported.envelope) return { ok: false, error: 'export-failed' };
  const { openEnvelope: open } = await import('/peerd-engine/index.js');
  const unpacked = await open(exported.envelope);
  const entries = [];
  for (const path of Object.keys(unpacked.files ?? {}).sort()) {
    const bytes = unpacked.files[path];
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    entries.push({
      path,
      kind: unpacked.fileKinds?.[path] ?? 'text',
      bytes: bytes.byteLength,
      sha256: [...digest].map((value) => value.toString(16).padStart(2, '0')).join(''),
    });
  }
  const canonical = entries
    .map((entry) => `${entry.path}\0${entry.kind}\0${entry.bytes}\0${entry.sha256}\0`)
    .join('');
  const payloadDigest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(canonical),
  ));
  const digestOf = async (path) => {
    const bytes = unpacked.files?.[path];
    if (!(bytes instanceof Uint8Array)) return null;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  };
  return {
    ok: true,
    entry: unpacked.entry,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: [...payloadDigest].map((value) => value.toString(16).padStart(2, '0')).join(''),
    bundleSha256: await digestOf('bundle.js'),
    peerdJsonSha256: await digestOf('peerd.json'),
  };
};

const verifyImportedPayload = async (page, appId, charon) => {
  const result = await evalIn(page,
    `(${browserDigestImportedApp.toString()})(${JSON.stringify(appId)})`, true);
  if (result?.ok !== true
      || result.entry !== 'index.html'
      || result.sha256 !== charon.payload.sha256
      || result.files !== charon.payload.files
      || result.bytes !== charon.payload.bytes
      || result.bundleSha256 !== charon.bundle.sha256
      || result.peerdJsonSha256 !== charon.peerdJson.sha256) {
    throw new Error(`imported Charon payload mismatch: ${JSON.stringify(result)}`);
  }
  return result;
};

const importCharonThroughFileUi = async (ctx, envelopePath, charon) => {
  const before = await rpc(ctx.page, { type: 'apps/list' }, { timeoutMs: 10_000 });
  if (before?.ok !== true) throw new Error(`apps/list before import failed: ${JSON.stringify(before)}`);
  const previous = new Set((before.apps ?? []).map((app) => app.id));
  const options = await openExtPage(ctx, 'options/options.html#!/transfer');
  try {
    const ready = await waitFor(() => evalIn(options,
      `document.readyState === 'complete' && !!document.querySelector('#peerd-artifact-file')`),
    { budgetMs: 30_000, pollMs: 25 });
    if (!ready) throw new Error('artifact import file input did not mount');
    await options.send('DOM.enable');
    const document = await options.send('DOM.getDocument', { depth: -1, pierce: true });
    const selected = await options.send('DOM.querySelector', {
      nodeId: document.root.nodeId, selector: '#peerd-artifact-file',
    });
    if (!selected?.nodeId) throw new Error('artifact import file input has no DOM node');
    await options.send('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [envelopePath] });
    await evalIn(options, `document.querySelector('#peerd-artifact-file')
      ?.dispatchEvent(new Event('change', { bubbles: true }))`);
    const inspected = await waitFor(() => evalIn(options, `(() => {
      const summary = document.querySelector('.import-summary');
      const error = document.querySelector('.transfer-status--error');
      return error ? { error: error.textContent } : summary ? { ready: true, text: summary.textContent } : null;
    })()`), { budgetMs: CHARON_DWAPP_BUDGETS.importMs, pollMs: 100 });
    if (!inspected?.ready || !String(inspected.text).includes('Kind: App')) {
      throw new Error(`Charon import inspection failed: ${JSON.stringify(inspected)}`);
    }
    await evalIn(options, `(() => {
      const button = [...document.querySelectorAll('.import-summary button')]
        .find((node) => node.textContent?.trim() === 'Apply import');
      if (!button || button.disabled) throw new Error('Apply import unavailable');
      button.click();
    })()`);
    const app = await waitFor(async () => {
      const listed = await rpc(ctx.page, { type: 'apps/list' }, { timeoutMs: 10_000 });
      if (listed?.ok !== true) return null;
      const added = (listed.apps ?? []).filter((candidate) => !previous.has(candidate.id));
      return added.length === 1 ? added[0] : null;
    }, { budgetMs: CHARON_DWAPP_BUDGETS.importMs, pollMs: 200 });
    if (!app) throw new Error('Charon import did not create exactly one App');
    const payload = await verifyImportedPayload(ctx.page, app.id, charon);
    return { app, payload };
  } finally {
    try { options.close(); } catch { /* already closed */ }
  }
};

const findAppTarget = (ctx, appId) => waitFor(async () => {
  const targets = await fetch(`http://127.0.0.1:${ctx.port}/json/list`).then((response) => response.json());
  const prefix = `chrome-extension://${ctx.sw.id}/engine-tabs/app-tab/index.html#${appId}`;
  return targets.find((target) => target.type === 'page' && String(target.url).startsWith(prefix)) ?? null;
}, { budgetMs: 30_000, pollMs: 50 });

const openCharonApp = async (ctx, appId, expectedAgent) => {
  const opened = await rpc(ctx.page, { type: 'apps/open', appId }, { timeoutMs: 30_000 });
  if (opened?.ok !== true) throw new Error(`apps/open failed: ${JSON.stringify(opened)}`);
  const target = await findAppTarget(ctx, appId);
  if (!target) throw new Error('Charon App tab target was not created');
  const page = await attach(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.bringToFront');
  const attached = await waitFor(() => evalIn(page, `(() => {
    const boot = document.querySelector('#boot');
    const frame = document.querySelector('#app-frame');
    return boot?.classList.contains('is-failed')
      ? { failed: true, text: boot.textContent }
      : boot?.classList.contains('is-hidden') && frame?.contentWindow
        ? { ready: true, owner: new URLSearchParams(location.hash.split('?')[1] || '').get('owner'), actor: document.querySelector('#actor-chat-name')?.textContent }
        : null;
  })()`), { budgetMs: CHARON_DWAPP_BUDGETS.startupMs, pollMs: 100 });
  if (!attached?.ready || typeof attached.owner !== 'string' || attached.owner.length < 8
      || attached.actor !== expectedAgent.name) {
    throw new Error(`required Charon actor did not attach: ${JSON.stringify(attached)}`);
  }
  const meta = await evalIn(page, `chrome.runtime.sendMessage({
    type: 'app/get-meta', appId: ${JSON.stringify(appId)}
  })`, true);
  if (meta?.ok !== true
      || meta.agent?.kind !== expectedAgent.kind
      || meta.agent?.profile !== expectedAgent.profile
      || meta.agent?.surface !== expectedAgent.surface
      || meta.agent?.name !== expectedAgent.name
      || JSON.stringify(meta.agent?.runtime) !== JSON.stringify(expectedAgent.runtime)
      || !meta.dweb) {
    throw new Error(`Charon runtime manifest/actor mismatch: ${JSON.stringify(meta)}`);
  }
  return { page, ownerClaim: attached.owner, meta };
};

const appAgentCall = async (page, op, args = {}) => {
  const result = await evalIn(page, `(() => new Promise((resolve) => {
    const frame = document.querySelector('#app-frame');
    const id = 'charon-acceptance-' + crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      resolve({ ok: false, error: 'acceptance-agent-call-timeout' });
    }, 15000);
    const onMessage = (event) => {
      if (event.source !== frame?.contentWindow
          || event.data?.peerd !== 'app:agent:result'
          || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    window.addEventListener('message', onMessage);
    frame?.contentWindow?.postMessage({
      peerd: 'app:agent:request', id,
      op: ${JSON.stringify(op)}, args: ${JSON.stringify(args)},
    }, '*');
  }))()` , true);
  if (result?.ok !== true) throw new Error(`Charon app.${op} failed: ${JSON.stringify(result)}`);
  return result.value;
};

const observe = (app) => appAgentCall(app.page, 'observe');
const act = (app, action, params = {}) => appAgentCall(app.page, 'act', { action, params });

const approveJoin = async (app, required = true) => {
  const approved = await waitFor(() => evalIn(app.page, `(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const button = dialog && [...dialog.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === 'Join room');
    if (!button) return null;
    button.click();
    return true;
  })()`), { budgetMs: required ? 15_000 : 500, pollMs: 25 });
  if (required && approved !== true) throw new Error('Charon room consent did not appear');
  return approved === true;
};

const waitForLobby = (app, predicate) => waitFor(async () => {
  try {
    const state = await observe(app);
    return state?.screen === 'lobby' && state.joinOperation?.state === 'complete'
      && predicate(state.lobby, state) ? state : null;
  } catch { return null; }
}, { budgetMs: CHARON_DWAPP_BUDGETS.lobbyMs, pollMs: 100 });

const joinLobby = async (app, action, params = {}) => {
  const started = await act(app, action, params);
  if (started?.joinOperation?.state !== 'pending') {
    throw new Error(`Charon ${action} did not expose pending join: ${JSON.stringify(started)}`);
  }
  await approveJoin(app, true);
  const joined = await waitForLobby(app, (lobby) => Boolean(lobby?.lobbyId));
  if (!joined) throw new Error(`Charon ${action} did not complete`);
  return joined;
};

const readRunnerValue = async (app, expression) => {
  const tree = await app.page.send('Page.getFrameTree');
  const frames = [];
  const visit = (node) => {
    frames.push(node.frame);
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(tree.frameTree);
  const child = frames.find((frame) => frame.parentId && String(frame.url).includes('/engine-tabs/app-tab/runner.html'));
  if (!child) throw new Error('Charon runner frame not found');
  const world = await app.page.send('Page.createIsolatedWorld', {
    frameId: child.id, worldName: `charon-acceptance-${crypto.randomUUID()}`,
  });
  const evaluated = await app.page.send('Runtime.evaluate', {
    contextId: world.executionContextId,
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (evaluated.exceptionDetails) throw new Error('Charon runner inspection failed');
  return evaluated.result?.value;
};

const leaveLobby = async (app) => {
  await act(app, 'leave-lobby');
  const left = await waitFor(async () => {
    try { return (await observe(app))?.lobby === null; } catch { return false; }
  }, { budgetMs: 15_000, pollMs: 50 });
  if (!left) throw new Error('Charon did not leave the lobby');
};

const readKernel = async (page) => {
  const reply = await rpc(page, { type: 'state/get' }, { timeoutMs: 10_000 });
  const identity = kernelIdentityFromReply(reply);
  if (!identity) throw new Error(`kernel identity unavailable: ${JSON.stringify(reply)}`);
  return identity;
};

const dwebStatus = (page) => rpc(page, { type: 'dweb/base/status' }, { timeoutMs: 10_000 });
const dwebInfo = (page) => rpc(page, { type: 'dweb/distributed/info' }, { timeoutMs: 10_000 });

const waitForLinkedProfiles = async (left, right) => {
  const linked = await waitFor(async () => {
    const [a, b] = await Promise.all([dwebInfo(left.page), dwebInfo(right.page)]);
    if (a?.ok !== true || b?.ok !== true || typeof a.did !== 'string' || typeof b.did !== 'string'
        || a.did === b.did) return null;
    const aHasB = a.peers?.some((peer) => peer?.did === b.did && peer?.linked !== false);
    const bHasA = b.peers?.some((peer) => peer?.did === a.did && peer?.linked !== false);
    return aHasB && bHasA ? { left: a, right: b } : null;
  }, { budgetMs: CHARON_DWAPP_BUDGETS.networkMs, pollMs: 250 });
  if (!linked) throw new Error('the two packaged Peerd profiles never formed a real base-mesh link');
  return linked;
};

const exactDwebLease = async (ctx) => {
  const [active, contexts] = await Promise.all([
    readActiveFeatureLease(ctx.page, 'dweb'),
    evalIn(ctx.swConn, `(async () => {
      if (typeof chrome.runtime?.getContexts !== 'function') return [];
      const rows = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return rows.map((row) => ({
        contextId: row.contextId,
        documentUrl: row.documentUrl,
        contextType: row.contextType,
      }));
    })()`, true),
  ]);
  if (contexts?.length !== 1
      || !String(contexts[0]?.documentUrl).split('#', 1)[0]
        .endsWith('/offscreen/offscreen.html')) {
    throw new Error(`expected one exact dweb host: ${JSON.stringify({ active, contexts })}`);
  }
  return {
    status: { ok: true, hostEpoch: active.lease.hostEpoch },
    lease: active.lease,
    contexts,
  };
};

const closeOffscreenRenderer = async (ctx) => {
  if (!ctx.swConn) throw new Error('service-worker connection unavailable');
  const result = await evalIn(ctx.swConn, `(async () => {
    if (typeof chrome.offscreen?.closeDocument !== 'function') {
      return { ok: false, error: 'offscreen-close-unavailable' };
    }
    await chrome.offscreen.closeDocument();
    return { ok: true };
  })()`, true);
  if (result?.ok !== true) throw new Error(`offscreen close failed: ${JSON.stringify(result)}`);
};

const canonicalLobby = (state) => ({
  visibility: state.lobby.visibility,
  lobbyId: state.lobby.lobbyId,
  owner: state.lobby.owner,
  self: state.lobby.self,
  isOwner: state.lobby.isOwner,
  canStart: state.lobby.canStart,
  transport: state.lobby.transport,
  members: state.lobby.members.map((member) => member.did).sort(),
});

const waitForSharedLobby = async (left, right, expectedVisibility) => {
  const shared = await waitFor(async () => {
    try {
      const [a, b] = await Promise.all([observe(left), observe(right)]);
      if (a?.screen !== 'lobby' || b?.screen !== 'lobby'
          || a.lobby?.visibility !== expectedVisibility
          || b.lobby?.visibility !== expectedVisibility
          || a.lobby?.lobbyId !== b.lobby?.lobbyId
          || a.lobby?.members?.length !== 2 || b.lobby?.members?.length !== 2) return null;
      const am = a.lobby.members.map((member) => member.did).sort();
      const bm = b.lobby.members.map((member) => member.did).sort();
      return JSON.stringify(am) === JSON.stringify(bm) ? { left: a, right: b } : null;
    } catch { return null; }
  }, { budgetMs: CHARON_DWAPP_BUDGETS.lobbyMs, pollMs: 100 });
  if (!shared) throw new Error(`profiles did not converge on one ${expectedVisibility} lobby`);
  return shared;
};

const waitForCoop = async (left, right) => {
  const deadline = hostMonotonicMs() + CHARON_DWAPP_BUDGETS.launchMs;
  while (hostMonotonicMs() < deadline) {
    await Promise.all([approveJoin(left, false), approveJoin(right, false)]);
    try {
      const [a, b] = await Promise.all([observe(left), observe(right)]);
      if (['briefing', 'game'].includes(a?.screen) && ['briefing', 'game'].includes(b?.screen)
          && a.run?.mode === 'multiplayer' && b.run?.mode === 'multiplayer') return { left: a, right: b };
    } catch { /* launcher is replacing the runtime */ }
    await sleep(100);
  }
  throw new Error('receipt-gated Charon co-op launch did not complete');
};

const snapshotInputs = async (artifactPath, treePath, charonInfo) => ({
  artifact: { bytes: statSync(artifactPath).size, sha256: await sha256File(artifactPath) },
  tree: await digestTree(treePath),
  charon: {
    envelope: { bytes: statSync(charonInfo.envelopePath).size, sha256: await sha256File(charonInfo.envelopePath) },
    source: await digestTree(charonInfo.sourceRoot),
  },
});

const immutableInputs = (before, after) => JSON.stringify(before) === JSON.stringify(after);

export const assertCharonDwappReport = (report) => {
  assert(report?.schema === 1 && report?.ok === true, 'schema/result');
  assert(exactKeys(report?.budgets, CHARON_DWAPP_BUDGETS), 'fixed budgets');
  const bindings = report?.bindings;
  assert(bindings?.channel === 'preview' && bindings?.browser === 'chrome', 'target');
  for (const digest of [
    bindings?.artifact?.sha256, bindings?.tree?.sha256, bindings?.manifest?.sha256,
    bindings?.harness?.sha256, bindings?.charon?.envelope?.sha256,
    bindings?.charon?.source?.sha256, bindings?.charon?.bundle?.sha256,
    bindings?.charon?.peerdJson?.sha256, bindings?.charon?.payload?.sha256,
  ]) assert(HEX_256.test(digest), 'digest binding');
  assert(bindings?.manifest?.backgroundEntry === PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY,
    'production background entry');
  const charonPin = readJson(PIN_PATH);
  assert(bindings?.charon?.repository === charonPin.repository
    && bindings?.charon?.commit === charonPin.commit, 'pinned Charon source');
  assert(bindings?.charon?.agent?.kind === 'bound-app'
    && bindings.charon.agent.profile === 'developer'
    && bindings.charon.agent.surface === 'code'
    && JSON.stringify(bindings.charon.agent.runtime) === JSON.stringify(['observe', 'act'])
    && JSON.stringify(bindings.charon.capabilities) === JSON.stringify(['dweb']), 'code-first actor contract');
  assert(bindings?.browserIdentity?.expectedVersion === bindings?.browserIdentity?.actualVersion
    && HEX_256.test(bindings?.browserIdentity?.sha256), 'pinned browser');
  assertLiveKernelAssembly(report?.observations?.profiles?.left?.cutover, 'preview-chrome');
  assertLiveKernelAssembly(report?.observations?.profiles?.right?.cutover, 'preview-chrome');
  assert(JSON.stringify(Object.keys(report?.observations?.profiles ?? {}).sort())
    === JSON.stringify(['left', 'right']), 'exactly two profiles');
  for (const profile of Object.values(report?.observations?.profiles ?? {})) {
    assert(profile?.vault?.initialized === true && profile.vault.locked === false, 'unlocked profile');
    assert(typeof profile?.did === 'string' && profile.did.startsWith('did:'), 'profile DID');
    assert(profile?.payload?.sha256 === bindings.charon.payload.sha256
      && profile.payload.bundleSha256 === bindings.charon.bundle.sha256
      && profile.payload.peerdJsonSha256 === bindings.charon.peerdJson.sha256
      && profile.payload.files === bindings.charon.payload.files
      && profile.payload.bytes === bindings.charon.payload.bytes, 'imported exact Charon bytes');
    assert(JSON.stringify(Object.keys(profile?.actor ?? {}).sort())
      === JSON.stringify(['attached', 'name', 'ownerClaimLength', 'ownerClaimSha256']),
    'actor report excludes the raw owner claim');
    assert(HEX_256.test(profile?.actor?.ownerClaimSha256)
      && profile.actor.ownerClaimLength >= 8
      && profile.actor.name === bindings.charon.agent.name
      && profile.actor.attached === true, 'required actor attached');
  }
  assert(report.observations.profiles.left.did !== report.observations.profiles.right.did, 'independent identities');
  assert(report.observations.profiles.left.actor.ownerClaimSha256
    !== report.observations.profiles.right.actor.ownerClaimSha256, 'independent actor owners');
  const profileMembers = [
    report.observations.profiles.left.did,
    report.observations.profiles.right.did,
  ].sort();
  const privateLobby = report?.observations?.privateLobby;
  assert(JSON.stringify(Object.keys(privateLobby ?? {}).sort())
    === JSON.stringify(['inviteLength', 'inviteSha256', 'left', 'right', 'secretRecorded']),
  'private report excludes the invite secret');
  assert(HEX_256.test(privateLobby?.inviteSha256) && privateLobby?.inviteLength >= 20
    && privateLobby?.secretRecorded === false, 'private invite secrecy/binding');
  assert(privateLobby?.left?.visibility === 'private' && privateLobby?.right?.visibility === 'private'
    && privateLobby.left.lobbyId === privateLobby.right.lobbyId
    && privateLobby.left.owner === privateLobby.right.owner
    && privateLobby.left.owner === report.observations.profiles.left.did
    && privateLobby.left.self === report.observations.profiles.left.did
    && privateLobby.right.self === report.observations.profiles.right.did
    && privateLobby.left.transport === 'peerd' && privateLobby.right.transport === 'peerd'
    && JSON.stringify(privateLobby.left.members) === JSON.stringify(profileMembers)
    && JSON.stringify(privateLobby.right.members) === JSON.stringify(profileMembers)
    && privateLobby.left.isOwner === true && privateLobby.left.canStart === true
    && privateLobby.right.isOwner === false && privateLobby.right.canStart === false,
  'private invite-only lobby');
  const quick = report?.observations?.quickMatch;
  assert(quick?.beforeRecycle?.left?.visibility === 'public'
    && quick.beforeRecycle.left.lobbyId === quick.beforeRecycle.right.lobbyId
    && quick.beforeRecycle.left.transport === 'peerd'
    && quick.beforeRecycle.right.transport === 'peerd'
    && JSON.stringify(quick.beforeRecycle.left.members) === JSON.stringify(profileMembers)
    && JSON.stringify(quick.beforeRecycle.right.members) === JSON.stringify(profileMembers)
    && quick.beforeRecycle.left.isOwner === true && quick.beforeRecycle.left.canStart === true
    && quick.beforeRecycle.right.isOwner === false
    && quick.beforeRecycle.left.members?.length === 2
    && quick.beforeRecycle.right.members?.length === 2, 'Quick Match create-or-join semantics');
  assert(JSON.stringify(quick?.afterWorker?.left) === JSON.stringify(quick.beforeRecycle.left)
    && JSON.stringify(quick.afterWorker?.right) === JSON.stringify(quick.beforeRecycle.right)
    && JSON.stringify(quick.afterRenderer?.left) === JSON.stringify(quick.beforeRecycle.left)
    && JSON.stringify(quick.afterRenderer?.right) === JSON.stringify(quick.beforeRecycle.right),
  'exact lobby view survives recycle');
  assert(report?.observations?.workerRecycle?.stoppedRunningStatus === 'stopped'
    && report.observations.workerRecycle.newTarget === true
    && report.observations.workerRecycle.newKernel === true, 'physical SW replacement');
  assert(report?.observations?.rendererRecycle?.priorHostEpoch !== report.observations.rendererRecycle.hostEpoch
    && report.observations.rendererRecycle.didStable === true
    && report.observations.rendererRecycle.dwebLeases === 1
    && report.observations.rendererRecycle.offscreenContexts === 1,
  'physical renderer replacement');
  const coop = report?.observations?.coop;
  const leftAuthority = coop?.left?.run?.authority;
  const rightAuthority = coop?.right?.run?.authority;
  assert(coop?.left?.run?.mode === 'multiplayer' && coop?.right?.run?.mode === 'multiplayer'
    && coop.left.run.seed === coop.right.run.seed
    && typeof coop.left.run.seed === 'number' && Number.isFinite(coop.left.run.seed)
    && coop.left.multiplayer?.scope === coop.right.multiplayer?.scope
    && typeof coop.left.multiplayer?.scope === 'string' && coop.left.multiplayer.scope.length > 0
    && coop.left.multiplayer?.transport === 'peerd' && coop.right.multiplayer?.transport === 'peerd'
    && JSON.stringify([...coop.left.multiplayer.members].sort()) === JSON.stringify(profileMembers)
    && JSON.stringify([...coop.right.multiplayer.members].sort()) === JSON.stringify(profileMembers)
    && typeof leftAuthority === 'boolean' && typeof rightAuthority === 'boolean'
    && Number(leftAuthority) + Number(rightAuthority) === 1
    && coop.left.tickAdvanced === true && coop.right.tickAdvanced === true, 'co-op state/authority');
  assert(report?.observations?.inputsImmutable === true
    && report?.postRun?.artifact?.sha256 === bindings.artifact.sha256
    && report?.postRun?.tree?.sha256 === bindings.tree.sha256
    && report?.postRun?.charon?.envelope?.sha256 === bindings.charon.envelope.sha256
    && report?.postRun?.charon?.source?.sha256 === bindings.charon.source.sha256,
  'immutable packaged/Charon inputs');
  const timings = report?.timings;
  const ordered = [
    timings?.profilesReadyMs, timings?.importedMs, timings?.linkedMs,
    timings?.privateLobbyMs, timings?.quickLobbyMs, timings?.workerRecoveredMs,
    timings?.rendererRecoveredMs, timings?.coopReadyMs,
  ];
  assert(timings?.clock === 'host-monotonic-ms'
    && ordered.every((value) => Number.isFinite(value) && value >= 0)
    && ordered.every((value, index) => index === 0 || value >= ordered[index - 1]), 'ordered timings');
  assert(timings.profilesReadyMs <= report.budgets.startupMs
    && timings.importedMs - timings.profilesReadyMs <= report.budgets.importMs
    && timings.linkedMs - timings.importedMs <= report.budgets.networkMs
    && timings.privateLobbyMs - timings.linkedMs <= report.budgets.lobbyMs
    && timings.quickLobbyMs - timings.privateLobbyMs <= report.budgets.lobbyMs * 2
    && timings.workerRecoveredMs - timings.quickLobbyMs <= report.budgets.recycleMs
    && timings.rendererRecoveredMs - timings.workerRecoveredMs <= report.budgets.recycleMs
    && timings.coopReadyMs - timings.rendererRecoveredMs <= report.budgets.launchMs,
  'phase hang ceilings');
  return report;
};

export async function runPackagedCharonDwappTwoProfile({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  charonRoot = process.env.CHARON_ROOT,
  reportPath = join(artifactRoot, 'e2e', 'charon-dwapp-two-profile.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  reportPath = resolve(reportPath);
  if (!charonRoot) throw new Error('CHARON_ROOT is required and must be the pinned Charon checkout');
  const charonInfo = await inspectPinnedCharonSource(charonRoot);
  const version = String(readJson(join(sourceRoot, 'package.json')).version);
  const artifactPath = await packageArtifact({
    channel: 'preview', browser: 'chrome', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'preview-chrome');
  const manifestPath = join(treePath, 'manifest.json');
  const manifest = readJson(manifestPath);
  const backgroundEntry = manifest?.background?.service_worker;
  if (backgroundEntry !== PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY) {
    throw new Error(`expected packaged ${PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY}, got ${backgroundEntry ?? '(missing)'}`);
  }
  const beforeInputs = await snapshotInputs(artifactPath, treePath, charonInfo);
  const bindings = {
    channel: 'preview', browser: 'chrome', version,
    artifact: { path: slash(relative(sourceRoot, artifactPath)), ...beforeInputs.artifact },
    tree: { path: slash(relative(sourceRoot, treePath)), ...beforeInputs.tree },
    manifest: {
      path: slash(relative(sourceRoot, manifestPath)),
      sha256: await sha256File(manifestPath), backgroundEntry,
    },
    browserIdentity: await readChromeIdentity(),
    harness: await digestHarness(sourceRoot),
    charon: charonInfo.binding,
  };

  let left = null;
  let right = null;
  let leftApp = null;
  let rightApp = null;
  const startedAt = hostMonotonicMs();
  const sinceStart = () => roundMs(hostMonotonicMs() - startedAt);
  try {
    [left, right] = await Promise.all([
      launchPeerd({
        extensionDir: treePath, interceptModel: true,
        expectedBackgroundEntry: backgroundEntry, webRtcLoopbackAcceptance: true,
      }),
      launchPeerd({
        extensionDir: treePath, interceptModel: true,
        expectedBackgroundEntry: backgroundEntry, webRtcLoopbackAcceptance: true,
      }),
    ]);
    await unlockAndReady(left.page);
    await unlockAndReady(right.page);
    const profilesReadyMs = sinceStart();
    const [leftCutover, rightCutover] = await Promise.all([
      rpc(left.page, { type: 'bootstrap/ready' }, { timeoutMs: 10_000 }),
      rpc(right.page, { type: 'bootstrap/ready' }, { timeoutMs: 10_000 }),
    ]);
    if (leftCutover?.ok !== true || rightCutover?.ok !== true) {
      throw new Error('one packaged profile lacks a complete live kernel assembly');
    }
    const cutovers = {
      left: assertLiveKernelAssembly(leftCutover.assembly, 'preview-chrome'),
      right: assertLiveKernelAssembly(rightCutover.assembly, 'preview-chrome'),
    };
    const [leftImported, rightImported] = await Promise.all([
      importCharonThroughFileUi(left, charonInfo.envelopePath, bindings.charon),
      importCharonThroughFileUi(right, charonInfo.envelopePath, bindings.charon),
    ]);
    const importedMs = sinceStart();
    const [leftOpened, rightOpened] = await Promise.all([
      openCharonApp(left, leftImported.app.id, bindings.charon.agent),
      openCharonApp(right, rightImported.app.id, bindings.charon.agent),
    ]);
    leftApp = { ...leftOpened, appId: leftImported.app.id };
    rightApp = { ...rightOpened, appId: rightImported.app.id };
    await Promise.all([
      act(leftApp, 'set-name', { name: 'Alice' }),
      act(rightApp, 'set-name', { name: 'Bob' }),
    ]);
    const linked = await waitForLinkedProfiles(left, right);
    const linkedMs = sinceStart();

    const leftPrivateStarted = await act(leftApp, 'host-private');
    if (leftPrivateStarted?.joinOperation?.state !== 'pending') throw new Error('private host did not start');
    await approveJoin(leftApp, true);
    const privateHost = await waitForLobby(leftApp, (lobby) => lobby?.visibility === 'private' && lobby.isOwner);
    if (!privateHost) throw new Error('private host lobby did not become ready');
    const inviteCode = await readRunnerValue(leftApp, `document.querySelector('#invite-value')?.value || ''`);
    if (typeof inviteCode !== 'string' || inviteCode.length < 20) throw new Error('private invite code unavailable');
    await joinLobby(rightApp, 'join-private', { code: inviteCode });
    const privateShared = await waitForSharedLobby(leftApp, rightApp, 'private');
    const privateLobbyMs = sinceStart();
    await Promise.all([leaveLobby(leftApp), leaveLobby(rightApp)]);

    const quickHost = await joinLobby(leftApp, 'quick-match');
    if (!quickHost.lobby?.isOwner || quickHost.lobby?.members?.length !== 1) {
      throw new Error(`first Quick Match did not create a singleton lobby: ${JSON.stringify(quickHost)}`);
    }
    await joinLobby(rightApp, 'quick-match');
    const quickBefore = await waitForSharedLobby(leftApp, rightApp, 'public');
    if (!quickBefore.left.lobby.canStart || quickBefore.right.lobby.canStart) {
      throw new Error('Quick Match owner/start posture is incorrect');
    }
    const quickLobbyMs = sinceStart();

    const kernelBefore = await readKernel(left.page);
    const stopped = await left.stopServiceWorker();
    if (stopped.stoppedRunningStatus !== 'stopped') throw new Error('MV3 worker did not stop exactly');
    const restarted = await left.restartServiceWorker(stopped);
    const kernelAfter = await waitFor(async () => {
      try {
        const identity = await readKernel(left.page);
        return identity.bootId !== kernelBefore.bootId && identity.kernelEpoch !== kernelBefore.kernelEpoch
          ? identity : null;
      } catch { return null; }
    }, { budgetMs: CHARON_DWAPP_BUDGETS.recycleMs, pollMs: 50 });
    if (!kernelAfter) throw new Error('successor MV3 kernel generation was not observed');
    const quickAfterWorker = await waitForSharedLobby(leftApp, rightApp, 'public');
    const workerRecoveredMs = sinceStart();

    const hostBefore = await exactDwebLease(right);
    const didBeforeRenderer = (await dwebStatus(right.page))?.did;
    await closeOffscreenRenderer(right);
    const hostAfter = await waitFor(async () => {
      try {
        const candidate = await exactDwebLease(right);
        return candidate.status.hostEpoch !== hostBefore.status.hostEpoch ? candidate : null;
      } catch { return null; }
    }, { budgetMs: CHARON_DWAPP_BUDGETS.recycleMs, pollMs: 50 });
    if (!hostAfter) throw new Error('replacement offscreen dweb renderer was not observed');
    const dwebAfterRenderer = await waitFor(async () => {
      const status = await dwebStatus(right.page);
      return status?.ok === true && status.running === true && status.did === didBeforeRenderer ? status : null;
    }, { budgetMs: CHARON_DWAPP_BUDGETS.recycleMs, pollMs: 100 });
    if (!dwebAfterRenderer) throw new Error('replacement renderer changed dweb identity');
    const quickAfterRenderer = await waitForSharedLobby(leftApp, rightApp, 'public');
    const rendererRecoveredMs = sinceStart();

    const started = await act(leftApp, 'start-game');
    if (started?.startOperation?.state !== 'pending') {
      throw new Error(`receipt-gated start did not expose pending state: ${JSON.stringify(started)}`);
    }
    const coop = await waitForCoop(leftApp, rightApp);
    await Promise.all([act(leftApp, 'deploy'), act(rightApp, 'deploy')]);
    const coopRunning = await waitFor(async () => {
      try {
        const [a, b] = await Promise.all([observe(leftApp), observe(rightApp)]);
        return a?.screen === 'game' && b?.screen === 'game'
          && a.run?.tick > coop.left.run.tick && b.run?.tick > coop.right.run.tick
          ? { left: a, right: b } : null;
      } catch { return null; }
    }, { budgetMs: 30_000, pollMs: 100 });
    if (!coopRunning) throw new Error('co-op simulation did not advance on both peers');
    const coopReadyMs = sinceStart();

    const afterInputs = await snapshotInputs(artifactPath, treePath, charonInfo);
    const leftVault = (await rpc(left.page, { type: 'state/get' }))?.state?.vault;
    const rightVault = (await rpc(right.page, { type: 'state/get' }))?.state?.vault;
    const report = {
      schema: 1,
      ok: true,
      bindings,
      postRun: afterInputs,
      budgets: CHARON_DWAPP_BUDGETS,
      timings: {
        clock: 'host-monotonic-ms', profilesReadyMs, importedMs, linkedMs,
        privateLobbyMs, quickLobbyMs, workerRecoveredMs, rendererRecoveredMs, coopReadyMs,
      },
      observations: {
        profiles: {
          left: {
            cutover: cutovers.left,
            vault: { initialized: leftVault?.initialized === true, locked: leftVault?.locked === true },
            did: linked.left.did,
            payload: leftImported.payload,
            actor: {
              ownerClaimSha256: sha256Text(leftApp.ownerClaim),
              ownerClaimLength: leftApp.ownerClaim.length,
              name: leftApp.meta.agent.name,
              attached: true,
            },
          },
          right: {
            cutover: cutovers.right,
            vault: { initialized: rightVault?.initialized === true, locked: rightVault?.locked === true },
            did: linked.right.did,
            payload: rightImported.payload,
            actor: {
              ownerClaimSha256: sha256Text(rightApp.ownerClaim),
              ownerClaimLength: rightApp.ownerClaim.length,
              name: rightApp.meta.agent.name,
              attached: true,
            },
          },
        },
        privateLobby: {
          inviteSha256: sha256Text(inviteCode), inviteLength: inviteCode.length,
          secretRecorded: false,
          left: canonicalLobby(privateShared.left), right: canonicalLobby(privateShared.right),
        },
        quickMatch: {
          beforeRecycle: {
            left: canonicalLobby(quickBefore.left), right: canonicalLobby(quickBefore.right),
          },
          afterWorker: {
            left: canonicalLobby(quickAfterWorker.left), right: canonicalLobby(quickAfterWorker.right),
          },
          afterRenderer: {
            left: canonicalLobby(quickAfterRenderer.left), right: canonicalLobby(quickAfterRenderer.right),
          },
        },
        workerRecycle: {
          oldTargetId: stopped.targetId, newTargetId: restarted.targetId,
          versionId: stopped.versionId, stoppedRunningStatus: stopped.stoppedRunningStatus,
          newTarget: stopped.targetId !== restarted.targetId,
          newKernel: kernelBefore.bootId !== kernelAfter.bootId
            && kernelBefore.kernelEpoch !== kernelAfter.kernelEpoch,
        },
        rendererRecycle: {
          priorHostEpoch: hostBefore.status.hostEpoch,
          hostEpoch: hostAfter.status.hostEpoch,
          didStable: dwebAfterRenderer.did === didBeforeRenderer,
          dwebLeases: hostAfter.status.leases.filter((lease) => lease.scope === 'dweb').length,
          offscreenContexts: hostAfter.contexts.length,
        },
        coop: {
          left: { ...coopRunning.left, tickAdvanced: coopRunning.left.run.tick > coop.left.run.tick },
          right: { ...coopRunning.right, tickAdvanced: coopRunning.right.run.tick > coop.right.run.tick },
        },
        inputsImmutable: immutableInputs(beforeInputs, afterInputs),
      },
    };
    assertCharonDwappReport(report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    try { leftApp?.page?.close(); } catch { /* already closed */ }
    try { rightApp?.page?.close(); } catch { /* already closed */ }
    await Promise.allSettled([left?.close?.(), right?.close?.()]);
  }
}

if (import.meta.main) {
  const artifactRoot = process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
    ? resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT) : ARTIFACTS_DIR;
  const reportPath = process.env.PEERD_ACCEPTANCE_REPORT
    ? resolve(process.env.PEERD_ACCEPTANCE_REPORT)
    : join(artifactRoot, 'e2e', 'charon-dwapp-two-profile.json');
  try {
    const report = await runPackagedCharonDwappTwoProfile({ artifactRoot, reportPath });
    console.log(JSON.stringify(report, null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  }
}
