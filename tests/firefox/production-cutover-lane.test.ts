import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import { FIREFOX_BACKGROUND_ENTRY } from '../../packaging/gen-manifest.ts';
import {
  assertFirefoxProductionReport,
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
const valid = () => ({
  schema: 2,
  ok: true,
  bindings: {
    channel: 'store', browser: 'firefox',
    artifact: { sha256: digest, bytes: 10 },
    tree: { sha256: digest, bytes: 20, files: 3 },
    manifest: { sha256: digest, backgroundEntry: FIREFOX_BACKGROUND_ENTRY },
    harness: { sha256: digest },
    gitFixture: gitBinding,
    runtimeIdentity: {
      pinned: true,
      expected: { firefox: '153.0', geckodriver: '0.37.1' },
      actual: { firefox: '153.0', geckodriver: '0.37.1' },
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
    panelReadyMs: 130, controllerFirstMessageMs: 140, appGitReadyMs: 150,
    remoteGitReadyMs: 160,
    recycleWakeStartedMs: 200, recycleReadyMs: 210,
  },
  observations: {
    cutover: completeLiveKernelAssemblyFixture('store-firefox'),
    cta: {
      actionable: true, rootVisible: true, formVisible: true, submitEnabled: true,
    },
    vault: { initialized: true, locked: false },
    controllerFirstMessage: { completionCalls: 1 },
    appGit: { ok: true, payload: { ok: true } },
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
        path: `/cutover.git/${kind.includes('info') ? 'info/refs' : `git-${kind}`}`,
        requestBytes: method === 'POST' ? 10 : 0,
      })),
    },
    recycle: {
      newGeneration: true, controllerRecovered: true, appGitPersisted: true,
      controllerCompletionCalls: 2,
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
  },
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
    rejects((report) => { report.observations.recycle.controllerCompletionCalls = 3; },
      /event-page continuity/);
    rejects((report) => { report.observations.appGit.payload.ok = false; },
      /semantic\/App Git/);
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
      report.timings.appGitReadyMs = 30_140;
      report.timings.remoteGitReadyMs = 30_150;
      report.timings.recycleReadyMs = 30_200;
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
    expect(source).toContain('browserAppGitProbe.toString()');
    expect(source).toContain('browserVerifyAcceptanceAppPayload.toString()');
    expect(source).toContain('browserRemoteAppGitProbe.toString()');
    expect(source).toContain('startGitSmartHttpFixture()');
    expect(source).toContain('FIREFOX_CUTOVER_HANG_CEILINGS');
    expect(source).toContain('rootRect.width <= 0');
    expect(source).not.toContain('generateManifest');
    expect(source).not.toContain("manifest.background =");
  });
});
