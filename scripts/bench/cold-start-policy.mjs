// Pure assessment for cold-start reports. Keep this free of browser and file IO
// so CI can attack the policy independently from the expensive browser lane.

import {
  COLD_START_COMPARISON,
  COLD_SOURCE_TARGETS,
  FIREFOX_KERNEL_SOURCE_CONTRACT,
  PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT,
  OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT,
  PREVIEW_KERNEL_SOURCE_CONTRACT,
  COLD_START_LANES,
  COLD_START_PHASES,
  COLD_START_TIMING_TARGETS,
  COLD_GRAPH_RATCHETS,
  PACKAGE_COLD_GRAPH_RATCHETS,
  COLD_SOURCE_RATCHETS,
} from './cold-start-budgets.js';

export {
  COLD_START_COMPARISON,
  COLD_SOURCE_TARGETS,
  FIREFOX_KERNEL_SOURCE_CONTRACT,
  PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT,
  OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT,
  PREVIEW_KERNEL_SOURCE_CONTRACT,
  COLD_START_LANES,
  COLD_START_PHASES,
  COLD_START_TIMING_TARGETS,
  COLD_GRAPH_RATCHETS,
  PACKAGE_COLD_GRAPH_RATCHETS,
  COLD_SOURCE_RATCHETS,
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value) => Math.round(value * 100) / 100;
const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};
export const summarizeRaw = (values) => {
  const clean = values.filter(finite);
  return clean.length ? {
    samples: clean.length,
    min: round(Math.min(...clean)),
    median: round(percentile(clean, 0.5)),
    p95: round(percentile(clean, 0.95)),
    max: round(Math.max(...clean)),
    mean: round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
  } : null;
};

const requireMetric = (failures, label, summary, key, ceiling) => {
  const value = summary?.[key];
  if (!finite(value)) failures.push(`${label}.${key} is missing`);
  else if (value > ceiling) failures.push(`${label}.${key} ${value}ms exceeds ${ceiling}ms`);
};

const validSha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validGitSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const sameSummary = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const graphFailures = (browser, result, policy) => {
  const failures = [];
  const channels = ['store', 'preview'];
  for (const channel of channels) {
    const reference = PACKAGE_COLD_GRAPH_RATCHETS[channel]?.[browser];
    const budgets = policy === 'ratchet' ? reference : null;
    if (!reference) {
      failures.push(`no ${policy} graph policy for ${channel}/${browser}`);
      continue;
    }
    const graphs = result?.packagedGraphsByChannel?.[channel];
    if (!graphs || typeof graphs !== 'object') {
      failures.push(`${channel} packaged graph set is missing`);
      continue;
    }
    const expectedNames = Object.keys(reference);
    for (const name of expectedNames) {
      const ceiling = budgets?.[name];
      const graph = graphs[name];
      const label = `${channel}.${name}`;
      if (!graph) {
        failures.push(`${label} graph is missing`);
        continue;
      }
      if (typeof graph.entry !== 'string' || graph.entry.length < 1) {
        failures.push(`${label}.entry is missing`);
      }
      if (!validSha256(graph.graphSha256)) failures.push(`${label}.graphSha256 is missing`);
      if (!validSha256(graph.entrySha256)) failures.push(`${label}.entrySha256 is missing`);
      const bundledChromeWorker = browser === 'chrome'
        && name === 'serviceWorker' && graph.graphModules === 1;
      if (bundledChromeWorker && graph.entryBytes !== graph.graphBytes) {
        failures.push(`${label} bundled entry does not equal its static graph`);
      }
      for (const metric of ['modules', 'graphBytes', 'entryBytes']) {
        const key = metric === 'modules' ? 'graphModules' : metric;
        const value = graph[key];
        if (!Number.isInteger(value) || value <= 0) {
          failures.push(`${label}.${key} is missing or invalid`);
        } else {
          const limit = bundledChromeWorker && metric === 'entryBytes'
            ? ceiling?.graphBytes : ceiling?.[metric];
          if (limit && value > limit) {
            failures.push(`${label}.${key} ${value} exceeds ${limit}`);
          }
        }
      }
    }
  }
  if (result?.packagedGraphs && !sameSummary(result.packagedGraphs, result?.packagedGraphsByChannel?.store)) {
    failures.push('runtime packagedGraphs do not match the measured Store graph set');
  }
  return failures;
};

