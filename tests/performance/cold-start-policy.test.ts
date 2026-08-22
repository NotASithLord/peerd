import { describe, expect, test } from 'bun:test';
import {
  assessColdStartPair,
  assessColdStartReport,
  assessColdStartResult,
  COLD_START_LANES,
  COLD_START_PHASES,
  COLD_START_TARGETS,
  COLD_START_TARGET_CUTOVER,
  LEGACY_PACKAGE_COLD_GRAPH_RATCHETS,
  NATIVE_FLOOR_CONTRACT,
  summarizeRaw,
} from '../../scripts/bench/cold-start-policy.mjs';

const HASH = {
  archive: 'a'.repeat(64), tree: 'b'.repeat(64), browser: 'c'.repeat(64),
  harness: 'd'.repeat(64), host: 'e'.repeat(64), previewArchive: 'f'.repeat(64),
  previewTree: '0'.repeat(64),
};

const graph = (value: { modules: number; graphBytes: number; entryBytes: number }) => ({
  entry: 'entry.js',
  graphModules: value.modules,
  graphBytes: value.graphBytes,
  entryBytes: value.entryBytes,
  graphSha256: '1'.repeat(64),
  entrySha256: '2'.repeat(64),
});

const graphsFor = (channel: 'store' | 'preview') => Object.fromEntries(
  Object.entries(LEGACY_PACKAGE_COLD_GRAPH_RATCHETS[channel].chrome)
    .map(([name, value]) => [name, graph(value)]),
);

type RawSample = Record<string, string | number>;
type SummarizedGroup = {
  attempted: number;
  completed: number;
  failures: unknown[];
  rawSamples: RawSample[];
  [key: string]: unknown;
};

const rawGroup = (
  phase: { metrics: readonly string[]; boundary: string },
  count: number, values: Record<string, number> = {},
): RawSample[] =>
  Array.from({ length: count }, (_, index) => Object.fromEntries([
    ['sampleIndex', index + 1],
    ['clock', 'host-monotonic'],
    ['diagnosticWorkerClock', 'realm-performance'],
    ['boundary', phase.boundary],
    ...phase.metrics.map((metric) => [metric, values[metric] ?? 1_000]),
  ]) as RawSample);

const summarizedGroup = (
  phase: { metrics: readonly string[]; boundary: string },
  count: number, values: Record<string, number> = {},
): SummarizedGroup => {
  const rawSamples = rawGroup(phase, count, values);
  return {
    attempted: count,
    completed: count,
    boundary: phase.boundary,
    failures: [],
    rawSamples,
    ...Object.fromEntries(phase.metrics.map((metric) => [
      metric, summarizeRaw(rawSamples.map((sample) => sample[metric] as number)),
    ])),
  };
};

