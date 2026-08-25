import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import { FIREFOX_BACKGROUND_ENTRY } from '../../packaging/gen-manifest.ts';
import {
  assertFirefoxProductionReport, controllerNowReceiptFromState,
  createNowCompletionResponder, sanitizeFirefoxFailureEvidence,
} from '../../scripts/firefox/production-cutover-lane.mjs';
import {
  completeLiveKernelAssemblyFixture,
} from '../../scripts/acceptance/live-kernel-assembly.mjs';
import { buildGitFixtureBinding } from '../../scripts/acceptance/git-smart-http-fixture.mjs';

const digest = 'a'.repeat(64);
const gitBinding = buildGitFixtureBinding({
  gitVersion: 'git version 2.45.2',
  certificateSha256: digest,
  protocolSha256: digest,
});
const nowContent = (unixMs: number) => JSON.stringify({
  iso: new Date(unixMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), unixMs,
  timezone: 'Asia/Hong_Kong', dayOfWeek: 'Sunday',
});
const nowReceipt = (completionCalls: number, unixMs = 1_778_000_000_000) => ({
  ok: true, tool: 'now', primitive: 'time', inputKeys: 0, outcomeKnown: true,
  ...JSON.parse(nowContent(unixMs)), completionCalls,
  resultDigest: createHash('sha256').update(nowContent(unixMs)).digest('hex'),
});
const surface = (kind: string, pathname: string, target: string | null = null) => ({
  kind, url: `moz-extension://7d12f198-31fc-4e95-9184-e954123981b6${pathname}`, pathname,
  runtimeId: 'peerd@peerd.ai', readyState: 'complete', ready: true,
  rootVisible: true, shell: true, target,
});
const modelWire = (receipts: Record<string, any>) => [
  ['initial', 1], ['warm', 3], ['afterIdleContinuity', 5], ['afterEventPageIdle', 7],
].flatMap(([name, completionCall], index) => {
  const toolCallIdDigest = String(index + 1).repeat(64);
  return [
    { completionCall, toolCallIssued: true, toolCallIdDigest },
    {
      completionCall: Number(completionCall) + 1,
      toolResultAccepted: true, toolCallIdMatched: true, nowResultValid: true,
      toolCallIdDigest, resultDigest: receipts[String(name)].resultDigest,
    },
  ];
});
const valid = () => ({
  schema: 2,
  ok: true,
  bindings: {
    channel: 'store', browser: 'firefox',
    artifact: { sha256: digest, bytes: 10 },
    tree: { sha256: digest, bytes: 20, files: 3 },
    manifest: {
      sha256: digest, backgroundEntry: FIREFOX_BACKGROUND_ENTRY,
      appSandbox: true, firefoxMinVersion: '154.0',
    },
    harness: { sha256: digest },
    gitFixture: gitBinding,
    runtimeIdentity: {
      pinned: true,
      expected: { firefox: '154.0', geckodriver: '0.37.1' },
      actual: { firefox: '154.0', geckodriver: '0.37.1' },
      binaries: {
        firefox: { sha256: digest }, geckodriver: { sha256: digest },
      },
    },
  },
  postRun: {
    artifact: { sha256: digest, bytes: 10 },
    tree: { sha256: digest, bytes: 20, files: 3 },
  },
  budgets: {
    ctaMs: 180_000, vaultCommitAfterSubmitMs: 120_000,
    panelAfterVaultMs: 60_000, controllerMs: 30_000,
    repositoryMs: 30_000, recycleAfterIdleMs: 150_000,
  },
  timings: {
    clock: 'host-monotonic-ms', ctaMs: 100, submitMs: 110, vaultCommitMs: 120,
    panelReadyMs: 130, controllerFirstMessageMs: 140, controllerWarmMessageMs: 150,
    appGitReadyMs: 160, remoteGitReadyMs: 170,
    controllerIdleStartedMs: 170, controllerContinuityWakeStartedMs: 30_170,
    controllerAfterIdleMs: 30_180, eventPageIdleStartedMs: 30_190,
    recycleWakeStartedMs: 75_190, controllerAfterEventPageIdleMs: 75_200,
    recycleReadyMs: 75_210,
  },
  observations: (() => {
    const controllerTools = {
      initial: nowReceipt(2), warm: nowReceipt(4, 1_778_000_000_100),
      afterIdleContinuity: nowReceipt(6, 1_778_000_030_200),
      afterEventPageIdle: nowReceipt(8, 1_778_000_075_300),
    };
    return {
    cutover: completeLiveKernelAssemblyFixture('store-firefox'),
    cta: {
      actionable: true, rootVisible: true, formVisible: true, submitEnabled: true,
    },
    vault: { initialized: true, locked: false },
    surfaces: {
      home: surface('home', '/home/home.html'),
      options: surface('options', '/options/options.html'),
      app: surface('app', '/engine-tabs/app-tab/index.html', 'app-1'),
      sidebar: surface('sidebar', '/sidepanel/sidepanel.html'),
      sidebarRecovered: surface('sidebar', '/sidepanel/sidepanel.html'),
    },
    modelWire: modelWire(controllerTools),
    controllerTools,
    appGit: {
      ok: true, appId: 'app-1', payload: { ok: true },
      isolation: {
        ok: true, opaqueOrigin: true, browserAbsent: true, chromeAbsent: true,
        inlineExecuted: true, fetchBlocked: true, webSocketBlocked: true,
        rtcSealed: true, dnrRuleInstalled: true, dnrTabScoped: true,
      },
    },
    remoteGit: {
      ok: true, phase: 'complete', credentialStored: true, remoteLinked: true,
      pushed: true, fetched: true, host: 'git-fixture.peerd.test',
      branch: 'acceptance/cutover', committedOid: 'a'.repeat(40),
      cleanClone: {
        ok: true,
        payload: { ok: true, textOk: true, binaryOk: true, fileCount: 4 },
        proofOk: true, oid: 'a'.repeat(40), historyContainsCommit: true,
      },
      remoteBranch: {
        branch: 'acceptance/cutover', oid: 'a'.repeat(40),
        files: {
          'index.html': digest, 'src/main.js': digest, 'assets/raw.bin': digest,
          'acceptance/remote-proof.txt': digest,
        },
      },
    },
    remoteGitFixture: {
      bindingSha256: gitBinding.sha256, schema: 1,
      summary: {
        receiveInfoRefs: 1, receivePack: 1,
        uploadInfoRefs: 3, uploadPack: 3, total: 8,
      },
      requests: [
        ['GET', 'receive-info-refs'], ['POST', 'receive-pack'],
        ['GET', 'upload-info-refs'], ['POST', 'upload-pack'],
        ['GET', 'upload-info-refs'], ['POST', 'upload-pack'],
        ['GET', 'upload-info-refs'], ['POST', 'upload-pack'],
      ].map(([method, kind], index) => ({
        sequence: index + 1, method, kind, authenticated: true,
        path: `/acceptance/cutover.git/${kind.includes('info') ? 'info/refs' : `git-${kind}`}`,
        requestBytes: method === 'POST' ? 10 : 0,
      })),
    },
    recycle: {
      newGeneration: true, controllerRecovered: true, appGitPersisted: true,
      controllerCompletionCalls: 8,
      appGitPersistence: { payload: { ok: true } },
      remoteGitPersisted: true,
      remoteGitPersistence: {
        ok: true, phase: 'complete', host: 'git-fixture.peerd.test', fetched: true,
        oid: 'a'.repeat(40), historyContainsCommit: true, credentialRetained: true,
        cleanup: { appRemoved: true, credentialRemoved: true, credentialAbsent: true },
      },
    },
    dweb: { ok: false, error: 'dweb-disabled' },
    screenshot: { path: 'artifacts/firefox-production-cutover.png', sha256: digest },
    finalUi: {
      stage: 'app-ready', rootVisible: true, rootTextLength: 20, failure: false,
    },
  }; })(),
});

