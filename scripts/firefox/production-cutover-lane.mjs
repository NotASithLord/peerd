#!/usr/bin/env bun
// Installed Store-Firefox production cutover lane: real first-install UI,
// passphrase commit, semantic controller, App/isomorphic-git, and event-page
// discard/recovery. Firefox Store intentionally prunes dweb until it has a
// durable mesh host; this lane proves that posture instead of claiming mesh
// continuity that the artifact cannot provide.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { packageArtifact } from '../../packaging/package.ts';
import { ARTIFACTS_DIR, REPO_ROOT } from '../../packaging/lib.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  digestTree, sha256File,
} from '../cdp/passkey-signup-lane.mjs';
import {
  assertLiveKernelAssembly,
} from '../acceptance/live-kernel-assembly.mjs';
import {
  ACCEPTANCE_REPLY, browserAppGitProbe, browserRemoteAppGitProbe,
  browserVerifyAcceptanceAppPayload, browserVerifyRemoteAppGitAfterRecycle,
  kernelIdentityFromReply,
  REMOTE_GIT_PROOF_PATH, REMOTE_GIT_PROOF_TEXT,
  startOllamaAcceptanceFixture,
} from '../cdp/product-acceptance-probes.mjs';
import {
  assertExactGitFixtureRequests, assertGitFixtureBinding, assertGitFixtureSnapshot,
  assertSecretlessGitReport,
  GIT_FIXTURE_HOST, GIT_FIXTURE_REMOTE,
  redactGitFixtureCredential,
  startGitSmartHttpFixture,
} from '../acceptance/git-smart-http-fixture.mjs';
import { startGeckodriver, waitFor } from './webdriver.mjs';

const ENTRY = import.meta.path;
const FIREFOX_BACKGROUND_ENTRY = 'background/vault-kernel-firefox.js';
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const HOME_URL = `moz-extension://${FIREFOX_UUID}/home/home.html#production-cutover`;
const PANEL_URL = `moz-extension://${FIREFOX_UUID}/sidepanel/sidepanel.html#production-cutover`;
const EVENT_PAGE_IDLE_MS = 45_000;
const PASSPHRASE = 'firefox-production-cutover-passphrase';
export const FIREFOX_CUTOVER_HANG_CEILINGS = Object.freeze({
  ctaMs: 180_000,
  vaultCommitAfterSubmitMs: 120_000,
  panelAfterVaultMs: 60_000,
  controllerMs: 30_000,
  repositoryMs: 30_000,
  recycleAfterIdleMs: 150_000,
});
const exactBudgetProfile = (actual, expected) => actual != null
  && typeof actual === 'object'
  && Object.keys(actual).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, value]) => actual[key] === value);
const HEX_256 = /^[a-f0-9]{64}$/;
const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
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
  browser.runtime.sendMessage(message).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({
      ok: false, transportError: error?.message || String(error),
    })),
  );