const validateGroup = (
  failures, label, group, required, completedKey = 'completed', expectedBoundary,
) => {
  const attempted = group?.attempted;
  const completed = group?.[completedKey];
  if (!Number.isInteger(attempted) || attempted !== required) {
    failures.push(`${label} attempted ${attempted ?? 'missing'}; lane requires exactly ${required}`);
  }
  if (!Number.isInteger(completed) || completed !== required) failures.push(`${label} sample set is incomplete`);
  if (!Array.isArray(group?.rawSamples) || group.rawSamples.length !== required) {
    failures.push(`${label} raw sample set is missing or incomplete`);
  } else {
    group.rawSamples.forEach((sample, index) => {
      if (sample?.sampleIndex !== index + 1) {
        failures.push(`${label} raw samples are not an exact ordered 1..${required} set`);
      }
      if (sample?.clock !== 'host-monotonic') {
        failures.push(`${label} sample ${index + 1} is not bound to the host-monotonic clock`);
      }
      if (sample?.diagnosticWorkerClock !== 'realm-performance') {
        failures.push(`${label} sample ${index + 1} does not label its realm-relative worker diagnostic`);
      }
      if (sample?.boundary !== expectedBoundary) {
        failures.push(`${label} sample ${index + 1} has the wrong timing boundary`);
      }
    });
  }
  if (!Array.isArray(group?.failures)) failures.push(`${label} failure list is missing`);
  else if (group.failures.length > 0) failures.push(`${label} contains failed samples`);
};

const validateSummaries = (failures, label, group, metrics) => {
  if (!Array.isArray(group?.rawSamples)) return;
  for (const metric of metrics) {
    const values = group.rawSamples.map((sample) => sample?.[metric]);
    if (values.some((value) => !finite(value) || value < 0)) {
      failures.push(`${label}.${metric} is missing from a completed sample`);
      continue;
    }
    const expected = summarizeRaw(values);
    if (!sameSummary(group?.[metric], expected)) failures.push(`${label}.${metric} does not match raw samples`);
  }
};

const validateOrdering = (failures, label, group, order) => {
  if (!Array.isArray(group?.rawSamples)) return;
  group.rawSamples.forEach((sample, index) => {
    for (let position = 1; position < order.length; position += 1) {
      const before = sample?.[order[position - 1]];
      const after = sample?.[order[position]];
      if (finite(before) && finite(after) && before > after) {
        failures.push(`${label} sample ${index + 1} has ${order[position - 1]} after ${order[position]}`);
      }
    }
  });
};