const chromeResult = ({
  role = 'candidate', sourceCommitSha = '3'.repeat(40), lane = 'pr',
}: { role?: 'candidate' | 'base'; sourceCommitSha?: string; lane?: keyof typeof COLD_START_LANES } = {}) => {
  const contract = COLD_START_LANES[lane].chrome;
  const packagedGraphsByChannel = { store: graphsFor('store'), preview: graphsFor('preview') };
  const result = {
    browser: 'chrome',
    version: 'Chrome/140.0.0.0',
    failed: false,
    nativeFloor: null,
    measurement: {
      role,
      clock: 'host-monotonic:node-hrtime',
      lane,
      runtimeTarget: 'release',
      runtimeSurface: 'sidepanel-tab',
      coldBudgetMode: role === 'candidate' ? 'enforce' : 'measure-only',
      nativeFloor: null,
      sourceCommitSha,
      sourcePackageVersion: '0.7.3',
      sourceDirty: false,
      sourceArchiveSha256: '6'.repeat(64),
      sourceTreeSha256: '7'.repeat(64),
      sourceTreeSha256Before: '7'.repeat(64),
      sourceTreeSha256After: '7'.repeat(64),
      hostSha256: HASH.host,
    },
    artifact: {
      channel: 'store',
      runtimeTarget: 'release',
      runtimeSurface: 'sidepanel-tab',
      archiveSha256: HASH.archive,
      treeSha256: HASH.tree,
      channels: {
        store: { channel: 'store', archiveSha256: HASH.archive, treeSha256: HASH.tree },
        preview: { channel: 'preview', archiveSha256: HASH.previewArchive, treeSha256: HASH.previewTree },
      },
      browserBinarySha256: HASH.browser,
      browserPin: '140.0.0.0',
      harnessSha256: HASH.harness,
      coldBudgetMode: role === 'candidate' ? 'enforce' : 'measure-only',
      packageVersion: '0.7.3',
      sourceCommitSha,
      sourceDirty: false,
      nativeFloor: null,
    },
    packagedGraphs: packagedGraphsByChannel.store,
    packagedGraphsByChannel,
    freshProfile: summarizedGroup(
      COLD_START_PHASES.chrome.freshProfile,
      contract.fresh,
      {
        vaultGateReadyFromLaunchMs: 5_000,
        vaultGateReadyFromWorkerTargetMs: 2_000,
      },
    ),
    forcedColdWake: summarizedGroup(
      COLD_START_PHASES.chrome.forcedColdWake,
      contract.wakes,
      { vaultGateReadyFromWakeMs: 1_000 },
    ),
  };
  result.forcedColdWake.rawSamples.forEach((sample) => {
    sample.stoppedRunningStatus = 'stopped';
  });
  return result;
};

const assessChrome = (result: ReturnType<typeof chromeResult>, extra = {}) =>
  assessColdStartResult('chrome', result, {
    lane: 'pr', graphPolicy: 'ratchet', requireTimingTargets: false, ...extra,
  });

const kernelTiming = () => ({
  clock: 'worker-performance-now-diagnostic',
  moduleEvaluationMs: 100,
  bundleExecutionBeforeKernelMs: 50,
  vaultReadyAfterModuleMs: 10,
  kernelReadyAfterModuleMs: 20,
  replyAfterModuleMs: 100,
  replyAfterBundleStartMs: 150,
  replyFromWorkerTimeOriginMs: 200,
});

const nativeResult = () => {
  const result: any = chromeResult({ lane: 'local' });
  result.nativeFloor = NATIVE_FLOOR_CONTRACT;
  Object.assign(result.measurement, {
    runtimeTarget: 'native-floor', runtimeSurface: 'home',
    coldBudgetMode: 'native-target', nativeFloor: NATIVE_FLOOR_CONTRACT,
  });
  Object.assign(result.artifact, {
    runtimeTarget: 'native-floor', runtimeSurface: 'home',
    coldBudgetMode: 'native-target', nativeFloor: NATIVE_FLOOR_CONTRACT,
  });
  for (const channel of ['store', 'preview'] as const) {
    result.packagedGraphsByChannel[channel] = Object.fromEntries(
      Object.entries(COLD_START_TARGETS.chrome)
        .filter(([name]) => name !== 'timing')
        .map(([name, value]) => [name, graph(name === 'serviceWorker'
          ? { modules: 1, graphBytes: 200_000, entryBytes: 200_000 }
          : value as { modules: number; graphBytes: number; entryBytes: number })]),
    );
  }
  result.packagedGraphs = result.packagedGraphsByChannel.store;
  result.freshProfile = summarizedGroup(
    COLD_START_PHASES.chrome.freshProfile, NATIVE_FLOOR_CONTRACT.freshProcesses,
    { vaultGateReadyFromWorkerTargetMs: 2_000 },
  );
  result.forcedColdWake = summarizedGroup(
    COLD_START_PHASES.chrome.forcedColdWake, NATIVE_FLOOR_CONTRACT.confirmedStopWakes,
    { vaultGateReadyFromWakeMs: 1_000 },
  );
  result.freshProfile.rawSamples.forEach((sample: any, index: number) => {
    sample.kernelTiming = kernelTiming() as any;
    const identity = {
      schema: 1, buildId: 'native-build-identity',
      bootId: `fresh-boot-${index + 1}`, kernelEpoch: `fresh-epoch-${index + 1}`,
    };
    sample.assemblyIdentity = identity as any;
    sample.assembly = {
      identity, target: { firefox: false, selfHostedChrome: false },
      cutoverReady: false, semantic: { migrated: 86, total: 161, ready: false },
    } as any;
  });
  result.forcedColdWake.rawSamples.forEach((sample: any, index: number) => {
    sample.stoppedRunningStatus = 'stopped';
    sample.kernelTiming = kernelTiming() as any;
    const identity = {
      schema: 1, buildId: 'native-build-identity',
      bootId: `wake-boot-${index + 1}`, kernelEpoch: `wake-epoch-${index + 1}`,
    };
    sample.assemblyIdentity = identity as any;
    sample.assembly = {
      identity, target: { firefox: false, selfHostedChrome: false },
      cutoverReady: false, semantic: { migrated: 86, total: 161, ready: false },
    } as any;
  });
  return result;
};