`, [message]));

const executeJson = async (driver, source, args = []) =>
  JSON.parse(await driver.execute(`return JSON.stringify((${source}));`, args));

const uiSnapshot = (driver) => executeJson(driver, `(() => {
  const root = document.querySelector('#app');
  const rect = root?.getBoundingClientRect();
  const style = root ? getComputedStyle(root) : null;
  const body = document.body?.innerText || '';
  return {
    url: location.href,
    readyState: document.readyState,
    stage: document.documentElement.dataset.peerdBootStage || '',
    bootModule: document.documentElement.dataset.peerdBootModule || '',
    staticShellPainted: document.documentElement.dataset.peerdStaticShellPainted === 'true',
    rootVisible: !!root && !!rect && rect.width > 0 && rect.height > 0
      && style?.visibility !== 'hidden' && style?.display !== 'none',
    rootTextLength: body.trim().length,
    body: body.slice(0, 2000),
    homeShell: !!document.querySelector('.home-shell'),
    appShell: !!document.querySelector('.app-shell'),
    gate: !!document.querySelector('.gate-card'),
    failure: document.documentElement.dataset.peerdBootStage === 'failed'
      || !!document.querySelector('[role="alert"]'),
  };
})()`);

const ensurePassphraseForm = async (driver) => waitFor(async () => executeJson(driver, `(() => {
  if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return null;
  const root = document.querySelector('#app');
  const rootRect = root?.getBoundingClientRect();
  const rootStyle = root ? getComputedStyle(root) : null;
  if (!root || !rootRect || rootRect.width <= 0 || rootRect.height <= 0
      || rootStyle?.display === 'none' || rootStyle?.visibility === 'hidden') return null;
  const fallback = [...document.querySelectorAll('button')]
    .find((node) => /use a passphrase instead/i.test(node.textContent || ''));
  if (fallback) {
    const rect = fallback.getBoundingClientRect();
    if (fallback.disabled || rect.width <= 0 || rect.height <= 0) return null;
    fallback.click();
    return null;
  }
  const pass = document.querySelector('#pass');
  const confirm = document.querySelector('#pass2');
  const submit = [...document.querySelectorAll('button')]
    .find((node) => /create vault/i.test(node.textContent || '') && !node.disabled);
  const passRect = pass?.getBoundingClientRect();
  const confirmRect = confirm?.getBoundingClientRect();
  const submitRect = submit?.getBoundingClientRect();
  return pass && confirm && submit
    && passRect?.width > 0 && passRect?.height > 0
    && confirmRect?.width > 0 && confirmRect?.height > 0
    && submitRect?.width > 0 && submitRect?.height > 0
    ? { rootVisible: true, formVisible: true, submitEnabled: true } : null;
})()`), { budgetMs: FIREFOX_CUTOVER_HANG_CEILINGS.ctaMs, pollMs: 100 });

const submitPassphrase = (driver) => driver.execute(`
  const value = arguments[0];
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const id of ['pass', 'pass2']) {
    const input = document.getElementById(id);
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const submit = [...document.querySelectorAll('button')]
    .find((node) => /create vault/i.test(node.textContent || '') && !node.disabled);
  submit.click();
  return true;
`, [PASSPHRASE]);

const skipProviderSetup = (driver) => waitFor(() => executeJson(driver, `(() => {
  const skip = [...document.querySelectorAll('button')]
    .find((node) => /do this later/i.test(node.textContent || '') && !node.disabled);
  if (!skip) return null;
  skip.click();
  return true;
})()`), { budgetMs: 30_000, pollMs: 100 });

const waitForControllerReply = async (driver, text, fixture, expectedCalls) => waitFor(async () => {
  if (fixture.completionCalls() !== expectedCalls) return null;
  return executeJson(driver, `(() => {
    const user = [...document.querySelectorAll('.message-user')]
      .some((node) => (node.textContent || '').includes(arguments[0]));
    const assistant = [...document.querySelectorAll('.message-assistant .bubble')]
      .some((node) => (node.textContent || '').trim() === arguments[1]);
    const busy = !!document.querySelector('.message-assistant.streaming, form.input-bar button.stop');
    return user && assistant && !busy ? { user, assistant, busy } : null;
  })()`, [text, ACCEPTANCE_REPLY]);
}, { budgetMs: 30_000, pollMs: 50 });

const runAppGit = async (driver) => JSON.parse(await driver.executeAsync(`
  const done = arguments[arguments.length - 1];
  const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
  const probe = ${browserAppGitProbe.toString()};
  probe(true, verifyPayload).then(
    (reply) => done(JSON.stringify(reply)),
    (error) => done(JSON.stringify({ ok: false, phase: 'exception', detail: String(error) })),
  );
`));

const runRemoteAppGit = async (driver, appId, config) => JSON.parse(await driver.executeAsync(`
  const appId = arguments[0];
  const config = arguments[1];
  const done = arguments[arguments.length - 1];
  const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
  const probe = ${browserRemoteAppGitProbe.toString()};
  probe(appId, config, verifyPayload).then(
    (reply) => done(JSON.stringify(reply)),
    () => done(JSON.stringify({ ok: false, phase: 'exception', detail: 'remote-git-operation-failed' })),
  );
`, [appId, config]));

const verifyRemoteAppGit = async (driver, appId, config) =>
  JSON.parse(await driver.executeAsync(`
    const appId = arguments[0];
    const config = arguments[1];
    const done = arguments[arguments.length - 1];
    const verify = ${browserVerifyRemoteAppGitAfterRecycle.toString()};
    verify(appId, config).then(
      (reply) => done(JSON.stringify(reply)),
      () => done(JSON.stringify({ ok: false, phase: 'exception', detail: 'remote-git-recycle-verification-failed' })),
    );
  `, [appId, config]));

const verifyAppGit = async (driver, appId, { cleanup = true } = {}) => {
  const payload = JSON.parse(await driver.executeAsync(`
    const done = arguments[arguments.length - 1];
    const appId = arguments[0];
    const verifyPayload = ${browserVerifyAcceptanceAppPayload.toString()};
    verifyPayload(appId).then(
      (reply) => done(JSON.stringify(reply)),
      (error) => done(JSON.stringify({ ok: false, phase: 'exception', detail: String(error) })),
    );
  `, [appId]));
  const status = await call(driver, { type: 'apps/repository/status', appId });
  const history = await call(driver, { type: 'apps/repository/history', appId, depth: 5 });
  const removed = cleanup ? await call(driver, { type: 'apps/delete', appId }) : { ok: true };
  return {
    ok: payload?.ok === true
      && status?.ok === true && typeof status.status?.oid === 'string'
      && status.status.oid.length > 0 && history?.ok === true
      && history.commits?.length >= 1 && removed?.ok === true,
    payload, status, history, removed,
  };
};

const digestHarness = async () => {
  const graph = [...await collectStaticModuleGraph(REPO_ROOT, ENTRY)];
  const inputs = [...new Set([
    ...graph,
    resolve(import.meta.dir, 'firefox-version.txt'),
    resolve(import.meta.dir, 'geckodriver-version.txt'),
  ])].sort();
  const hash = createHash('sha256');
  for (const path of inputs) {
    const data = readFileSync(path);
    hash.update(`input\0${relative(REPO_ROOT, path)}\0${data.byteLength}\0`);
    hash.update(data);
    hash.update('\0');
  }
  return { sha256: hash.digest('hex'), files: inputs.length };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`Firefox production acceptance invalid: ${message}`);
};
const exactKeys = (value, keys) => value != null && typeof value === 'object'
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const reportContainsCredentialMaterial = (value) => {
  if (typeof value === 'string') return /^(?:Basic|Bearer)\s/i.test(value);
  if (Array.isArray(value)) return value.some(reportContainsCredentialMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    ['token', 'authorization', 'headers', 'credentialValue', 'secret',
      'password', 'apiKey', 'bearer'].includes(key)
      || reportContainsCredentialMaterial(entry));
};

export const assertFirefoxProductionReport = (report) => {
  assert(report?.schema === 2 && report?.ok === true, 'schema/ok');
  assert(!reportContainsCredentialMaterial(report), 'credential material');
  assert(exactBudgetProfile(report?.budgets, FIREFOX_CUTOVER_HANG_CEILINGS),
    'budget profile');
  assert(report?.bindings?.channel === 'store' && report?.bindings?.browser === 'firefox',
    'target');
  for (const value of [
    report?.bindings?.artifact?.sha256,
    report?.bindings?.tree?.sha256,
    report?.bindings?.manifest?.sha256,
    report?.bindings?.harness?.sha256,
    report?.bindings?.runtimeIdentity?.binaries?.firefox?.sha256,
    report?.bindings?.runtimeIdentity?.binaries?.geckodriver?.sha256,
    report?.bindings?.gitFixture?.sha256,
    report?.bindings?.gitFixture?.certificateSha256,
    report?.bindings?.gitFixture?.protocolSha256,
  ]) assert(HEX_256.test(String(value ?? '')), 'digest binding');
  assert(report.bindings.gitFixture?.host === GIT_FIXTURE_HOST
    && report.bindings.gitFixture?.remote === GIT_FIXTURE_REMOTE, 'Git fixture identity');
  assertGitFixtureBinding(report.bindings.gitFixture);
  assert(report.bindings.manifest.backgroundEntry === FIREFOX_BACKGROUND_ENTRY,
    'production background entry');
  assert(report.bindings.runtimeIdentity?.pinned === true
    && report.bindings.runtimeIdentity.expected.firefox
      === report.bindings.runtimeIdentity.actual.firefox
    && report.bindings.runtimeIdentity.expected.geckodriver
      === report.bindings.runtimeIdentity.actual.geckodriver, 'pinned runtime identity');
  assert(report.postRun.artifact.sha256 === report.bindings.artifact.sha256
    && report.postRun.artifact.bytes === report.bindings.artifact.bytes
    && report.postRun.tree.sha256 === report.bindings.tree.sha256
    && report.postRun.tree.bytes === report.bindings.tree.bytes
    && report.postRun.tree.files === report.bindings.tree.files, 'artifact mutation');
  assert(report.timings?.clock === 'host-monotonic-ms', 'clock');
  const ordered = [
    'ctaMs', 'submitMs', 'vaultCommitMs', 'panelReadyMs', 'controllerFirstMessageMs',
    'appGitReadyMs', 'remoteGitReadyMs', 'recycleReadyMs',
  ];
  let prior = -Infinity;
  for (const name of ordered) {
    const value = Number(report.timings?.[name]);
    assert(Number.isFinite(value) && value >= prior, `milestone order at ${name}`);
    prior = value;
  }
  assert(report.timings.ctaMs <= report.budgets.ctaMs, 'CTA hang ceiling');
  assert(report.timings.vaultCommitMs - report.timings.submitMs
    <= report.budgets.vaultCommitAfterSubmitMs, 'vault commit hang ceiling');
  assert(report.timings.panelReadyMs - report.timings.vaultCommitMs
    <= report.budgets.panelAfterVaultMs, 'panel hang ceiling');
  assert(report.timings.controllerFirstMessageMs - report.timings.panelReadyMs
    <= report.budgets.controllerMs, 'controller hang ceiling');
  assert(report.timings.remoteGitReadyMs - report.timings.controllerFirstMessageMs
    <= report.budgets.repositoryMs, 'repository hang ceiling');
  assert(report.timings.recycleReadyMs - report.timings.recycleWakeStartedMs
    <= report.budgets.recycleAfterIdleMs, 'recycle hang ceiling');
  assertLiveKernelAssembly(report.observations.cutover, 'store-firefox');
  assert(report.observations.cta.actionable === true
    && report.observations.cta.rootVisible === true
    && report.observations.cta.formVisible === true
    && report.observations.cta.submitEnabled === true
    && report.observations.vault.initialized === true
    && report.observations.vault.locked === false, 'passphrase commit');
  assert(report.observations.finalUi.stage === 'app-ready'
    && report.observations.finalUi.rootVisible === true
    && report.observations.finalUi.rootTextLength > 0
    && report.observations.finalUi.failure === false, 'nonblank app terminal');
  assert(report.observations.controllerFirstMessage?.completionCalls === 1
    && report.observations.appGit?.ok === true
    && report.observations.appGit?.payload?.ok === true, 'semantic/App Git');
  assert(report.observations.remoteGit?.ok === true
    && report.observations.remoteGit?.phase === 'complete'
    && report.observations.remoteGit?.credentialStored === true
    && report.observations.remoteGit?.remoteLinked === true
    && report.observations.remoteGit?.pushed === true
    && report.observations.remoteGit?.fetched === true
    && report.observations.remoteGit?.cleanClone?.ok === true
    && report.observations.remoteGit?.cleanClone?.payload?.textOk === true
    && report.observations.remoteGit?.cleanClone?.payload?.binaryOk === true
    && report.observations.remoteGit?.cleanClone?.proofOk === true,
  'remote App/isomorphic-git');
  assert(exactKeys(report.observations.remoteGit, [
    'ok', 'phase', 'credentialStored', 'host', 'remoteLinked', 'branch',
    'committedOid', 'pushed', 'fetched', 'cleanClone', 'remoteBranch',
  ]) && exactKeys(report.observations.remoteGit.cleanClone, [
    'ok', 'payload', 'proofOk', 'oid', 'historyContainsCommit',
  ]) && exactKeys(report.observations.remoteGit.cleanClone.payload, [
    'ok', 'textOk', 'binaryOk', 'fileCount',
  ]) && exactKeys(report.observations.remoteGit.remoteBranch, ['branch', 'oid', 'files'])
    && exactKeys(report.observations.remoteGit.remoteBranch.files, [
      'index.html', 'src/main.js', 'assets/raw.bin', REMOTE_GIT_PROOF_PATH,
    ]), 'remote Git report shape');
  assert(report.observations.remoteGitFixture?.bindingSha256
    === report.bindings.gitFixture.sha256, 'Git fixture binding');
  assert(Object.keys(report.observations.remoteGitFixture).sort().join(',')
    === ['bindingSha256', 'requests', 'schema', 'summary'].sort().join(','),
  'Git fixture report shape');
  assertGitFixtureSnapshot({
    schema: report.observations.remoteGitFixture.schema,
    requests: report.observations.remoteGitFixture.requests,
    summary: report.observations.remoteGitFixture.summary,
  });
  assert(report.observations.recycle?.newGeneration === true
    && report.observations.recycle?.controllerRecovered === true
    && report.observations.recycle?.controllerCompletionCalls === 2
    && report.observations.recycle?.appGitPersisted === true
    && report.observations.recycle?.appGitPersistence?.payload?.ok === true
    && report.observations.recycle?.remoteGitPersisted === true
    && report.observations.recycle?.remoteGitPersistence?.fetched === true
    && report.observations.recycle?.remoteGitPersistence?.credentialRetained === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.appRemoved === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.credentialRemoved === true
    && report.observations.recycle?.remoteGitPersistence?.cleanup?.credentialAbsent === true,
  'event-page continuity');
  assert(exactKeys(report.observations.recycle.remoteGitPersistence, [
    'ok', 'phase', 'host', 'fetched', 'oid', 'historyContainsCommit',
    'credentialRetained', 'cleanup',
  ]) && exactKeys(report.observations.recycle.remoteGitPersistence.cleanup, [
    'appRemoved', 'credentialRemoved', 'credentialAbsent',
  ]), 'remote Git recycle report shape');
  assert(report.observations.dweb?.error === 'dweb-disabled', 'Firefox dweb posture');
  assert(typeof report.observations.screenshot?.path === 'string'
    && report.observations.screenshot.path.endsWith('.png')
    && HEX_256.test(String(report.observations.screenshot?.sha256 ?? '')),
  'screenshot binding');
  return report;
};

export async function runFirefoxProductionCutover({
  sourceRoot = REPO_ROOT,
  artifactRoot = ARTIFACTS_DIR,
  reportPath = join(artifactRoot, 'e2e', 'firefox-production-cutover.json'),
} = {}) {
  sourceRoot = resolve(sourceRoot);
  artifactRoot = resolve(artifactRoot);
  const firefox = firefoxBinary();
  const geckodriver = geckodriverBinary();
  if (!firefox || !existsSync(firefox) || !geckodriver || !existsSync(geckodriver)) {
    throw new Error('pinned Firefox/geckodriver unavailable; set FIREFOX_PATH and GECKODRIVER_PATH');
  }
  const version = String(JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version);
  const artifactPath = await packageArtifact({
    channel: 'store', browser: 'firefox', version, sign: false, verify: true,
    sourceRoot, artifactRoot,
  });
  const treePath = join(artifactRoot, 'staging', 'store-firefox');
  const manifestPath = join(treePath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const backgroundEntry = manifest?.background?.scripts?.[0] ?? '';
  const harness = await digestHarness();
  const gitFixture = await startGitSmartHttpFixture();
  const bindings = {
    channel: 'store', browser: 'firefox', version,
    artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
    tree: await digestTree(treePath),
    manifest: { sha256: await sha256File(manifestPath), backgroundEntry },
    harness,
    gitFixture: gitFixture.binding(),
    runtimeIdentity: null,
  };
  let driver;
  let fixture;
  try {
    if (backgroundEntry !== FIREFOX_BACKGROUND_ENTRY) {
      throw new Error(
        `production worker cutover mismatch: expected ${FIREFOX_BACKGROUND_ENTRY}, `
        + `packaged ${backgroundEntry || '(missing)'}`,
      );
    }
    fixture = await startOllamaAcceptanceFixture();
    const proxyUrl = new URL(gitFixture.proxyServer.url);
    const startedAt = hostNowMs();
    driver = await startGeckodriver({
      binary: geckodriver,
      firefoxBinary: firefox,
      acceptInsecureCerts: true,
      proxy: {
        proxyType: 'manual',
        sslProxy: `127.0.0.1:${proxyUrl.port}`,
        noProxy: ['127.0.0.1', 'localhost'],
      },
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
      },
    });
    bindings.runtimeIdentity = driver.runtimeIdentity;
    const installed = await driver.installAddon(artifactPath);
    if (installed !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installed}`);
    await driver.navigate(HOME_URL);
    const bootstrap = await call(driver, { type: 'bootstrap/ready' });
    const cutover = bootstrap?.assembly;
    if (bootstrap?.ok !== true) {
      throw new Error(`Firefox packaged kernel assembly is incomplete: ${JSON.stringify(bootstrap)}`);
    }
    assertLiveKernelAssembly(cutover, 'store-firefox');
    const actionable = await ensurePassphraseForm(driver);
    if (!actionable) throw new Error('Firefox passphrase CTA never became actionable');
    const ctaMs = hostNowMs() - startedAt;
    const submitMs = hostNowMs() - startedAt;
    await submitPassphrase(driver);
    if (!await skipProviderSetup(driver)) {
      throw new Error('Firefox provider setup did not become skippable');
    }
    const onboarding = await call(driver, {
      type: 'onboarding/complete', peerName: 'peerd', facts: null,
    });
    const settings = await call(driver, {
      type: 'settings/update',
      patch: { providerName: 'ollama', providerModel: 'qwen3:8b', ollamaHost: fixture.origin },
    });
    if (onboarding?.ok !== true || settings?.ok !== true) {
      throw new Error(`Firefox semantic setup failed: ${JSON.stringify({ onboarding, settings })}`);
    }
    const homeReady = await waitFor(async () => {
      const ui = await uiSnapshot(driver);
      return ui.stage === 'app-ready' && ui.homeShell && ui.rootVisible && !ui.failure ? ui : null;
    }, { budgetMs: 120_000, pollMs: 100 });
    if (!homeReady) throw new Error('Firefox Home did not reach a nonblank app-ready state');
    const state = await call(driver, { type: 'state/get' });
    if (state?.state?.vault?.initialized !== true || state.state.vault.locked !== false) {
      throw new Error(`Firefox vault did not commit: ${JSON.stringify(state)}`);
    }
    const vaultCommitMs = hostNowMs() - startedAt;
    await driver.navigate(PANEL_URL);
    const panelReady = await waitFor(async () => {
      const ui = await uiSnapshot(driver);
      return ui.stage === 'app-ready' && ui.appShell && ui.rootVisible && !ui.failure ? ui : null;
    }, { budgetMs: 60_000, pollMs: 100 });
    if (!panelReady) throw new Error('Firefox panel did not reach app-ready');
    const panelReadyMs = hostNowMs() - startedAt;
    const firstText = 'Firefox production controller first message';
    const sent = await call(driver, { type: 'agent/send', text: firstText });
    if (sent?.ok !== true || !(await waitForControllerReply(driver, firstText, fixture, 1))) {
      throw new Error(`Firefox first controller message failed: ${JSON.stringify(sent)}`);
    }
    const firstControllerCompletionCalls = fixture.completionCalls();
    const controllerFirstMessageMs = hostNowMs() - startedAt;
    const appGit = await runAppGit(driver);
    if (appGit?.ok !== true) throw new Error(`Firefox App/Git failed: ${JSON.stringify(appGit)}`);
    const appGitReadyMs = hostNowMs() - startedAt;
    const gitCredential = gitFixture.credential();
    const remoteConfig = {
      host: GIT_FIXTURE_HOST,
      remote: GIT_FIXTURE_REMOTE,
      token: gitCredential.token,
      branch: 'acceptance/cutover',
      proofPath: REMOTE_GIT_PROOF_PATH,
      proofText: REMOTE_GIT_PROOF_TEXT,
    };
    const remoteGit = await runRemoteAppGit(driver, appGit.appId, remoteConfig);
    if (remoteGit?.ok !== true) {
      throw new Error(`Firefox remote App/Git failed: ${JSON.stringify(remoteGit)}`);
    }
    const remoteBranch = await gitFixture.verifyBranch(remoteConfig.branch, {
      'index.html': '<!doctype html><title>Cutover App</title><main>ready</main>',
      'src/main.js': 'document.querySelector("main").dataset.ready = "true";',
      'assets/raw.bin': Buffer.from([0, 1, 2, 127, 128, 255]),
      [REMOTE_GIT_PROOF_PATH]: REMOTE_GIT_PROOF_TEXT,
    });
    if (remoteBranch.oid !== remoteGit.committedOid) {
      throw new Error(`Firefox fixture branch OID mismatch: ${remoteBranch.oid} != ${remoteGit.committedOid}`);
    }
    const remoteGitReadyMs = hostNowMs() - startedAt;
    const before = kernelIdentityFromReply(await call(driver, { type: 'state/get' }));
    if (!before) throw new Error('Firefox kernel generation missing before discard');

    const extensionHandle = await driver.windowHandle();
    const survivor = await driver.newWindow('tab');
    await driver.switchToWindow(survivor.handle);
    await driver.navigate('about:blank');
    await driver.switchToWindow(extensionHandle);
    await driver.closeWindow();
    await driver.switchToWindow(survivor.handle);
    await sleep(EVENT_PAGE_IDLE_MS);
    const recycleWakeStartedMs = hostNowMs() - startedAt;
    await driver.navigate(PANEL_URL);
    const afterReply = await waitFor(async () => {
      const reply = await call(driver, { type: 'state/get' });
      const identity = kernelIdentityFromReply(reply);
      return identity && identity.bootId !== before.bootId
        && identity.kernelEpoch !== before.kernelEpoch ? { reply, identity } : null;
    }, { budgetMs: 90_000, pollMs: 200 });
    if (!afterReply) throw new Error('Firefox event page did not claim a fresh generation');
    const finalUi = await waitFor(async () => {
      const ui = await uiSnapshot(driver);
      return ui.stage === 'app-ready' && ui.appShell && ui.rootVisible && !ui.failure ? ui : null;
    }, { budgetMs: 60_000, pollMs: 100 });
    if (!finalUi) throw new Error('Firefox panel did not recover after event-page discard');
    const secondText = 'Firefox controller message after event-page discard';
    const second = await call(driver, { type: 'agent/send', text: secondText });
    const controllerRecovered = second?.ok === true
      && !!(await waitForControllerReply(driver, secondText, fixture, 2));
    const appGitPersisted = await verifyAppGit(driver, appGit.appId, { cleanup: false });
    const remoteGitPersisted = await verifyRemoteAppGit(driver, appGit.appId, {
      host: GIT_FIXTURE_HOST,
      committedOid: remoteGit.committedOid,
    });
    if (remoteGitPersisted?.ok !== true) {
      throw new Error(`Firefox remote App/Git did not survive recycle: ${JSON.stringify(remoteGitPersisted)}`);
    }
    const remoteGitFixture = gitFixture.snapshot();
    assertExactGitFixtureRequests(remoteGitFixture.summary);
    const dweb = await call(driver, { type: 'dweb/base/status' });
    const recycleReadyMs = hostNowMs() - startedAt;
    const screenshotPath = join(dirname(reportPath), 'firefox-production-cutover.png');
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(screenshotPath, Buffer.from(await driver.screenshot(), 'base64'));
    const postRun = {
      artifact: { sha256: await sha256File(artifactPath), bytes: statSync(artifactPath).size },
      tree: await digestTree(treePath),
    };
    const report = {
      schema: 2, ok: true, bindings, postRun,
      budgets: FIREFOX_CUTOVER_HANG_CEILINGS,
      timings: {
        clock: 'host-monotonic-ms', ctaMs, submitMs, vaultCommitMs, panelReadyMs,
        controllerFirstMessageMs, appGitReadyMs, remoteGitReadyMs,
        recycleWakeStartedMs, recycleReadyMs,
        completeMs: hostNowMs() - startedAt,
        eventPageIdleMs: EVENT_PAGE_IDLE_MS,
      },
      observations: {
        cutover,
        cta: { actionable: true, kind: 'passphrase', ...actionable },
        vault: state.state.vault,
        homeReady,
        controllerFirstMessage: { completionCalls: firstControllerCompletionCalls },
        appGit,
        remoteGit: { ...remoteGit, remoteBranch },
        remoteGitFixture: {
          bindingSha256: bindings.gitFixture.sha256,
          ...remoteGitFixture,
        },
        recycle: {
          before, after: afterReply.identity, newGeneration: true,
          controllerRecovered, appGitPersisted: appGitPersisted.ok === true,
          controllerCompletionCalls: fixture.completionCalls(),
          appGitPersistence: appGitPersisted,
          remoteGitPersisted: remoteGitPersisted.ok === true,
          remoteGitPersistence: remoteGitPersisted,
        },
        dweb,
        finalUi,
        screenshot: { path: relative(sourceRoot, screenshotPath), sha256: await sha256File(screenshotPath) },
      },
    };
    assertSecretlessGitReport(report, gitCredential);
    assertFirefoxProductionReport(report);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    const terminal = driver ? await uiSnapshot(driver).catch(() => null) : null;
    const postRun = await Promise.all([
      sha256File(artifactPath), digestTree(treePath),
    ]).then(([sha256, tree]) => ({ artifact: { sha256 }, tree })).catch(() => null);
    if (error && typeof error === 'object') {
      const failure = /** @type {Error & {firefoxProductionEvidence?:unknown}} */ (error);
      const credential = gitFixture.credential();
      if (typeof failure.message === 'string') {
        failure.message = redactGitFixtureCredential(failure.message, credential);
      }
      if (typeof failure.stack === 'string') {
        failure.stack = redactGitFixtureCredential(failure.stack, credential);
      }
      failure.firefoxProductionEvidence = { bindings, postRun, terminal };
    }
    throw error;
  } finally {
    await driver?.close();
    await fixture?.close().catch(() => {});
    await gitFixture.close().catch(() => {});
  }
}

if (import.meta.main) {
  const artifactRoot = process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
    ? resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT) : ARTIFACTS_DIR;
  const reportPath = process.env.PEERD_ACCEPTANCE_REPORT_PATH
    ? resolve(process.env.PEERD_ACCEPTANCE_REPORT_PATH)
    : join(artifactRoot, 'e2e', 'firefox-production-cutover.json');
  try {
    console.log(JSON.stringify(await runFirefoxProductionCutover({
      sourceRoot: process.env.PEERD_ACCEPTANCE_SOURCE_ROOT
        ? resolve(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT) : REPO_ROOT,
      artifactRoot,
      reportPath,
    }), null, 2));
  } catch (error) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(join(dirname(reportPath), 'firefox-production-cutover-failure.json'),
      `${JSON.stringify({
        schema: 2, ok: false, error: error?.stack || String(error),
        evidence: error?.firefoxProductionEvidence ?? null,
      }, null, 2)}\n`);
    throw error;
  }
}