const completenessFailures = (browser, result, lane) => {
  const failures = [];
  if (!result || result.unavailable) return [`${browser} is unavailable`];
  if (result.browser !== browser) failures.push(`${browser} result identity is invalid`);
  if (typeof result.version !== 'string' || result.version.length < 1) failures.push(`${browser} version is missing`);
  if (result.failed) failures.push(`${browser} reported a failed sample`);
  if (result.failed !== false) failures.push(`${browser} failed flag is missing or invalid`);
  if (result.artifact?.channel !== 'store') failures.push(`${browser} runtime artifact channel is not store`);
  if (!validSha256(result.artifact?.archiveSha256)) failures.push(`${browser} artifact SHA-256 is missing`);
  if (!validSha256(result.artifact?.treeSha256)) failures.push(`${browser} artifact tree SHA-256 is missing`);
  if (!validSha256(result.artifact?.browserBinarySha256)) failures.push(`${browser} browser binary SHA-256 is missing`);
  if (!validSha256(result.artifact?.harnessSha256)) failures.push(`${browser} harness SHA-256 is missing`);
  if (typeof result.artifact?.browserPin !== 'string' || result.artifact.browserPin.length < 1) {
    failures.push(`${browser} browser pin is missing`);
  } else {
    const expectedVersion = browser === 'chrome'
      ? `Chrome/${result.artifact.browserPin}`
      : result.artifact.browserPin;
    if (result.version !== expectedVersion) failures.push(`${browser} runtime does not match its browser pin`);
  }
  if (typeof result.artifact?.packageVersion !== 'string'
      || !/^\d+\.\d+\.\d+$/.test(result.artifact.packageVersion)) {
    failures.push(`${browser} artifact package version is missing or invalid`);
  }
  if (browser === 'firefox' && !validSha256(result.artifact?.driverBinarySha256)) {
    failures.push('firefox driver binary SHA-256 is missing');
  }
  if (browser === 'firefox'
      && (typeof result.artifact?.driverPin !== 'string'
        || !String(result.artifact?.driverVersion ?? '').includes(result.artifact.driverPin))) {
    failures.push('firefox driver does not match its pin');
  }
  for (const channel of ['store', 'preview']) {
    const channelArtifact = result.artifact?.channels?.[channel];
    if (channelArtifact?.channel !== channel) failures.push(`${browser} ${channel} artifact identity is invalid`);
    if (!validSha256(channelArtifact?.archiveSha256)) failures.push(`${browser} ${channel} archive SHA-256 is missing`);
    if (!validSha256(channelArtifact?.treeSha256)) failures.push(`${browser} ${channel} tree SHA-256 is missing`);
  }
  if (result.artifact?.archiveSha256 !== result.artifact?.channels?.store?.archiveSha256
      || result.artifact?.treeSha256 !== result.artifact?.channels?.store?.treeSha256) {
    failures.push(`${browser} runtime artifact is not bound to the measured Store artifact`);
  }
  if (result.measurement?.clock !== 'host-monotonic:node-hrtime') {
    failures.push(`${browser} measurement clock is not host-monotonic`);
  }
  const runtimeTarget = result.measurement?.runtimeTarget;
  if (runtimeTarget !== 'release' || result.artifact?.runtimeTarget !== runtimeTarget) {
    failures.push(`${browser} runtime target binding is invalid`);
  }
  if (typeof result.measurement?.runtimeSurface !== 'string'
      || result.artifact?.runtimeSurface !== result.measurement.runtimeSurface) {
    failures.push(`${browser} runtime surface binding is invalid`);
  }
  if (typeof result.measurement?.coldBudgetMode !== 'string'
      || result.artifact?.coldBudgetMode !== result.measurement.coldBudgetMode) {
    failures.push(`${browser} cold budget mode binding is invalid`);
  }
  if (result.artifact?.sourceCommitSha !== result.measurement?.sourceCommitSha
      || result.artifact?.sourceDirty !== result.measurement?.sourceDirty) {
    failures.push(`${browser} artifact source commit binding is invalid`);
  }
  if (result.measurement?.lane !== lane) failures.push(`${browser} measurement lane does not match ${lane}`);
  if (!validGitSha(result.measurement?.sourceCommitSha)) failures.push(`${browser} source commit SHA is missing`);
  if (typeof result.measurement?.sourceDirty !== 'boolean') failures.push(`${browser} source dirty flag is missing`);
  if (!validSha256(result.measurement?.hostSha256)) failures.push(`${browser} host identity SHA-256 is missing`);
  if (!['candidate', 'base'].includes(result.measurement?.role)) failures.push(`${browser} measurement role is invalid`);
  const contract = COLD_START_LANES[lane]?.[browser];
  if (!contract) return [...failures, `no sample contract for ${lane}/${browser}`];
  const phases = COLD_START_PHASES[browser];
  for (const [groupName, phase] of Object.entries(phases)) {
    const label = `${browser} ${groupName}`;
    const group = result[groupName];
    if (group && group.boundary !== phase.boundary) {
      failures.push(`${label} timing boundary is missing or invalid`);
    }
    validateGroup(failures, label, group, contract[phase.requiredKey],
      phase.completedKey, phase.boundary);
    validateSummaries(failures, label, group, phase.metrics);
    for (const order of phase.ordering) validateOrdering(failures, label, group, order);
  }
  if (browser === 'chrome' && Array.isArray(result.forcedColdWake?.rawSamples)) {
    result.forcedColdWake.rawSamples.forEach((sample, index) => {
      if (sample?.stoppedRunningStatus !== 'stopped') {
        failures.push(`chrome forcedColdWake sample ${index + 1} lacks authoritative stop state`);
      }
    });
  }
  return failures;
};

