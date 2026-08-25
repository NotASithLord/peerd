import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertFeatureLeaseDwebReport, FEATURE_LEASE_DWEB_BUDGETS,
} from '../../scripts/cdp/feature-lease-dweb-lifecycle.mjs';
import {
  completeLiveKernelAssemblyFixture,
} from '../../scripts/acceptance/live-kernel-assembly.mjs';

const digest = 'a'.repeat(64);
const report = () => ({
  schema: 2,
  ok: true,
  bindings: {
    channel: 'preview',
    browser: 'chrome',
    artifact: { sha256: digest, bytes: 100 },
    tree: { sha256: digest, bytes: 200, files: 10 },
    harness: { sha256: digest },
    manifest: { sha256: digest, backgroundEntry: 'background/vault-kernel-preview.js' },
    browserIdentity: {
      expectedVersion: '151.0.7922.47', actualVersion: '151.0.7922.47',
      sha256: digest, bytes: 100,
    },
  },
  postRun: {
    artifact: { sha256: digest, bytes: 100 },
    tree: { sha256: digest, bytes: 200, files: 10 },
  },
  observations: {
    cutover: completeLiveKernelAssemblyFixture('preview-chrome'),
    ui: { before: { stage: 'app-ready' }, after: { stage: 'app-ready' } },
    vault: { initialized: true, locked: false },
    worker: {
      newTarget: true, newKernel: true, versionId: 'version-a', stoppedRunningStatus: 'stopped',
    },
    continuity: {
      before: {
        contexts: [{}], hostEpoch: 'host-a', kernelEpoch: 'kernel-a', dwebLeases: 1,
        meshCount: 1, meshGeneration: 1, did: 'did:a',
      },
      after: {
        contexts: [{}], hostEpoch: 'host-a', kernelEpoch: 'kernel-b', dwebLeases: 1,
        meshCount: 1, meshGeneration: 1, did: 'did:a',
        retainedRoom: true, discoveryReadable: true,
      },
      renderer: {
        contexts: [{}], priorHostEpoch: 'host-a', hostEpoch: 'host-b',
        kernelEpoch: 'kernel-b', dwebLeases: 1, meshCount: 1, meshGeneration: 1,
        did: 'did:a', roomRejoined: true, discoveryReadable: true,
        servedAppInstalled: true,
      },
    },
    teardown: { disabledContexts: 0, lockedContexts: 0, vaultLocked: true },
    inputsImmutable: true,
  },
  budgets: { ...FEATURE_LEASE_DWEB_BUDGETS },
  timings: {
    clock: 'host-monotonic-ms', appReadyMs: 10, dwebReadyMs: 20,
    recycleStartedMs: 30, recycleReadyMs: 40,
    rendererCloseStartedMs: 50, rendererReadyMs: 60,
    disableStartedMs: 70, disableColdMs: 80, reenabledReadyMs: 90,
    lockStartedMs: 100, lockColdMs: 110,
  },
});

describe('packaged Preview dweb feature-lease contract', () => {
  test('accepts only exact archive-bound, two-generation continuity evidence', () => {
    expect(assertFeatureLeaseDwebReport(report())).toBeTruthy();
    for (const mutate of [
      (value: any) => { value.bindings.channel = 'store'; },
      (value: any) => { value.bindings.manifest.backgroundEntry = ''; },
      (value: any) => { value.observations.cutover.semantic.ready = false; },
      (value: any) => { value.observations.cutover.target.selfHostedChrome = false; },
      (value: any) => { value.observations.cutover.events.splice(2, 0, value.observations.cutover.events[2]); },
      (value: any) => { value.observations.cutover.ports[5].required = false; },
      (value: any) => { value.observations.cutover.semantic.migrated = 159; },
      (value: any) => { value.observations.continuity.after.hostEpoch = 'host-b'; },
      (value: any) => { value.observations.continuity.after.kernelEpoch = 'kernel-a'; },
      (value: any) => { value.observations.continuity.after.dwebLeases = 2; },
      (value: any) => { value.observations.continuity.after.meshCount = 2; },
      (value: any) => { value.observations.continuity.after.meshGeneration = 2; },
      (value: any) => { value.observations.continuity.after.retainedRoom = false; },
      (value: any) => { value.observations.continuity.renderer.hostEpoch = 'host-a'; },
      (value: any) => { value.observations.continuity.renderer.roomRejoined = false; },
      (value: any) => { value.observations.continuity.renderer.servedAppInstalled = false; },
      (value: any) => { value.observations.teardown.lockedContexts = 1; },
      (value: any) => { value.observations.worker.stoppedRunningStatus = 'running'; },
      (value: any) => { value.observations.worker.stoppedRunningStatus = undefined; },
      (value: any) => { value.timings.recycleReadyMs = 1000; },
      (value: any) => { value.budgets.recycleMs += 1; },
      (value: any) => { value.budgets.extraMs = 1; },
      (value: any) => { delete value.budgets.teardownMs; },
      (value: any) => { value.observations.inputsImmutable = false; },
      (value: any) => { value.postRun.tree.sha256 = 'b'.repeat(64); },
    ]) {
      const candidate = structuredClone(report());
      mutate(candidate);
      expect(() => assertFeatureLeaseDwebReport(candidate)).toThrow();
    }
  });

  test('uses the physical packaged lane and authoritative MV3 stop boundary', () => {
    const source = readFileSync(join(
      REPO_ROOT, 'scripts', 'cdp', 'feature-lease-dweb-lifecycle.mjs',
    ), 'utf8');
    expect(source).toContain("channel: 'preview', browser: 'chrome'");
    expect(source).toContain('PRODUCTION_PREVIEW_CHROME_BACKGROUND_ENTRY');
    expect(source).toContain('verify: true');
    expect(source).toContain('expectedBackgroundEntry: backgroundEntry');
    expect(source).toContain('ctx.stopServiceWorker()');
    expect(source).toContain('chrome.offscreen.closeDocument()');
    expect(source).toContain("type: 'feature-lease/host-status'");
    expect(source).toContain("contextTypes: ['OFFSCREEN_DOCUMENT']");
    expect(source).toContain("type: 'dweb/base/share-app'");
    expect(source).toContain("'install-app'");
    expect(source).toContain('verifyPackagedAcceptanceAppPayload');
    expect(source).toContain("'history'");
    expect(source).toContain('stoppedRunningStatus');
    expect(source).toContain('meshGeneration');
    expect(source).toContain("clock: 'host-monotonic-ms'");
    expect(source).toContain('immutableInputs(beforeInputs, afterInputs)');
    expect(source).not.toContain('Target.closeTarget');
    expect(source).not.toContain('run-dweb-twopeer');
  });
});