const rejects = (mutate: (report: any) => void, expected: RegExp) => {
  const report = valid();
  mutate(report);
  expect(() => assertFirefoxProductionReport(report)).toThrow(expected);
};

describe('installed Firefox production cutover lane', () => {
  test('accepts an artifact/runtime-bound passphrase/controller/App/recycle report', () => {
    expect(assertFirefoxProductionReport(valid())).toBeTruthy();
  });

  test('rejects legacy workers, mutation, blank UI, and censored continuity', () => {
    rejects((report) => { report.budgets.ctaMs += 1; }, /budget profile/);
    rejects((report) => { report.budgets.unreviewedHeadroomMs = 1; }, /budget profile/);
    rejects((report) => {
      report.bindings.manifest.backgroundEntry = 'background/service-worker.js';
    }, /production background entry/);
    rejects((report) => { report.postRun.tree.sha256 = 'b'.repeat(64); }, /artifact mutation/);
    rejects((report) => { report.observations.finalUi.rootTextLength = 0; },
      /nonblank app terminal/);
    rejects((report) => { report.observations.recycle.controllerRecovered = false; },
      /event-page continuity/);
    rejects((report) => { report.observations.recycle.controllerCompletionCalls = 9; },
      /event-page continuity/);
    rejects((report) => { report.observations.controllerTools.warm.tool = 'wait_until'; },
      /warm now controller receipt/);
    rejects((report) => { report.observations.modelWire[1].toolCallIdMatched = false; },
      /initial model tool-result proof/);
    rejects((report) => { report.observations.modelWire[1].resultDigest = digest; },
      /initial model tool-result proof/);
    rejects((report) => { report.observations.surfaces.options.pathname = '/home/home.html'; },
      /options surface provenance/);
    rejects((report) => { report.observations.surfaces.app.target = 'wrong-app'; },
      /app surface provenance/);
    rejects((report) => { report.observations.appGit.payload.ok = false; },
      /semantic\/App Git/);
    rejects((report) => { report.observations.appGit.isolation.rtcSealed = false; },
      /semantic\/App Git/);
    rejects((report) => { report.bindings.manifest.appSandbox = false; },
      /packaged App sandbox/);
    rejects((report) => { report.observations.remoteGit.cleanClone.proofOk = false; },
      /remote App\/isomorphic-git/);
    rejects((report) => { report.observations.remoteGit.unreviewed = true; },
      /remote Git report shape/);
    rejects((report) => { report.observations.remoteGitFixture.requests.pop(); },
      /snapshot shape/);
    rejects((report) => { report.observations.remoteGitFixture.requests[0].kind = 'upload-pack'; },
      /request cardinality|request order/);
    rejects((report) => { report.observations.secret = { authorization: 'Basic leaked' }; },
      /credential material/);
    rejects((report) => {
      report.bindings.gitFixture = {
        ...report.bindings.gitFixture, gitVersion: 'git version 9.9.9',
      };
    }, /binding digest mismatch/);
    rejects((report) => { report.observations.cutover.incompletePorts = ['eval']; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.target.firefox = false; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.ports.push({}); },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.semantic.unavailable = 1; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.screenshot.sha256 = ''; },
      /screenshot binding/);
    rejects((report) => { report.observations.dweb.error = 'message-timeout'; },
      /Firefox dweb posture/);
    rejects((report) => { report.bindings.runtimeIdentity.pinned = false; },
      /pinned runtime identity/);
    rejects((report) => { report.observations.cta.formVisible = false; },
      /passphrase commit/);
    rejects((report) => {
      report.timings.controllerFirstMessageMs = 30_131;
      report.timings.controllerWarmMessageMs = 30_140;
      report.timings.appGitReadyMs = 30_150;
      report.timings.remoteGitReadyMs = 30_160;
      report.timings.controllerIdleStartedMs = 30_160;
      report.timings.controllerContinuityWakeStartedMs = 60_160;
      report.timings.controllerAfterIdleMs = 60_170;
      report.timings.eventPageIdleStartedMs = 60_180;
      report.timings.recycleWakeStartedMs = 105_180;
      report.timings.controllerAfterEventPageIdleMs = 105_190;
      report.timings.recycleReadyMs = 105_200;
    }, /controller hang ceiling/);
  });

  test('source drives installed Store XPI and never substitutes a test-only manifest', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'scripts/firefox/production-cutover-lane.mjs'), 'utf8',
    );
    expect(source).toContain("channel: 'store', browser: 'firefox'");
    expect(source).toContain('driver.installAddon(artifactPath)');
    expect(source).toContain('backgroundEntry !== FIREFOX_BACKGROUND_ENTRY');
    expect(source).toContain('EVENT_PAGE_IDLE_MS = 45_000');
    expect(source).toContain('CONTROLLER_IDLE_CONTINUITY_MS = 30_000');
    expect(source).toContain("sseToolCall('now', {})");
    expect(source).toContain('controllerNowReceiptFromState');
    expect(source).toContain('browserVerifyAcceptanceAppPayload.toString()');
    expect(source).toContain("await navigateMain(driver, handle, OPTIONS_URL, 'options')");
    expect(source).toContain("await call(sender, { type: 'apps/open', appId })");
    expect(source).not.toContain("document.title === 'peerd ·");
    expect(source).toContain('startGitSmartHttpFixture()');
    expect(source).toContain('FIREFOX_CUTOVER_HANG_CEILINGS');
    expect(source).toContain('rootRect.width <= 0');
    expect(source).toContain('SidebarController.show(id)');
    expect(source).toContain('SidebarController.hide()');
    expect(source).toContain("getActor('MarionetteCommands')");
    expect(source).toContain('BrowsingContext.get(id)');
    expect(source).not.toContain('await driver.navigate(PANEL_URL)');
    expect(source).not.toContain('generateManifest');
    expect(source).not.toContain("manifest.background =");
    expect(source).not.toContain("join(tree, 'offscreen', 'controller-runtime.js')");
  });

  test('recognizes only a settled real now receipt followed by model-visible completion', () => {
    const text = 'now through controller';
    const unixMs = 1_778_000_000_000;
    const reply = {
      state: { session: { messages: [
        { role: 'user', content: text },
        { role: 'assistant', toolUses: [{ id: 'tool-1', name: 'now', input: {} }] },
        { role: 'user', content: '', toolResults: [{
          tool_use_id: 'tool-1', is_error: false,
          content: nowContent(unixMs),
          meta: { toolName: 'now', primitive: 'time' },
        }] },
        { role: 'assistant', content: 'production-controller-first-message-ok' },
      ] } },
    };
    expect(controllerNowReceiptFromState(reply, text, 2)).toEqual(nowReceipt(2, unixMs));
    const toolResult = reply.state.session.messages[2]?.toolResults?.[0];
    if (!toolResult) throw new Error('fixture tool result missing');
    toolResult.meta.toolName = 'wait_until';
    expect(controllerNowReceiptFromState(reply, text, 2)).toBeNull();
  });

  test('returns a final model answer only for the exact prior now tool result', () => {
    const respond = createNowCompletionResponder();
    const first = respond({ completionCall: 1, requestBody: {} });
    const toolCall = String(first.body).split('\n').flatMap((line) => {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
      return [JSON.parse(line.slice(6))?.choices?.[0]?.delta?.tool_calls?.[0]];
    }).find(Boolean);
    const content = nowContent(1_778_000_000_000);
    const second = respond({
      completionCall: 2,
      requestBody: { messages: [
        { role: 'assistant', tool_calls: [toolCall] },
        { role: 'tool', tool_call_id: toolCall.id, content },
      ] },
    });
    expect(second.status).toBeUndefined();
    expect(second.proof).toMatchObject({
      completionCall: 2, toolResultAccepted: true,
      toolCallIdMatched: true, nowResultValid: true,
    });
    expect(JSON.stringify(second.proof)).not.toContain(content);

    const reject = createNowCompletionResponder();
    const issued = reject({ completionCall: 1, requestBody: {} });
    const issuedCall = String(issued.body).split('\n').flatMap((line) => {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return [];
      return [JSON.parse(line.slice(6))?.choices?.[0]?.delta?.tool_calls?.[0]];
    }).find(Boolean);
    const refused = reject({
      completionCall: 2,
      requestBody: { messages: [
        { role: 'assistant', tool_calls: [issuedCall] },
        { role: 'tool', tool_call_id: 'wrong-id', content },
      ] },
    });
    expect(refused.status).toBe(422);
    expect((refused.proof as { toolResultAccepted: boolean }).toolResultAccepted).toBe(false);
  });

  test('redacts and secret-scans the complete Firefox failure evidence', () => {
    const credential = {
      token: 'fixture-token', authorization: 'Basic fixture-authorization',
    };
    const evidence = sanitizeFirefoxFailureEvidence({
      terminal: { body: 'fixture-token' },
      consoleMessages: [{ message: 'Basic fixture-authorization' }],
    }, credential);
    expect(JSON.stringify(evidence)).not.toContain(credential.token);
    expect(JSON.stringify(evidence)).not.toContain(credential.authorization);
  });
});