const timingFailures = (browser, result) => {
  const failures = [];
  const budget = COLD_START_TIMING_TARGETS[browser];
  if (!budget) return [`no timing policy for ${browser}`];
  for (const [groupName, phase] of Object.entries(COLD_START_PHASES[browser])) {
    const group = result?.[groupName];
    if ((group?.attempted ?? 0) > 0) {
      requireMetric(failures, `${groupName}.${phase.usableMetric}`,
        group?.[phase.usableMetric], 'max', budget.usableMaxMs);
    }
  }
  return failures;
};

export const assessColdStartResult = (browser, result, options = {}) => {
  const lane = options.lane ?? result?.measurement?.lane ?? 'local';
  const profile = COLD_START_LANES[lane];
  const graphPolicy = options.graphPolicy ?? profile?.graphPolicy;
  const requireTimingTargets = options.requireTimingTargets ?? profile?.requireTimingTargets;
  if (!['chrome', 'firefox'].includes(browser)) throw new Error(`unsupported browser: ${browser}`);
  if (!['ratchet', 'integrity'].includes(graphPolicy)) throw new Error(`unsupported graph policy: ${graphPolicy}`);
  if (!COLD_START_LANES[lane]) throw new Error(`unsupported cold-start lane: ${lane}`);
  const failures = [
    ...graphFailures(browser, result, graphPolicy),
    ...completenessFailures(browser, result, lane),
    ...(requireTimingTargets ? timingFailures(browser, result) : []),
  ];
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...new Set(failures)]) });
};

