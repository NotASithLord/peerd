import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertPasskeySignupReport, PRODUCTION_BACKGROUND_ENTRY,
  PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY,
} from '../../scripts/cdp/passkey-signup-lane.mjs';
import {
  identifyPeerdBackgroundTarget, normalizeAcceptanceProxyServer,
} from '../../scripts/cdp/e2e-harness.mjs';
import {
  ACCEPTANCE_REPLY, startOllamaAcceptanceFixture,
} from '../../scripts/cdp/product-acceptance-probes.mjs';
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
const validReport = () => ({
  schema: 3,
  ok: true,
  bindings: {
    channel: 'store',
    browser: 'chrome',
    artifact: { sha256: digest, bytes: 10 },
    tree: { sha256: digest, bytes: 20, files: 3 },
    manifest: {
      sha256: digest,
      backgroundEntry: PRODUCTION_BACKGROUND_ENTRY,
    },
    browserIdentity: {
      sha256: digest,
      expectedVersion: '151.0.7922.47',
      actualVersion: '151.0.7922.47',
    },
    harness: { sha256: digest, files: 4 },
    gitFixture: gitBinding,
  },
  postRun: {
    artifact: { sha256: digest, bytes: 10 },
    tree: { sha256: digest, bytes: 20, files: 3 },
  },
  budgets: {
    startupMs: 180_000, afterClickMs: 30_000, controllerMs: 30_000,
    repositoryMs: 30_000, recycleMs: 60_000,
  },
  timings: {
    clock: 'host-monotonic-ms',
    staticShellPaintedMs: 100,
    bootModuleEvaluatedMs: 110,
    ctaEnabledMs: 120,
    clickMs: 130,
    authenticatorReturnMs: 140,
    durableVaultCommitMs: 150,
    richAppReadyMs: 160,
    controllerFirstMessageMs: 170,
    appGitReadyMs: 180,
    remoteGitReadyMs: 185,
    recycleReadyMs: 190,
  },
  observations: {
    cutover: completeLiveKernelAssemblyFixture('store-chrome'),
    authenticatorReturnObserved: true,
    durableVaultCommitted: true,
    inputsImmutable: true,
    controllerFirstMessage: { completionCalls: 1 },
    commandOpen: { openedContexts: 1, closed: true },
    coldLocked: { offscreenContexts: [] },
    semanticHost: {
      offscreenContexts: [{
        contextType: 'OFFSCREEN_DOCUMENT',
        documentUrl: `chrome-extension://${'a'.repeat(32)}/offscreen/offscreen.html`,
      }],
    },
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
    coldRecycle: {
      oldWorker: { versionId: 'version-1', stoppedRunningStatus: 'stopped' },
      newWorker: true, newGeneration: true, controllerRecovered: true, appGitPersisted: true,
      controllerRecovery: { completionCalls: 2 },
      appGitPersistence: { payload: { ok: true } },
      remoteGitPersisted: true,
      remoteGitPersistence: {
        ok: true, phase: 'complete', host: 'git-fixture.peerd.test', fetched: true,
        oid: 'a'.repeat(40), historyContainsCommit: true, credentialRetained: true,
        cleanup: { appRemoved: true, credentialRemoved: true, credentialAbsent: true },
      },
      recycledUi: { stage: 'app-ready', appShell: true, failure: false },
    },
    dweb: { status: 'pruned-by-target-policy' },
    stageTrace: ['vault-ready', 'app-loading', 'app-ready'],
    finalUi: {
      stage: 'app-ready', rootVisible: true, rootTextLength: 20,
      appShell: true, gate: false, failure: false, spinnerTerminal: false,
    },
  },
});

const rejects = (mutate: (report: any) => void, message: RegExp) => {
  const report = validReport();
  mutate(report);
  expect(() => assertPasskeySignupReport(report)).toThrow(message);
};

