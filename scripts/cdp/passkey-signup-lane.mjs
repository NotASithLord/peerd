// Exact packaged first-install passkey lane. This is deliberately a physical
// Store-artifact smoke, not a source-tree convenience test: every result binds
// the archive, staged tree, browser binary, browser identity, and harness graph.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  evalIn, hostMonotonicMs, launchPeerd, resolveChrome, rpc, waitFor,
} from './e2e-harness.mjs';
import {
  completeOnboardingAndSelectFixture,
  kernelIdentityFromReply,
  sendAndObserveFirstControllerMessage,
  startOllamaAcceptanceFixture,
} from './product-acceptance-probes.mjs';
import {
  assertLiveKernelAssembly,
} from '../acceptance/live-kernel-assembly.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const PIN_PATH = join(__dirname, 'chrome-version.txt');
export const REPORT_DIR = join(ARTIFACTS_DIR, 'e2e');
export const REPORT_PATH = join(REPORT_DIR, 'passkey-signup-report.json');
export const PRODUCTION_BACKGROUND_ENTRY = 'background/vault-kernel-chrome.js';
export const PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY =
  'background/vault-kernel-preview.js';

// This lane distinguishes eventual first-install completion from the former
// visible dead end. The cold graph has a separate byte/module budget gate.
export const PASSKEY_SIGNUP_BUDGETS = Object.freeze({
  startupMs: 180_000,
  afterClickMs: 30_000,
  controllerMs: 30_000,
  recycleMs: 60_000,
  lockMs: 30_000,
});

const exactBudgetProfile = (actual, expected) => actual != null
  && typeof actual === 'object'
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);

const HEX_256 = /^[a-f0-9]{64}$/;
const roundMs = (value) => Math.round(Number(value) * 10) / 10;

const listFiles = (root, current = root, out = []) => {
  for (const entry of readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) listFiles(root, absolute, out);
    else if (entry.isFile()) out.push(absolute);
    else throw new Error(`unsupported artifact tree entry: ${relative(root, absolute)}`);
  }
  return out;
};

const updateWithFile = async (hash, path) => {
  for await (const chunk of createReadStream(path)) hash.update(chunk);
};

export const sha256File = async (path) => {
  const hash = createHash('sha256');
  await updateWithFile(hash, path);
  return hash.digest('hex');
};

export const digestTree = async (root) => {
  const hash = createHash('sha256');
  const files = listFiles(root);
  let bytes = 0;
  for (const path of files) {
    const rel = relative(root, path).split('\\').join('/');
    const size = statSync(path).size;
    bytes += size;
    hash.update(`file\0${rel}\0${size}\0`);
    await updateWithFile(hash, path);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: files.length, bytes };
};

export const digestHarness = async () => {
  const graph = [...await collectStaticModuleGraph(REPO_ROOT, ENTRY)].sort();
  const inputs = [...new Set([
    ...graph,
    join(__dirname, 'run-passkey-signup.mjs'),
    PIN_PATH,
    join(REPO_ROOT, 'package.json'),
    join(REPO_ROOT, 'bun.lock'),
  ])].sort();
  const hash = createHash('sha256');
  for (const path of inputs) {
    const rel = relative(REPO_ROOT, path).split('\\').join('/');
    const data = readFileSync(path);
    hash.update(`input\0${rel}\0${data.byteLength}\0`);
    hash.update(data);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: inputs.length };
};

export const readChromeIdentity = async () => {
  const path = resolveChrome();
  const expectedVersion = readFileSync(PIN_PATH, 'utf8').trim();
  const versionText = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim();
  const actualVersion = versionText.match(/\b\d+\.\d+\.\d+\.\d+\b/)?.[0] ?? '';
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `Chrome identity mismatch: expected ${expectedVersion}, got ${versionText || '(empty)'}`,
    );
  }
  return {
    path,
    expectedVersion,
    actualVersion,
    versionText,
    sha256: await sha256File(path),
    bytes: statSync(path).size,
  };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`passkey report invalid: ${message}`);
};
const reportContainsCredentialMaterial = (value) => {
  if (typeof value === 'string') return /^(?:Basic|Bearer)\s/i.test(value);
  if (Array.isArray(value)) return value.some(reportContainsCredentialMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    ['token', 'authorization', 'headers', 'credentialValue', 'secret',
      'password', 'apiKey', 'bearer'].includes(key)
      || reportContainsCredentialMaterial(entry));
};