export const assessColdStartPair = (browser, candidate, base, options = {}) => {
  const lane = options.lane ?? candidate?.measurement?.lane ?? 'local';
  const failures = [
    ...assessColdStartResult(browser, candidate, { ...options, lane }).failures,
    ...graphFailures(browser, base, 'integrity').map((failure) => `base: ${failure}`),
    ...completenessFailures(browser, base, lane).map((failure) => `base: ${failure}`),
  ];
  if (candidate?.measurement?.role !== 'candidate') failures.push('candidate measurement role is invalid');
  if (base?.measurement?.role !== 'base') failures.push('base measurement role is invalid');
  if (candidate?.measurement?.sourceCommitSha === base?.measurement?.sourceCommitSha) {
    failures.push('candidate/base source commits are identical');
  }
  if (candidate?.measurement?.sourceDirty !== false || base?.measurement?.sourceDirty !== false) {
    failures.push('candidate/base measurements must use clean source trees');
  }
  for (const [role, result] of [['candidate', candidate], ['base', base]]) {
    if (!validSha256(result?.measurement?.sourceArchiveSha256)) {
      failures.push(`${role} source archive SHA-256 is missing`);
    }
    if (!validSha256(result?.measurement?.sourceTreeSha256)) {
      failures.push(`${role} source tree SHA-256 is missing`);
    }
    if (!validSha256(result?.measurement?.sourceTreeSha256Before)
        || !validSha256(result?.measurement?.sourceTreeSha256After)) {
      failures.push(`${role} source before/after tree digests are missing`);
    } else if (result.measurement.sourceTreeSha256Before
        !== result.measurement.sourceTreeSha256After
        || result.measurement.sourceTreeSha256 !== result.measurement.sourceTreeSha256Before) {
      failures.push(`${role} source tree changed during measurement`);
    }
    if (result?.artifact?.packageVersion !== result?.measurement?.sourcePackageVersion) {
      failures.push(`${role} package version is not bound to its source tree`);
    }
  }
  if (candidate?.artifact?.coldBudgetMode !== 'enforce') {
    failures.push('candidate package did not enforce the checked-in cold graph budget');
  }
  if (base?.artifact?.coldBudgetMode !== 'measure-only') {
    failures.push('base package is not labeled as an isolated historical measurement');
  }
  if (candidate?.measurement?.hostSha256 !== base?.measurement?.hostSha256) {
    failures.push('candidate/base host identities differ');
  }
  if (candidate?.measurement?.lane !== base?.measurement?.lane) {
    failures.push('candidate/base lane profiles differ');
  }
  if (candidate?.artifact?.harnessSha256 !== base?.artifact?.harnessSha256) {
    failures.push('candidate/base harness digests differ');
  }
  if (candidate?.artifact?.browserBinarySha256 !== base?.artifact?.browserBinarySha256) {
    failures.push('candidate/base browser binary digests differ');
  }
  if (browser === 'firefox'
      && candidate?.artifact?.driverBinarySha256 !== base?.artifact?.driverBinarySha256) {
    failures.push('candidate/base Firefox driver digests differ');
  }
  for (const channel of ['store', 'preview']) {
    const names = new Set([
      ...Object.keys(candidate?.packagedGraphsByChannel?.[channel] ?? {}),
      ...Object.keys(base?.packagedGraphsByChannel?.[channel] ?? {}),
    ]);
    for (const name of names) {
      for (const metric of ['graphModules', 'graphBytes', 'entryBytes']) {
        const candidateValue = candidate?.packagedGraphsByChannel?.[channel]?.[name]?.[metric];
        const baseValue = base?.packagedGraphsByChannel?.[channel]?.[name]?.[metric];
        if (!Number.isInteger(candidateValue) || !Number.isInteger(baseValue)) continue;
        if (candidateValue > baseValue) {
          failures.push(`${channel}.${name}.${metric} regressed from ${baseValue} to ${candidateValue}`);
        }
      }
    }
  }
  const phaseGroups = Object.entries(COLD_START_PHASES[browser])
    .map(([group, phase]) => [group, phase.metrics.filter((metric) => metric !== 'workerAgeAtProbeMs')]);
  for (const [group, metrics] of phaseGroups) {
    for (const metric of metrics) {
      for (const key of ['median', 'max']) {
        const candidateValue = candidate?.[group]?.[metric]?.[key];
        const baseValue = base?.[group]?.[metric]?.[key];
        if (!finite(candidateValue) || !finite(baseValue)) continue;
        const ceiling = baseValue + Math.max(
          COLD_START_COMPARISON.minimumToleranceMs,
          baseValue * COLD_START_COMPARISON.relativeTolerance,
        );
        if (candidateValue > ceiling) {
          failures.push(`${group}.${metric}.${key} regressed from ${baseValue}ms to ${candidateValue}ms`);
        }
      }
    }
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...new Set(failures)]) });
};

/**
 * Validate report identity separately from per-browser sample assessment.
 * CI still recomputes archive/tree/graph digests from the promoted artifact;
 * this check ensures a report cannot omit or relabel the expected run.
 * @param {any} report
 * @param {{
 *   expectedLane?: keyof typeof COLD_START_LANES,
 *   expectedCommitSha?: string,
 *   expectedBaseCommitSha?: string,
 *   requireClean?: boolean,
 *   nowMs?: number,
 *   maxAgeMs?: number,
 * }} [options]
 */