const assessNative = (result: ReturnType<typeof nativeResult>) =>
  assessColdStartResult('chrome', result, {
    lane: 'local', graphPolicy: 'target', requireTimingTargets: true,
  });

describe('cold-start policy', () => {
  test('gates fresh Chrome UX from navigation while retaining worker timing evidence', () => {
    const phase = COLD_START_PHASES.chrome.freshProfile;

    expect(phase.usableMetric).toBe('vaultGateReadyFromNavigationMs');
    expect(phase.metrics).toContain('vaultGateReadyFromWorkerTargetMs');
    expect(phase.metrics).toContain('vaultGateReadyFromNavigationMs');
  });

  test('accepts complete Store and Preview evidence at the no-growth ratchet', () => {
    expect(assessChrome(chromeResult())).toEqual({ ok: true, failures: [] });
  });

  test('requires exact cardinality and cannot hide timeouts or extra samples in a percentile', () => {
    const missing = chromeResult();
    missing.freshProfile.completed = 6;
    missing.freshProfile.rawSamples.pop();
    expect(assessChrome(missing).failures).toContain('chrome freshProfile sample set is incomplete');

    const extra = chromeResult();
    extra.freshProfile.attempted = 8;
    expect(assessChrome(extra).failures)
      .toContain('chrome freshProfile attempted 8; lane requires exactly 7');
  });

  test('requires every raw host-clock phase and recomputes every summary', () => {
    const result = chromeResult();
    delete (result.freshProfile.rawSamples[0] as any).bootModuleFromLaunchMs;
    result.freshProfile.rawSamples[1].clock = 'page-performance';
    expect(assessChrome(result).failures).toEqual(expect.arrayContaining([
      'chrome freshProfile.bootModuleFromLaunchMs is missing from a completed sample',
      'chrome freshProfile sample 2 is not bound to the host-monotonic clock',
    ]));
  });

  test('fresh launch and forced wake samples cannot exchange timing boundaries', () => {
    const result = chromeResult();
    result.forcedColdWake.boundary = result.freshProfile.boundary;
    result.forcedColdWake.rawSamples[0].boundary = String(result.freshProfile.boundary);
    expect(assessChrome(result).failures).toEqual(expect.arrayContaining([
      'chrome forcedColdWake timing boundary is missing or invalid',
      'chrome forcedColdWake sample 1 has the wrong timing boundary',
    ]));
  });

  test('requires Chrome to observe the exact running worker version stop', () => {
    const missing = chromeResult();
    delete missing.forcedColdWake.rawSamples[0].stoppedRunningStatus;
    expect(assessChrome(missing).failures)
      .toContain('chrome forcedColdWake sample 1 lacks authoritative stop state');
    const stillRunning = chromeResult();
    stillRunning.forcedColdWake.rawSamples[0].stoppedRunningStatus = 'running';
    expect(assessChrome(stillRunning).failures)
      .toContain('chrome forcedColdWake sample 1 lacks authoritative stop state');
    const transitional = chromeResult();
    transitional.forcedColdWake.rawSamples[0].stoppedRunningStatus = 'stopping';
    expect(assessChrome(transitional).failures)
      .toContain('chrome forcedColdWake sample 1 lacks authoritative stop state');
  });

  test('native floor requires three exact timing-and-identity-bound fresh/wake pairs', () => {
    expect(assessNative(nativeResult())).toEqual({ ok: true, failures: [] });

    const missingTiming = nativeResult();
    delete (missingTiming.freshProfile.rawSamples[0].kernelTiming as any)
      .replyFromWorkerTimeOriginMs;
    expect(assessNative(missingTiming).failures)
      .toContain('chrome native-floor fresh sample 1 kernel timing schema is invalid');

    const staleIdentity = nativeResult();
    staleIdentity.forcedColdWake.rawSamples[0].assemblyIdentity =
      staleIdentity.freshProfile.rawSamples[0].assemblyIdentity;
    expect(assessNative(staleIdentity).failures).toEqual(expect.arrayContaining([
      'chrome native-floor fresh sample 1 identity did not rotate on confirmed-stop wake',
      'chrome native-floor worker identities are not unique across fresh and wake samples',
    ]));

    const incomplete = nativeResult();
    incomplete.freshProfile.attempted = 2;
    expect(assessNative(incomplete).failures)
      .toContain('chrome freshProfile attempted 2; lane requires exactly 3');
  });

  test('native floor caps every worker-origin reply at the checked-in timing ceiling', () => {
    const result = nativeResult();
    Object.assign(result.freshProfile.rawSamples[0].kernelTiming as any, {
      replyAfterModuleMs: 2_901,
      replyAfterBundleStartMs: 2_951,
      replyFromWorkerTimeOriginMs: 3_001,
    });
    expect(assessNative(result).failures).toContain(
      'chrome native-floor fresh sample 1 replyFromWorkerTimeOriginMs 3001ms exceeds 3000ms',
    );
  });

  test('native floor cannot be relabeled or detached from its clean commit metadata', () => {
    const result = nativeResult();
    result.artifact.runtimeTarget = 'release';
    result.artifact.sourceDirty = true;
    result.artifact.nativeFloor = { ...NATIVE_FLOOR_CONTRACT, liveManifestClaimed: true };
    expect(assessNative(result).failures).toEqual(expect.arrayContaining([
      'chrome runtime target binding is invalid',
      'chrome artifact source commit binding is invalid',
      'chrome native-floor artifact metadata is invalid',
      'chrome native-floor must be measured from a clean commit',
    ]));
  });

  test('native-floor report binds its local execution contract end to end', () => {
    const now = Date.UTC(2026, 7, 22, 12);
    const result = nativeResult();
    const report = {
      schema: 3,
      measuredAt: new Date(now - 1_000).toISOString(),
      lane: 'local',
      packageVersion: '0.7.3',
      runtimeTarget: 'native-floor',
      runtimeSurface: 'home',
      coldBudgetMode: 'native-target',
      nativeFloor: NATIVE_FLOOR_CONTRACT,
      commitSha: result.measurement.sourceCommitSha,
      baseCommitSha: result.measurement.sourceCommitSha,
      dirty: false,
      hostSha256: HASH.host,
      comparison: { mode: 'absolute-ratchet' },
      targetCutover: COLD_START_TARGET_CUTOVER,
      options: {
        browser: 'chrome', runtimeTarget: 'native-floor', runtimeSurface: 'home',
        coldBudgetMode: 'native-target', graphPolicy: 'target', requireTimingTargets: true,
        chromeProcesses: 3, chromeWakes: 3,
      },
      results: { chrome: result },
    };
    expect(assessColdStartReport(report, { nowMs: now, requireClean: true }))
      .toEqual({ ok: true, failures: [] });
    report.options.runtimeTarget = 'release';
    expect(assessColdStartReport(report, { nowMs: now, requireClean: true }).failures)
      .toContain('report runtime target binding is invalid');
  });

  test('fails one byte of growth in either shipped channel', () => {
    const result = chromeResult();
    result.packagedGraphsByChannel.preview.serviceWorker.graphBytes += 1;
    const ceiling = LEGACY_PACKAGE_COLD_GRAPH_RATCHETS.preview.chrome.serviceWorker.graphBytes;
    expect(assessChrome(result).failures)
      .toContain(`preview.serviceWorker.graphBytes ${ceiling + 1} exceeds ${ceiling}`);
  });

  test('binds runtime bytes to Store while requiring separate Preview artifact evidence', () => {
    const result = chromeResult();
    result.artifact.channels.preview.archiveSha256 = 'not-a-hash';
    result.artifact.archiveSha256 = '4'.repeat(64);
    expect(assessChrome(result).failures).toEqual(expect.arrayContaining([
      'chrome preview archive SHA-256 is missing',
      'chrome runtime artifact is not bound to the measured Store artifact',
    ]));
  });

  test('enforces the final graph and real usable timing policy when explicitly selected', () => {
    const result = chromeResult();
    for (const channel of ['store', 'preview'] as const) {
      result.packagedGraphsByChannel[channel] = Object.fromEntries(
        Object.entries(COLD_START_TARGETS.chrome)
          .filter(([name]) => name !== 'timing')
          .map(([name, value]) => [name, graph(value as { modules: number; graphBytes: number; entryBytes: number })]),
      );
    }
    result.packagedGraphs = result.packagedGraphsByChannel.store;
    expect(assessChrome(result, {
      graphPolicy: 'target', requireTimingTargets: true,
    })).toEqual({ ok: true, failures: [] });
    result.freshProfile.rawSamples.forEach((sample) => {
      sample.vaultGateReadyFromNavigationMs = 3_001;
    });
    result.freshProfile.vaultGateReadyFromNavigationMs = summarizeRaw(Array(7).fill(3_001));
    expect(assessChrome(result, {
      graphPolicy: 'target', requireTimingTargets: true,
    }).failures).toContain(
      'freshProfile.vaultGateReadyFromNavigationMs.max 3001ms exceeds 3000ms',
    );
  });

  test('target policy accepts only a genuine one-module Chrome worker below 300KB', () => {
    const result = chromeResult();
    for (const channel of ['store', 'preview'] as const) {
      result.packagedGraphsByChannel[channel] = Object.fromEntries(
        Object.entries(COLD_START_TARGETS.chrome)
          .filter(([name]) => name !== 'timing')
          .map(([name, value]) => [name, graph(
            name === 'serviceWorker'
              ? { modules: 1, graphBytes: 299_999, entryBytes: 299_999 }
              : value as { modules: number; graphBytes: number; entryBytes: number },
          )]),
      );
    }
    result.packagedGraphs = result.packagedGraphsByChannel.store;
    expect(assessChrome(result, {
      graphPolicy: 'target', requireTimingTargets: true,
    })).toEqual({ ok: true, failures: [] });

    result.packagedGraphsByChannel.preview.serviceWorker.entryBytes = 299_998;
    expect(assessChrome(result, {
      graphPolicy: 'target', requireTimingTargets: true,
    }).failures).toContain('preview.serviceWorker bundled entry does not equal its static graph');

    result.packagedGraphsByChannel.preview.serviceWorker.entryBytes = 300_001;
    result.packagedGraphsByChannel.preview.serviceWorker.graphBytes = 300_001;
    expect(assessChrome(result, {
      graphPolicy: 'target', requireTimingTargets: true,
    }).failures).toEqual(expect.arrayContaining([
      'preview.serviceWorker.graphBytes 300001 exceeds 300000',
      'preview.serviceWorker.entryBytes 300001 exceeds 300000',
    ]));
  });

  test('a required lane defaults to the 300KB and three-second release gates', () => {
    const result = chromeResult();
    expect(assessColdStartResult('chrome', result, { lane: 'pr' }).failures)
      .toContain('store.serviceWorker.graphBytes 1680949 exceeds 300000');

    for (const channel of ['store', 'preview'] as const) {
      result.packagedGraphsByChannel[channel] = Object.fromEntries(
        Object.entries(COLD_START_TARGETS.chrome)
          .filter(([name]) => name !== 'timing')
          .map(([name, value]) => [name, graph(value as { modules: number; graphBytes: number; entryBytes: number })]),
      );
    }
    result.packagedGraphs = result.packagedGraphsByChannel.store;
    result.forcedColdWake.rawSamples[0].vaultGateReadyFromWakeMs = 3_001;
    result.forcedColdWake.vaultGateReadyFromWakeMs = summarizeRaw([
      3_001, ...Array(COLD_START_LANES.pr.chrome.wakes - 1).fill(1_000),
    ]);
    expect(assessColdStartResult('chrome', result, { lane: 'pr' }).failures)
      .toContain('forcedColdWake.vaultGateReadyFromWakeMs.max 3001ms exceeds 3000ms');
  });

  test('Firefox records browser launch but gates extension install-to-ready time', () => {
    const partial = {
      freshProfile: {
        attempted: 1,
        vaultGateReadyFromSessionMs: summarizeRaw([9_000]),
        vaultGateReadyFromInstallMs: summarizeRaw([3_001]),
      },
      idleDiscardWake: { attempted: 0 },
    };
    expect(assessColdStartResult('firefox', partial, {
      lane: 'local', graphPolicy: 'target', requireTimingTargets: true,
    }).failures).toContain(
      'freshProfile.vaultGateReadyFromInstallMs.max 3001ms exceeds 3000ms',
    );
  });

  test('fails unavailable Firefox instead of preserving a stale result', () => {
    expect(assessColdStartResult('firefox', { unavailable: true }).failures)
      .toContain('firefox is unavailable');
  });

  test('pairs different commits only under identical harness, host, runtime, and lane', () => {
    const base = chromeResult({ role: 'base', sourceCommitSha: '4'.repeat(40) });
    const candidate = chromeResult();
    candidate.freshProfile.rawSamples.forEach((sample) => { sample.stateFromLaunchMs = 1_500; });
    candidate.freshProfile.stateFromLaunchMs = summarizeRaw(Array(7).fill(1_500));
    expect(assessColdStartPair('chrome', candidate, base, { lane: 'pr' }).failures)
      .toContain('freshProfile.stateFromLaunchMs.median regressed from 1000ms to 1500ms');
    candidate.measurement.hostSha256 = '5'.repeat(64);
    candidate.measurement.sourceCommitSha = base.measurement.sourceCommitSha;
    expect(assessColdStartPair('chrome', candidate, base, { lane: 'pr' }).failures)
      .toEqual(expect.arrayContaining([
        'candidate/base host identities differ',
        'candidate/base source commits are identical',
      ]));
  });

  test('binds required reports to immutable lane options, commits, cleanliness, and both browsers', () => {
    const now = Date.UTC(2026, 7, 20, 12);
    const profile = COLD_START_LANES.release;
    const report = {
      schema: 3,
      measuredAt: new Date(now - 1_000).toISOString(),
      lane: 'release',
      packageVersion: '0.7.3',
      runtimeTarget: 'release',
      runtimeSurface: 'sidepanel-tab',
      coldBudgetMode: 'enforce',
      nativeFloor: null,
      commitSha: '1'.repeat(40),
      baseCommitSha: '2'.repeat(40),
      dirty: false,
      hostSha256: HASH.host,
      host: {
        runnerImage: { os: 'ubuntu24', version: '20260801.1' },
        kernel: { platform: 'linux', release: '6.11.0', arch: 'x64' },
      },
      comparison: { mode: 'absolute-ratchet' },
      targetCutover: COLD_START_TARGET_CUTOVER,
      options: {
        browser: 'all', allowFailures: false, unsafeNoSandbox: false,
        runtimeTarget: 'release', runtimeSurface: 'sidepanel-tab', coldBudgetMode: 'enforce',
        enforcement: profile.enforcement,
        graphPolicy: profile.graphPolicy,
        requireTimingTargets: profile.requireTimingTargets,
        coldTimeoutMs: profile.timeoutMs,
        chromeProcesses: profile.chrome.fresh,
        chromeWakes: profile.chrome.wakes,
        firefoxProcesses: profile.firefox.fresh,
        firefoxWakes: profile.firefox.wakes,
        firefoxIdleMs: profile.firefox.idleMs,
      },
      results: { chrome: {}, firefox: {} },
    };
    expect(assessColdStartReport(report, { nowMs: now }).failures)
      .toContain('chrome: store packaged graph set is missing');
    (report as any).targetCutover = { ...COLD_START_TARGET_CUTOVER, ready: true };
    expect(assessColdStartReport(report, { nowMs: now }).failures)
      .toContain('report omits or alters the explicit target-cutover comparison gate');
    (report as any).targetCutover = COLD_START_TARGET_CUTOVER;
    report.options.chromeProcesses -= 1;
    report.dirty = true;
    delete (report.results as any).firefox;
    expect(assessColdStartReport(report, { expectedLane: 'release', nowMs: now }).failures)
      .toEqual(expect.arrayContaining([
        'release report must come from a clean tree',
        'required report option chromeProcesses does not match the immutable release profile',
        'firefox result is missing from required report',
      ]));
  });

  test('aggregates a selected local browser failure instead of allowing a diagnostic false green', () => {
    const now = Date.UTC(2026, 7, 20, 12);
    const result = chromeResult({ lane: 'local' });
    result.failed = true;
    const report = {
      schema: 3,
      measuredAt: new Date(now - 1_000).toISOString(),
      lane: 'local',
      packageVersion: '0.7.3',
      runtimeTarget: 'release',
      runtimeSurface: 'sidepanel-tab',
      coldBudgetMode: 'enforce',
      nativeFloor: null,
      commitSha: result.measurement.sourceCommitSha,
      baseCommitSha: result.measurement.sourceCommitSha,
      dirty: false,
      hostSha256: HASH.host,
      comparison: { mode: 'absolute-ratchet' },
      targetCutover: COLD_START_TARGET_CUTOVER,
      options: {
        browser: 'chrome', graphPolicy: 'ratchet', requireTimingTargets: false,
        runtimeTarget: 'release', runtimeSurface: 'sidepanel-tab', coldBudgetMode: 'enforce',
      },
      results: { chrome: result },
    };
    expect(assessColdStartReport(report, { nowMs: now }).failures)
      .toContain('chrome: chrome reported a failed sample');
  });

  test('accepts only a hash-bound, alternating, clean local candidate/base report', () => {
    const now = Date.UTC(2026, 7, 20, 12);
    const candidate = chromeResult({ lane: 'local', sourceCommitSha: '3'.repeat(40) });
    const base = chromeResult({ role: 'base', lane: 'local', sourceCommitSha: '4'.repeat(40) });
    const report = {
      schema: 3,
      measuredAt: new Date(now - 1_000).toISOString(),
      lane: 'local',
      packageVersion: '0.7.3',
      runtimeTarget: 'release',
      runtimeSurface: 'sidepanel-tab',
      coldBudgetMode: 'enforce',
      nativeFloor: null,
      commitSha: candidate.measurement.sourceCommitSha,
      baseCommitSha: base.measurement.sourceCommitSha,
      dirty: true,
      hostSha256: HASH.host,
      comparison: {
        mode: 'interleaved-candidate-base',
        scheduleByBrowser: { chrome: [{ sampleIndex: 1, order: ['base', 'candidate'] }] },
      },
      targetCutover: COLD_START_TARGET_CUTOVER,
      options: {
        browser: 'chrome', graphPolicy: 'ratchet', requireTimingTargets: false,
        runtimeTarget: 'release', runtimeSurface: 'sidepanel-tab', coldBudgetMode: 'enforce',
      },
      results: { chrome: candidate },
      baseResults: { chrome: base },
      pairAssessments: {
        chrome: assessColdStartPair('chrome', candidate, base, {
          lane: 'local', graphPolicy: 'ratchet', requireTimingTargets: false,
        }),
      },
    };
    expect(assessColdStartReport(report, { nowMs: now })).toEqual({ ok: true, failures: [] });
    report.comparison.scheduleByBrowser.chrome[0].order.reverse();
    expect(assessColdStartReport(report, { nowMs: now }).failures)
      .toContain('chrome: interleaved schedule is not the reviewed alternating order');
  });
});