// Importable deterministic contract: unit tests can adversarially mutate every
// milestone and terminal-state bit without launching Chrome.
export const assertPasskeySignupReport = (report) => {
  assert(report?.schema === 3, 'schema');
  assert(report?.ok === true, 'ok');
  assert(!reportContainsCredentialMaterial(report), 'credential material');
  const { bindings, timings, observations, budgets, postRun } = report;
  assert(exactBudgetProfile(budgets, PASSKEY_SIGNUP_BUDGETS), 'budget profile');
  assert(bindings?.channel === 'store' && bindings?.browser === 'chrome', 'target');
  for (const [name, value] of Object.entries({
    artifact: bindings?.artifact?.sha256,
    tree: bindings?.tree?.sha256,
    manifest: bindings?.manifest?.sha256,
    browser: bindings?.browserIdentity?.sha256,
    harness: bindings?.harness?.sha256,
  })) assert(HEX_256.test(String(value ?? '')), `${name} digest`);
  assert(bindings?.manifest?.backgroundEntry === PRODUCTION_BACKGROUND_ENTRY,
    'production background entry');
  assert(bindings.browserIdentity.expectedVersion === bindings.browserIdentity.actualVersion,
    'browser version');
  assert(bindings.artifact.bytes > 0 && bindings.tree.bytes > 0
    && bindings.tree.files > 0 && bindings.harness.files > 0, 'bound input sizes');
  assert(postRun?.artifact?.sha256 === bindings.artifact.sha256
    && postRun?.artifact?.bytes === bindings.artifact.bytes, 'artifact mutated during run');
  assert(postRun?.tree?.sha256 === bindings.tree.sha256
    && postRun?.tree?.bytes === bindings.tree.bytes
    && postRun?.tree?.files === bindings.tree.files, 'staged tree mutated during run');
  assert(observations?.inputsImmutable === true, 'immutable input observation');
  assertLiveKernelAssembly(observations?.cutover, 'store-chrome');
  assert(timings?.clock === 'host-monotonic-ms', 'clock');
  const ordered = [
    'staticShellPaintedMs', 'bootModuleEvaluatedMs', 'ctaEnabledMs', 'clickMs',
    'authenticatorReturnMs', 'durableVaultCommitMs', 'richAppReadyMs',
    'controllerFirstMessageMs', 'recycleReadyMs',
    'lockStartedMs', 'lockReadyMs',
  ];
  let previous = -Infinity;
  for (const name of ordered) {
    const value = Number(timings?.[name]);
    assert(Number.isFinite(value) && value >= previous, `milestone order at ${name}`);
    previous = value;
  }
  assert(timings.ctaEnabledMs <= budgets.startupMs, 'CTA startup budget');
  assert(timings.richAppReadyMs - timings.clickMs <= budgets.afterClickMs,
    'post-click completion budget');
  assert(timings.controllerFirstMessageMs - timings.richAppReadyMs <= budgets.controllerMs,
    'controller completion budget');
  assert(timings.recycleReadyMs - timings.controllerFirstMessageMs <= budgets.recycleMs,
    'recycle completion budget');
  assert(timings.lockReadyMs - timings.lockStartedMs <= budgets.lockMs,
    'lock teardown budget');
  assert(observations?.authenticatorReturnObserved === true, 'authenticator return');
  assert(observations?.durableVaultCommitted === true, 'durable vault commit');
  assert(observations?.controllerFirstMessage?.completionCalls === 1,
    'controller first message');
  assert(Array.isArray(observations?.coldLocked?.offscreenContexts)
    && observations.coldLocked.offscreenContexts.length === 0, 'eager cold offscreen host');
  assert(Array.isArray(observations?.semanticHost?.offscreenContexts)
    && observations.semanticHost.offscreenContexts.some((context) =>
      String(context?.documentUrl ?? '').split('#', 1)[0].endsWith('/offscreen/offscreen.html')),
  'lazy semantic host');
  assert(typeof observations?.coldRecycle?.oldWorker?.versionId === 'string'
    && observations.coldRecycle.oldWorker.versionId.length > 0
    && observations.coldRecycle.oldWorker.stoppedRunningStatus === 'stopped',
  'authoritative worker stop');
  assert(observations?.coldRecycle?.newWorker === true
    && observations?.coldRecycle?.newGeneration === true
    && observations?.coldRecycle?.controllerRecovered === true
    && observations?.coldRecycle?.controllerRecovery?.completionCalls === 2
    && observations?.coldRecycle?.recycledUi?.stage === 'app-ready'
    && observations?.coldRecycle?.recycledUi?.appShell === true
    && observations?.coldRecycle?.recycledUi?.failure !== true,
  'cold recycle continuity');
  assert(Array.isArray(observations?.lockTeardown?.offscreenContexts)
    && observations.lockTeardown.offscreenContexts.length === 0
    && observations.lockTeardown.state?.vault?.locked === true
    && observations.lockTeardown.state?.composer?.canSend === false
    && observations.lockTeardown.state?.composer?.reason === 'vault-locked'
    && observations.lockTeardown.sendRefusal?.ok === false
    && observations.lockTeardown.sendRefusal?.error === 'vault-locked'
    && observations.lockTeardown.modelCallsBefore
      === observations.lockTeardown.modelCallsAfter,
  'physical vault-lock teardown');
  assert(observations?.dweb?.status === 'pruned-by-target-policy', 'Store dweb posture');
  assert(observations?.stageTrace?.includes('vault-ready'), 'vault-ready trace');
  assert(observations?.stageTrace?.includes('app-ready'), 'app-ready trace');
  assert(observations?.stageTrace?.includes('failed') !== true, 'failed trace');
  const final = observations?.finalUi;
  assert(final?.stage === 'app-ready', 'final stage');
  assert(final?.rootVisible === true && final?.rootTextLength > 0, 'blank terminal');
  assert(final?.appShell === true && final?.gate === false, 'rich app terminal');
  assert(final?.failure === false && final?.spinnerTerminal === false, 'failure/spinner terminal');
  return report;
};