describe('packaged first-install passkey lane', () => {
  test('accepts an exact Store-bound host-monotonic completion report', () => {
    expect(assertPasskeySignupReport(validReport())).toBeTruthy();
  });

  test('rejects unbound, mismatched, and cross-clock evidence', () => {
    rejects((report) => { report.bindings.artifact.sha256 = ''; }, /artifact digest/);
    rejects((report) => { report.bindings.browserIdentity.actualVersion = '151.0.0.0'; },
      /browser version/);
    rejects((report) => { report.timings.clock = 'page-performance-now'; }, /clock/);
    rejects((report) => {
      report.bindings.manifest.backgroundEntry = 'background/service-worker.js';
    }, /production background entry/);
    rejects((report) => { report.postRun.artifact.sha256 = 'b'.repeat(64); },
      /artifact mutated during run/);
    rejects((report) => { report.postRun.tree.bytes += 1; }, /staged tree mutated during run/);
    rejects((report) => { report.observations.coldLocked.offscreenContexts.push({}); },
      /eager cold offscreen host/);
    rejects((report) => { report.observations.semanticHost.offscreenContexts = []; },
      /lazy semantic host/);
    rejects((report) => { report.observations.cutover.cutoverReady = false; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.counts.requiredEvents -= 1; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.events.pop(); },
      /complete live kernel assembly/);
    rejects((report) => {
      report.observations.cutover.events[0].key = 'runtime.onInvented';
    }, /complete live kernel assembly/);
    rejects((report) => { report.observations.cutover.semantic.total = 159; },
      /complete live kernel assembly/);
    rejects((report) => { report.observations.coldRecycle.recycledUi.appShell = false; },
      /cold recycle continuity/);
    rejects((report) => { report.observations.appGit.payload.ok = false; },
      /App\/isomorphic-git probe/);
    rejects((report) => { report.observations.remoteGit.cleanClone.proofOk = false; },
      /remote App\/isomorphic-git probe/);
    rejects((report) => { report.observations.remoteGit.unreviewed = true; },
      /remote Git report shape/);
    rejects((report) => { report.observations.remoteGitFixture.summary.uploadPack = 2; },
      /request cardinality/);
    rejects((report) => { report.observations.remoteGitFixture.requests[0].authenticated = false; },
      /request ledger/);
    rejects((report) => {
      [report.observations.remoteGitFixture.requests[0],
        report.observations.remoteGitFixture.requests[1]] = [
        report.observations.remoteGitFixture.requests[1],
        report.observations.remoteGitFixture.requests[0],
      ];
      report.observations.remoteGitFixture.requests.forEach(
        (entry: any, index: number) => { entry.sequence = index + 1; },
      );
    }, /request order/);
    rejects((report) => {
      report.bindings.gitFixture = { ...report.bindings.gitFixture, sha256: '' };
    }, /gitFixture digest/);
    rejects((report) => {
      report.bindings.gitFixture = {
        ...report.bindings.gitFixture, gitVersion: 'git version 9.9.9',
      };
    }, /binding digest mismatch/);
    rejects((report) => { report.observations.leak = { token: 'fixture-secret' }; },
      /credential material/);
    rejects((report) => { report.observations.coldRecycle.oldWorker.stoppedRunningStatus = 'running'; },
      /authoritative worker stop/);
    rejects((report) => { delete report.observations.coldRecycle.oldWorker.stoppedRunningStatus; },
      /authoritative worker stop/);
    rejects((report) => { report.observations.coldRecycle.controllerRecovery.completionCalls = 3; },
      /cold recycle continuity/);
  });

  test('rejects reordered milestones and breached budgets', () => {
    rejects((report) => { report.budgets.startupMs += 1; }, /budget profile/);
    rejects((report) => { report.budgets.unreviewedHeadroomMs = 1; }, /budget profile/);
    rejects((report) => { report.timings.authenticatorReturnMs = 125; },
      /authenticatorReturnMs/);
    rejects((report) => {
      report.timings.ctaEnabledMs = 180_001;
      report.timings.clickMs = 180_002;
      report.timings.authenticatorReturnMs = 180_003;
      report.timings.durableVaultCommitMs = 180_004;
      report.timings.richAppReadyMs = 180_005;
      report.timings.controllerFirstMessageMs = 180_006;
      report.timings.appGitReadyMs = 180_007;
      report.timings.remoteGitReadyMs = 180_008;
      report.timings.recycleReadyMs = 180_009;
    }, /CTA startup budget/);
    rejects((report) => {
      report.timings.richAppReadyMs = 40_131;
      report.timings.controllerFirstMessageMs = 40_141;
      report.timings.appGitReadyMs = 40_151;
      report.timings.remoteGitReadyMs = 40_156;
      report.timings.recycleReadyMs = 40_161;
    }, /post-click completion budget/);
  });

  test('rejects blank, failed, spinner, and undurable terminal states', () => {
    rejects((report) => { report.observations.finalUi.rootTextLength = 0; }, /blank terminal/);
    rejects((report) => { report.observations.finalUi.failure = true; },
      /failure\/spinner terminal/);
    rejects((report) => { report.observations.finalUi.spinnerTerminal = true; },
      /failure\/spinner terminal/);
    rejects((report) => { report.observations.stageTrace.push('failed'); }, /failed trace/);
  });

  test('source contract packages Store Chrome and uses exact UX markers', () => {
    const lane = readFileSync(join(REPO_ROOT, 'scripts/cdp/passkey-signup-lane.mjs'), 'utf8');
    const harness = readFileSync(join(REPO_ROOT, 'scripts/cdp/e2e-harness.mjs'), 'utf8');
    const probes = readFileSync(join(
      REPO_ROOT, 'scripts/cdp/product-acceptance-probes.mjs',
    ), 'utf8');
    expect(lane).toContain("channel: 'store', browser: 'chrome'");
    expect(lane).toContain("peerdStaticShellPainted !== 'true'");
    expect(lane).toContain("peerdBootModule !== 'evaluated'");
    expect(lane).toContain("peerdBootStage !== 'vault-ready'");
    expect(lane).toContain('Passkey verified. Finishing secure vault setup…');
    expect(lane).toContain("stage === 'app-ready'");
    expect(lane).toContain("clock: 'host-monotonic-ms'");
    expect(lane).toContain('expectedBackgroundEntry: PRODUCTION_BACKGROUND_ENTRY');
    expect(lane).toContain('collectPostRunDigests');
    expect(harness).toContain('process.hrtime.bigint()');
    expect(harness).toContain("page.send('ServiceWorker.stopWorker'");
    expect(harness).toContain("row?.runningStatus === 'stopped'");
    expect(harness).not.toContain("browserConn.send('Target.closeTarget'");
    expect(harness).toContain("Target.setDiscoverTargets");
    expect(harness).toContain("Extensions.triggerAction");
    expect(harness).toContain("entry.type === 'tab'");
    expect(harness).toContain('browser-owned side panel target never appeared');
    expect(harness).toContain("method === 'Target.targetInfoChanged'");
    expect(harness).toContain('blob:chrome-extension://');
    expect(probes).toContain("opened.files?.['assets/raw.bin']");
    expect(probes).toContain('expectedBinary.every');
    expect(probes).toContain("type: 'export/artifact', kind: 'app'");
    expect(probes).toContain("type: 'apps/repository/push'");
    expect(probes).toContain("type: 'apps/import-git'");
    expect(harness).not.toContain('extraChromeFlags');
  });

  test('acceptance proxy seam accepts only loopback numeric ports and one SPKI pin', () => {
    const pin = `${'A'.repeat(43)}=`;
    expect(normalizeAcceptanceProxyServer({
      url: 'http://127.0.0.1:54321', certificateSpkiSha256: pin,
    })).toEqual({ url: 'http://127.0.0.1:54321', certificateSpkiSha256: pin });
    for (const value of [
      { url: 'http://localhost:54321', certificateSpkiSha256: pin },
      { url: 'http://127.0.0.1', certificateSpkiSha256: pin },
      { url: 'http://127.0.0.1:54321/path', certificateSpkiSha256: pin },
      { url: 'http://user@127.0.0.1:54321', certificateSpkiSha256: pin },
      { url: 'https://127.0.0.1:54321', certificateSpkiSha256: pin },
      { url: 'http://127.0.0.1:54321', certificateSpkiSha256: 'bad' },
      { url: 'http://127.0.0.1:54321', certificateSpkiSha256: pin, flags: ['--no-sandbox'] },
    ]) expect(() => normalizeAcceptanceProxyServer(value as any)).toThrow(/acceptance proxy/);
  });

  test('worker discovery identifies every reviewed entry but never another extension worker', () => {
    const target = (entry: string, type = 'service_worker') => ({
      type,
      id: 'target-1',
      url: `chrome-extension://${'a'.repeat(32)}/${entry}`,
      webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/page/target-1',
    });
    expect(identifyPeerdBackgroundTarget(target(PRODUCTION_BACKGROUND_ENTRY))?.entry)
      .toBe(PRODUCTION_BACKGROUND_ENTRY);
    expect(identifyPeerdBackgroundTarget(target(PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY))?.entry)
      .toBe(PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY);
    expect(identifyPeerdBackgroundTarget(target('background/service-worker.js'))).toBeNull();
    expect(identifyPeerdBackgroundTarget(target('background/other.js'))).toBeNull();
    expect(identifyPeerdBackgroundTarget(target(PRODUCTION_BACKGROUND_ENTRY, 'worker'))).toBeNull();
  });

  test('realm-independent Ollama fixture serves one exact streamed controller turn', async () => {
    const fixture = await startOllamaAcceptanceFixture({ port: 0, completionDelayMs: 0 });
    try {
      const tags = await fetch(`${fixture.origin}/api/tags`).then((reply) => reply.json());
      expect(tags.models[0].name).toBe('qwen3:8b');
      const stream = await fetch(`${fixture.origin}/v1/chat/completions`, {
        method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
      }).then((reply) => reply.text());
      expect(stream).toContain(ACCEPTANCE_REPLY);
      expect(fixture.completionCalls()).toBe(1);
    } finally {
      await fixture.close();
    }
  });
});