export const assessColdStartReport = (report, {
  expectedLane,
  expectedCommitSha,
  expectedBaseCommitSha,
  requireClean = expectedLane === 'release',
  nowMs = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1_000,
} = {}) => {
  const failures = [];
  if (report?.schema !== 3) failures.push('report schema is unsupported');
  if (report?.runtimeTarget !== 'release'
      || report?.options?.runtimeTarget !== report?.runtimeTarget) {
    failures.push('report runtime target binding is invalid');
  }
  if (typeof report?.runtimeSurface !== 'string'
      || report?.options?.runtimeSurface !== report?.runtimeSurface) {
    failures.push('report runtime surface binding is invalid');
  }
  if (typeof report?.coldBudgetMode !== 'string'
      || report?.options?.coldBudgetMode !== report?.coldBudgetMode) {
    failures.push('report cold budget mode binding is invalid');
  }
  const measuredAtMs = Date.parse(report?.measuredAt ?? '');
  if (!finite(measuredAtMs) || measuredAtMs > nowMs || nowMs - measuredAtMs > maxAgeMs) {
    failures.push('report measuredAt is missing, future-dated, or stale');
  }
  if (!COLD_START_LANES[report?.lane]) failures.push('report lane is invalid');
  if (expectedLane && report?.lane !== expectedLane) failures.push('report lane does not match the required lane');
  if (!validGitSha(report?.commitSha)) failures.push('report commit SHA is missing');
  if (!validGitSha(report?.baseCommitSha)) failures.push('report base commit SHA is missing');
  if (report?.lane === 'pr' && report?.commitSha === report?.baseCommitSha) {
    failures.push('report candidate and base commits are identical');
  }
  if (expectedCommitSha && report?.commitSha !== expectedCommitSha) failures.push('report commit SHA does not match');
  if (expectedBaseCommitSha && report?.baseCommitSha !== expectedBaseCommitSha) failures.push('report base commit SHA does not match');
  if (typeof report?.dirty !== 'boolean') failures.push('report dirty flag is missing');
  if ((requireClean || report?.lane !== 'local') && report?.dirty !== false) {
    failures.push(`${report?.lane ?? 'required'} report must come from a clean tree`);
  }
  if (!validSha256(report?.hostSha256)) failures.push('report host identity SHA-256 is missing');
  const ciReport = ['pr', 'main', 'release'].includes(report?.lane);
  if (ciReport) {
    if (typeof report?.host?.runnerImage?.os !== 'string'
        || typeof report?.host?.runnerImage?.version !== 'string') {
      failures.push('required report omits the pinned runner image identity');
    }
  }
  if (report?.lane !== 'local') {
    if (typeof report?.host?.kernel?.release !== 'string'
        || typeof report?.host?.kernel?.platform !== 'string'
        || typeof report?.host?.kernel?.arch !== 'string') {
      failures.push('required report omits the runner kernel identity');
    }
  }
  const comparisonMode = report?.comparison?.mode;
  if (!['absolute-ratchet', 'interleaved-candidate-base'].includes(comparisonMode)) {
    failures.push('report comparison mode is invalid');
  }
  if (ciReport && comparisonMode !== 'absolute-ratchet') {
    failures.push('required report comparison mode is invalid');
  }
  const profile = COLD_START_LANES[report?.lane];
  const requiredReport = report?.lane !== 'local' && profile;
  if (requiredReport) {
    if (report?.options?.browser !== 'all') failures.push('required report must measure both browsers');
    if (report?.options?.allowFailures !== false) failures.push('required report permits failures');
    if (report?.options?.unsafeNoSandbox !== false) failures.push('required report disables the Chrome sandbox');
    const exactOptions = {
      enforcement: profile?.enforcement,
      graphPolicy: profile?.graphPolicy,
      requireTimingTargets: profile?.requireTimingTargets,
      coldTimeoutMs: profile?.timeoutMs,
      chromeProcesses: profile?.chrome?.fresh,
      chromeWakes: profile?.chrome?.wakes,
      firefoxProcesses: profile?.firefox?.fresh,
      firefoxWakes: profile?.firefox?.wakes,
      firefoxIdleMs: profile?.firefox?.idleMs,
      runtimeTarget: 'release',
      runtimeSurface: 'home',
      coldBudgetMode: 'enforce',
    };
    for (const [key, expected] of Object.entries(exactOptions)) {
      if (report?.options?.[key] !== expected) {
        failures.push(`required report option ${key} does not match the immutable ${report?.lane} profile`);
      }
    }
  }

  const selectedBrowsers = report?.options?.browser === 'all'
    ? ['chrome', 'firefox']
    : ['chrome', 'firefox'].includes(report?.options?.browser)
      ? [report.options.browser]
      : [];
  if (selectedBrowsers.length === 0) failures.push('report browser selection is invalid');
  for (const browser of selectedBrowsers) {
    const result = report?.results?.[browser];
    if (!result) {
      failures.push(`${browser} result is missing from ${requiredReport ? 'required ' : ''}report`);
      continue;
    }
    if (result?.measurement?.sourceCommitSha !== report?.commitSha) {
      failures.push(`${browser}: measurement is not bound to the report commit`);
    }
    if (result?.artifact?.packageVersion !== report?.packageVersion) {
      failures.push(`${browser}: candidate artifact version differs from the report package version`);
    }
    if (result?.measurement?.sourceDirty !== (
      comparisonMode === 'interleaved-candidate-base' ? false : report?.dirty
    )) {
      failures.push(`${browser}: measurement dirty posture differs from the report`);
    }
    if (result?.measurement?.hostSha256 !== report?.hostSha256) {
      failures.push(`${browser}: measurement is not bound to the report host`);
    }
    if (result?.measurement?.runtimeTarget !== report?.runtimeTarget
        || result?.artifact?.runtimeTarget !== report?.runtimeTarget
        || result?.measurement?.runtimeSurface !== report?.runtimeSurface
        || result?.artifact?.runtimeSurface !== report?.runtimeSurface
        || result?.measurement?.coldBudgetMode !== report?.coldBudgetMode
        || result?.artifact?.coldBudgetMode !== report?.coldBudgetMode) {
      failures.push(`${browser}: runtime evidence is not bound to the report contract`);
    }
    for (const failure of assessColdStartResult(browser, result, {
      lane: report.lane,
      graphPolicy: requiredReport ? profile.graphPolicy : report?.options?.graphPolicy,
      requireTimingTargets: requiredReport
        ? profile.requireTimingTargets
        : report?.options?.requireTimingTargets,
    }).failures) failures.push(`${browser}: ${failure}`);

    if (comparisonMode === 'interleaved-candidate-base') {
      const base = report?.baseResults?.[browser];
      if (!base) {
        failures.push(`${browser}: base result is missing from interleaved report`);
        continue;
      }
      if (base?.measurement?.sourceCommitSha !== report?.baseCommitSha) {
        failures.push(`${browser}: base measurement is not bound to the report base commit`);
      }
      if (base?.measurement?.hostSha256 !== report?.hostSha256) {
        failures.push(`${browser}: base measurement is not bound to the report host`);
      }
      const requiredSamples = COLD_START_LANES[report?.lane]?.[browser]?.fresh;
      const schedule = report?.comparison?.scheduleByBrowser?.[browser];
      if (!Array.isArray(schedule) || schedule.length !== requiredSamples) {
        failures.push(`${browser}: interleaved schedule cardinality is invalid`);
      } else {
        schedule.forEach((entry, index) => {
          const expectedOrder = (index + 1) % 2 === 1
            ? ['base', 'candidate']
            : ['candidate', 'base'];
          if (entry?.sampleIndex !== index + 1
              || JSON.stringify(entry?.order) !== JSON.stringify(expectedOrder)) {
            failures.push(`${browser}: interleaved schedule is not the reviewed alternating order`);
          }
        });
      }
      const pairAssessment = assessColdStartPair(browser, result, base, {
        lane: report.lane,
        graphPolicy: requiredReport ? profile.graphPolicy : report?.options?.graphPolicy,
        requireTimingTargets: requiredReport
          ? profile.requireTimingTargets
          : report?.options?.requireTimingTargets,
      });
      if (JSON.stringify(report?.pairAssessments?.[browser]) !== JSON.stringify(pairAssessment)) {
        failures.push(`${browser}: recorded pair assessment does not match recomputed policy`);
      }
      for (const failure of pairAssessment.failures) failures.push(`${browser} pair: ${failure}`);
    }
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...new Set(failures)]) });
};