export const actionableCta = (page) => evalIn(page, `(() => {
  const html = document.documentElement;
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    /create vault/i.test(candidate.textContent || '') && !candidate.disabled);
  const shell = document.querySelector('#app');
  const shellRect = shell?.getBoundingClientRect();
  const buttonRect = button?.getBoundingClientRect();
  const shellStyle = shell ? getComputedStyle(shell) : null;
  if (html.dataset.peerdStaticShellPainted !== 'true'
      || html.dataset.peerdBootModule !== 'evaluated'
      || html.dataset.peerdBootStage !== 'vault-ready'
      || !button || !buttonRect || buttonRect.width <= 0 || buttonRect.height <= 0
      || !shellRect || shellRect.width <= 0 || shellRect.height <= 0
      || shellStyle?.visibility === 'hidden' || shellStyle?.display === 'none') return null;
  return {
    x: buttonRect.left + buttonRect.width / 2,
    y: buttonRect.top + buttonRect.height / 2,
    label: button.textContent,
  };
})()`);

export const readUi = (page) => evalIn(page, `(() => {
  const html = document.documentElement;
  const root = document.querySelector('#app');
  const rect = root?.getBoundingClientRect();
  const style = root ? getComputedStyle(root) : null;
  const text = root?.innerText || '';
  const boot = root?.querySelector(':scope > .boot-shell');
  const terminalBusy = html.dataset.peerdBootStage !== 'app-ready'
    || !!boot || /Opening peerd…|Waiting for passkey…|Finishing setup…|Passkey verified\. Finishing secure vault setup…/.test(text);
  return {
    stage: html.dataset.peerdBootStage || '',
    rootVisible: !!root && !!rect && rect.width > 0 && rect.height > 0
      && style?.visibility !== 'hidden' && style?.display !== 'none',
    rootTextLength: text.trim().length,
    appShell: !!root?.querySelector('.app-shell'),
    gate: !!root?.querySelector('.gate-card'),
    failure: html.dataset.peerdBootStage === 'failed'
      || !!root?.querySelector('.boot-shell[role="alert"]'),
    spinnerTerminal: terminalBusy,
  };
})()`);

const stageTrace = (page) => evalIn(
  page, `window.__peerdPasskeyTrace?.map((entry) => entry.stage) || []`,
);

const offscreenContexts = (page) => evalIn(page, `(async () => {
  if (typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('runtime.getContexts unavailable in pinned Chrome');
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.map((context) => ({
    contextId: context.contextId,
    contextType: context.contextType,
    documentUrl: context.documentUrl,
  }));
})()`, true);

export const installPageTrace = async (ctx, onAuthenticatorReturn) => {
  const listener = (method, params) => {
    if (method !== 'Runtime.bindingCalled' || params?.name !== '__peerdHostMilestone') return;
    try {
      const payload = JSON.parse(params.payload);
      if (payload?.stage === 'authenticator-return') onAuthenticatorReturn();
    } catch { /* malformed page diagnostics cannot satisfy the milestone */ }
  };
  ctx.page.on(listener);
  await ctx.page.send('Runtime.addBinding', { name: '__peerdHostMilestone' });
  await evalIn(ctx.page, `(() => {
    window.__peerdPasskeyTrace = [];
    let lastStage = '';
    let authenticatorReported = false;
    const record = () => {
      const bootStage = document.documentElement.dataset.peerdBootStage || '';
      if (bootStage && bootStage !== lastStage) {
        lastStage = bootStage;
        window.__peerdPasskeyTrace.push({ stage: bootStage, pageAt: performance.now() });
      }
      const text = document.body?.innerText || '';
      if (!authenticatorReported
          && text.includes('Passkey verified. Finishing secure vault setup…')) {
        authenticatorReported = true;
        window.__peerdPasskeyTrace.push({
          stage: 'authenticator-return', pageAt: performance.now(),
        });
        window.__peerdHostMilestone(JSON.stringify({ stage: 'authenticator-return' }));
      }
    };
    new MutationObserver(record).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-peerd-boot-stage'],
    });
    record();
  })()`);
  return () => ctx.page.off(listener);
};

// Install before sidepanel.html navigates. The first VaultGate render probes
// WebAuthn capabilities immediately; adding the virtual authenticator after
// navigation can permanently select the passphrase fallback for that mount.
export const installVirtualPasskey = async (page) => {
  await page.send('WebAuthn.enable');
  const common = {
    protocol: 'ctap2', ctap2Version: 'ctap2_1',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true, hasPrf: true,
  };
  await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { ...common, transport: 'internal' },
  });
  await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { ...common, transport: 'usb' },
  });
};

const readSourceVersion = (sourceRoot) => {
  const pkg = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8'));
  if (typeof pkg?.version !== 'string' || !pkg.version.trim()) {
    throw new Error(`package version missing in ${sourceRoot}`);
  }
  return pkg.version.trim();
};

const readStagedManifest = async (treePath) => {
  const path = join(treePath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return {
    path,
    sha256: await sha256File(path),
    backgroundEntry: String(manifest?.background?.service_worker ?? ''),
  };
};

const collectPostRunDigests = async (artifactPath, treePath) => ({
  artifact: {
    sha256: await sha256File(artifactPath),
    bytes: statSync(artifactPath).size,
  },
  tree: await digestTree(treePath),
});

const collectTerminalEvidence = async (ctx) => {
  if (!ctx?.page) return null;
  const [ui, body, bootstrap, state, trace] = await Promise.all([
    readUi(ctx.page).catch((cause) => ({ error: String(cause) })),
    evalIn(ctx.page, `document.body?.innerText?.slice(0, 2000) || ''`)
      .catch((cause) => `body unavailable: ${cause}`),
    rpc(ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 5_000 })
      .catch((cause) => ({ ok: false, diagnosticError: String(cause) })),
    rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 })
      .catch((cause) => ({ ok: false, diagnosticError: String(cause) })),
    stageTrace(ctx.page).catch(() => []),
  ]);
  return { ui, body, bootstrap, state, trace, pageEvents: ctx.page.events.slice(-20) };
};

const requireCompleteCutover = (reply) => {
  if (reply?.ok !== true) {
    throw new Error(`packaged kernel assembly is incomplete: ${JSON.stringify(reply)}`);
  }
  return assertLiveKernelAssembly(reply.assembly, 'store-chrome');
};

export async function runPackagedPasskeySignup({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  reportPath = join(artifactRoot, 'e2e', 'passkey-signup-report.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  reportPath = resolve(reportPath);
  const version = readSourceVersion(sourceRoot);
  const browserIdentity = await readChromeIdentity();
  const harness = await digestHarness();
  const artifactPath = await packageArtifact({
    channel: 'store', browser: 'chrome', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'store-chrome');
  const [artifactSha256, tree, manifest] = await Promise.all([
    sha256File(artifactPath),
    digestTree(treePath),
    readStagedManifest(treePath),
  ]);
  const bindings = {
    channel: 'store',
    browser: 'chrome',
    version,
    artifact: {
      path: relative(sourceRoot, artifactPath).split('\\').join('/'),
      sha256: artifactSha256,
      bytes: statSync(artifactPath).size,
    },
    tree: {
      path: relative(sourceRoot, treePath).split('\\').join('/'),
      ...tree,
    },
    manifest: {
      path: relative(sourceRoot, manifest.path).split('\\').join('/'),
      sha256: manifest.sha256,
      backgroundEntry: manifest.backgroundEntry,
    },
    browserIdentity,
    harness,
  };
  let ctx;
  let fixture;
  let postRun = null;
  try {
    if (manifest.backgroundEntry !== PRODUCTION_BACKGROUND_ENTRY) {
      throw new Error(
        `production worker cutover mismatch: expected ${PRODUCTION_BACKGROUND_ENTRY}, `
        + `packaged ${manifest.backgroundEntry || '(missing)'}`,
      );
    }
    fixture = await startOllamaAcceptanceFixture();
    ctx = await launchPeerd({
      extensionDir: treePath,
      interceptModel: false,
      captureBootTimeline: true,
      beforePanelNavigate: installVirtualPasskey,
      expectedBackgroundEntry: PRODUCTION_BACKGROUND_ENTRY,
    });
  } catch (error) {
    postRun = await collectPostRunDigests(artifactPath, treePath).catch(() => null);
    if (error && typeof error === 'object') {
      error.passkeyEvidence = {
        phase: 'production-worker-cutover', bindings, postRun,
        terminal: await collectTerminalEvidence(ctx),
      };
    }
    await fixture?.close().catch(() => {});
    throw error;
  }
  let removePageListener = () => {};
  try {
    const launchStartedAt = ctx.bootTimeline.launchStartedAt;
    const sinceLaunch = () => roundMs(hostMonotonicMs() - launchStartedAt);
    let authenticatorReturnAt = null;
    let settleAuthenticator;
    const authenticatorReturned = new Promise((resolveReturn) => {
      settleAuthenticator = resolveReturn;
    });
    removePageListener = await installPageTrace(ctx, () => {
      if (authenticatorReturnAt !== null) return;
      authenticatorReturnAt = sinceLaunch();
      settleAuthenticator(true);
    });

    const center = await waitFor(() => actionableCta(ctx.page), {
      budgetMs: PASSKEY_SIGNUP_BUDGETS.startupMs,
      pollMs: 25,
    });
    if (!center) {
      const [ui, body, bootstrap, state] = await Promise.all([
        readUi(ctx.page).catch((cause) => ({ error: String(cause) })),
        evalIn(ctx.page, `document.body?.innerText?.slice(0, 1200) || ''`)
          .catch((cause) => `body unavailable: ${cause}`),
        rpc(ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 5_000 }),
        rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 }),
      ]);
      throw new Error(`exact vault-ready passkey CTA never became actionable\n${JSON.stringify({
        ui, body, bootstrap, state, pageEvents: ctx.page.events.slice(-12),
      }, null, 2)}`);
    }
    const cutover = requireCompleteCutover(await rpc(
      ctx.page, { type: 'bootstrap/ready' }, { timeoutMs: 5_000 },
    ));
    const coldOffscreen = await offscreenContexts(ctx.page);
    if (coldOffscreen.length !== 0) {
      throw new Error(
        `locked first-install boot eagerly created offscreen context: ${JSON.stringify(coldOffscreen)}`,
      );
    }
    const ctaEnabledMs = sinceLaunch();
    const clickMs = sinceLaunch();
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...center, button: 'left', clickCount: 1,
    });
    await ctx.page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...center, button: 'left', clickCount: 1,
    });

    const observedReturn = await Promise.race([
      authenticatorReturned,
      new Promise((resolveReturn) => setTimeout(
        () => resolveReturn(false), PASSKEY_SIGNUP_BUDGETS.afterClickMs,
      )),
    ]);
    if (!observedReturn || authenticatorReturnAt === null) {
      throw new Error('WebAuthn returned but the finishing milestone was never observed');
    }

    const durable = await waitFor(async () => {
      const reply = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 });
      const vault = reply?.state?.vault;
      return vault?.initialized && vault?.locked === false && vault?.prfEnrolled
        ? { reply, vault } : null;
    }, { budgetMs: PASSKEY_SIGNUP_BUDGETS.afterClickMs, pollMs: 50 });
    if (!durable) throw new Error('vault did not durably commit initialized+unlocked+PRF state');
    const durableVaultCommitMs = sinceLaunch();

    const finalUi = await waitFor(async () => {
      const ui = await readUi(ctx.page);
      return ui.stage === 'app-ready' && ui.appShell && !ui.gate ? ui : null;
    }, { budgetMs: PASSKEY_SIGNUP_BUDGETS.afterClickMs, pollMs: 25 });
    if (!finalUi) {
      const [ui, body, trace] = await Promise.all([
        readUi(ctx.page).catch((cause) => ({ error: String(cause) })),
        evalIn(ctx.page, `document.body?.innerText?.slice(0, 1200) || ''`)
          .catch((cause) => `body unavailable: ${cause}`),
        stageTrace(ctx.page).catch(() => []),
      ]);
      throw new Error(`passkey signup did not reach the rich app\n${JSON.stringify({
        ui, body, trace, pageEvents: ctx.page.events.slice(-12),
      }, null, 2)}`);
    }
    const richAppReadyMs = sinceLaunch();

    const trace = await stageTrace(ctx.page);
    await completeOnboardingAndSelectFixture(ctx.page, fixture.origin);
    const controllerCompletion = sendAndObserveFirstControllerMessage(ctx.page, fixture);
    const semanticOffscreen = await waitFor(async () => {
      const contexts = await offscreenContexts(ctx.page);
      return contexts.length >= 1 ? contexts : null;
    }, { budgetMs: 10_000, pollMs: 10 });
    if (!semanticOffscreen) throw new Error('lazy semantic offscreen host was never observed');
    const controllerFirstMessage = await controllerCompletion;
    const controllerFirstMessageMs = sinceLaunch();

    const beforeRecycleReply = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 10_000 });
    const beforeRecycle = kernelIdentityFromReply(beforeRecycleReply);
    if (!beforeRecycle) {
      throw new Error(`kernel generation missing before recycle: ${JSON.stringify(beforeRecycleReply)}`);
    }
    const oldWorker = await ctx.stopServiceWorker();
    const newWorker = await ctx.restartServiceWorker(oldWorker);
    const afterRecycle = await waitFor(async () => {
      const reply = await rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 });
      const identity = kernelIdentityFromReply(reply);
      return identity && identity.bootId !== beforeRecycle.bootId
        && identity.kernelEpoch !== beforeRecycle.kernelEpoch
        ? { reply, identity }
        : null;
    }, { budgetMs: PASSKEY_SIGNUP_BUDGETS.recycleMs, pollMs: 50 });
    if (!afterRecycle) throw new Error('fresh kernel generation was not observed after recycle');
    const recycledUi = await waitFor(async () => {
      const ui = await readUi(ctx.page);
      return ui.stage === 'app-ready' && ui.appShell && !ui.gate ? ui : null;
    }, { budgetMs: PASSKEY_SIGNUP_BUDGETS.recycleMs, pollMs: 25 });
    if (!recycledUi) throw new Error('recycled panel did not recover to a nonblank rich app');
    const controllerRecovered = await sendAndObserveFirstControllerMessage(ctx.page, fixture, {
      text: 'production cutover acceptance ping after recycle',
      expectedCompletionCalls: 2,
    });
    const recycleReadyMs = sinceLaunch();

    const lockStartedMs = sinceLaunch();
    const modelCallsBeforeLock = fixture.completionCalls();
    const locked = await rpc(ctx.page, { type: 'vault/lock' }, {
      timeoutMs: PASSKEY_SIGNUP_BUDGETS.lockMs,
    });
    if (locked?.ok !== true) throw new Error(`vault lock failed: ${JSON.stringify(locked)}`);
    const lockTeardown = await waitFor(async () => {
      const [contexts, stateReply] = await Promise.all([
        offscreenContexts(ctx.page),
        rpc(ctx.page, { type: 'state/get' }, { timeoutMs: 5_000 }),
      ]);
      const state = stateReply?.state;
      return contexts.length === 0
        && state?.vault?.locked === true
        && state?.composer?.canSend === false
        && state?.composer?.reason === 'vault-locked'
        ? { contexts, state: { vault: state.vault, composer: state.composer } } : null;
    }, { budgetMs: PASSKEY_SIGNUP_BUDGETS.lockMs, pollMs: 25 });
    if (!lockTeardown) {
      throw new Error('vault lock did not retire the semantic host and publish locked state');
    }
    const sendRefusal = await rpc(ctx.page, {
      type: 'agent/send', text: 'this request must not reach the model while locked',
    }, { timeoutMs: 10_000 });
    await new Promise((resolveDelay) => setTimeout(resolveDelay,
      Math.max(1_000, fixture.completionDelayMs * 2)));
    const modelCallsAfterLock = fixture.completionCalls();
    const lockReadyMs = sinceLaunch();

    postRun = await collectPostRunDigests(artifactPath, treePath);
    const inputsImmutable = postRun.artifact.sha256 === bindings.artifact.sha256
      && postRun.artifact.bytes === bindings.artifact.bytes
      && postRun.tree.sha256 === bindings.tree.sha256
      && postRun.tree.bytes === bindings.tree.bytes
      && postRun.tree.files === bindings.tree.files;
    const report = {
      schema: 3,
      ok: true,
      bindings,
      postRun,
      budgets: PASSKEY_SIGNUP_BUDGETS,
      timings: {
        clock: 'host-monotonic-ms',
        staticShellPaintedMs: roundMs(ctx.bootTimeline.staticShellReadyMs),
        bootModuleEvaluatedMs: roundMs(ctx.bootTimeline.bootModuleReadyMs),
        ctaEnabledMs,
        clickMs,
        authenticatorReturnMs: authenticatorReturnAt,
        durableVaultCommitMs,
        richAppReadyMs,
        controllerFirstMessageMs,
        recycleReadyMs,
        lockStartedMs,
        lockReadyMs,
      },
      observations: {
        cutover,
        ctaLabel: center.label,
        authenticatorReturnObserved: true,
        durableVaultCommitted: true,
        inputsImmutable,
        controllerFirstMessage,
        coldLocked: { offscreenContexts: coldOffscreen },
        semanticHost: {
          offscreenContexts: semanticOffscreen,
          fixtureDelayMs: fixture.completionDelayMs,
        },
        coldRecycle: {
          oldWorker: {
            targetId: oldWorker.targetId,
            entry: oldWorker.entry,
            versionId: oldWorker.versionId,
            stoppedRunningStatus: oldWorker.stoppedRunningStatus,
          },
          newWorker: newWorker.targetId !== oldWorker.targetId,
          before: beforeRecycle,
          after: afterRecycle.identity,
          newGeneration: true,
          controllerRecovered: controllerRecovered.completionCalls === 2,
          controllerRecovery: controllerRecovered,
          recycledUi,
        },
        lockTeardown: {
          offscreenContexts: lockTeardown.contexts,
          state: lockTeardown.state,
          sendRefusal,
          modelCallsBefore: modelCallsBeforeLock,
          modelCallsAfter: modelCallsAfterLock,
        },
        dweb: { status: 'pruned-by-target-policy', target: 'store-chrome' },
        stageTrace: trace,
        finalUi,
      },
    };
    assertPasskeySignupReport(report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    postRun ??= await collectPostRunDigests(artifactPath, treePath).catch(() => null);
    if (error && typeof error === 'object') {
      const failure = /** @type {Error & {passkeyEvidence?:unknown}} */ (error);
      failure.passkeyEvidence = {
        phase: 'packaged-passkey-ux', bindings, postRun,
        terminal: await collectTerminalEvidence(ctx),
      };
    }
    throw error;
  } finally {
    removePageListener();
    await ctx.close();
    await fixture?.close().catch(() => {});
  }
}
