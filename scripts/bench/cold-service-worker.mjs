#!/usr/bin/env bun
// Measure the packaged background entry, not the readable source tree.
//
// Chrome: fresh-profile registration plus forced MV3 worker termination/wake.
// Firefox: fresh temporary-add-on start plus real event-page idle discard/wake.
// The archive is unpacked once into a clean temporary tree, hashed before and
// after execution, and never instrumented. Host-monotonic route and UI clocks
// are the release evidence; worker-age values are diagnostic only.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { cpus, homedir, loadavg, release as osRelease, tmpdir, totalmem } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { buildVaultKernelArtifact } from '../cdp/vault-kernel-artifact.mjs';
import {
  PINNED_FIREFOX_VERSION as FIREFOX_PIN,
  PINNED_GECKODRIVER_VERSION as GECKODRIVER_PIN,
} from '../firefox/runtime-identity.mjs';
import { startGeckodriver } from '../firefox/webdriver.mjs';
import {
  assessColdStartReport,
  assessColdStartPair,
  assessColdStartResult,
  COLD_START_LANES,
  COLD_START_PHASES,
  COLD_START_TARGET_CUTOVER,
  NATIVE_FLOOR_CONTRACT,
} from './cold-start-policy.mjs';
import { parseKernelIdentity } from '../../extension/shared/kernel-identity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const VERSION = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
const OUTPUT = join(ROOT, 'artifacts', 'performance', 'cold-service-worker.json');
const ADDON_ID = 'peerd@peerd.ai';
const FIREFOX_UUID = '7d12f198-31fc-4e95-9184-e954123981b6';
const FIREFOX_ORIGIN = `moz-extension://${FIREFOX_UUID}`;
const CHROME_PIN = readFileSync(join(ROOT, 'scripts', 'cdp', 'chrome-version.txt'), 'utf8').trim();

// All reported host durations use one clock. Page/background performance.now()
// values have independent time origins and remain diagnostic only.
const hostNowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const within = (promise, budgetMs, label) => new Promise((resolveValue, rejectValue) => {
  const timer = setTimeout(() => rejectValue(new Error(`${label} timed out after ${budgetMs}ms`)), budgetMs);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolveValue(value); },
    (error) => { clearTimeout(timer); rejectValue(error); },
  );
});
const onPath = (name) => (process.env.PATH ?? '').split(delimiter)
  .map((directory) => join(directory, name))
  .find((path) => { try { return statSync(path).isFile(); } catch { return false; } });

const cpuTimeTotals = (rows) => rows.reduce((total, row) => {
  const times = row?.times;
  if (!times || typeof times !== 'object') return total;
  const values = Object.values(times);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return total;
  return {
    idle: total.idle + Number(times.idle ?? 0),
    total: total.total + values.reduce((sum, value) => sum + Number(value), 0),
  };
}, { idle: 0, total: 0 });

export const assessHostQuiescence = ({ before, after, load1, logicalCpus, windowMs }) => {
  const idleDelta = after?.idle - before?.idle;
  const totalDelta = after?.total - before?.total;
  const load1PerCpu = load1 / logicalCpus;
  const busyFraction = 1 - (idleDelta / totalDelta);
  const valid = [idleDelta, totalDelta, load1, logicalCpus, windowMs, load1PerCpu, busyFraction]
    .every(Number.isFinite)
    && idleDelta >= 0 && totalDelta > 0 && logicalCpus > 0 && windowMs > 0
    && busyFraction >= 0 && busyFraction <= 1;
  const failures = valid ? [
    load1PerCpu > NATIVE_FLOOR_CONTRACT.hostLoad1PerCpuMax
      ? `load1PerCpu ${round(load1PerCpu)} exceeds ${NATIVE_FLOOR_CONTRACT.hostLoad1PerCpuMax}` : null,
    busyFraction > NATIVE_FLOOR_CONTRACT.hostBusyFractionMax
      ? `busyFraction ${round(busyFraction)} exceeds ${NATIVE_FLOOR_CONTRACT.hostBusyFractionMax}` : null,
  ].filter(Boolean) : ['host CPU evidence is invalid'];
  return Object.freeze({
    schema: 1,
    clock: 'host-cpu-times',
    windowMs,
    logicalCpus,
    load1: round(load1),
    load1PerCpu: round(load1PerCpu),
    busyFraction: round(busyFraction),
    maxLoad1PerCpu: NATIVE_FLOOR_CONTRACT.hostLoad1PerCpuMax,
    maxBusyFraction: NATIVE_FLOOR_CONTRACT.hostBusyFractionMax,
    ok: failures.length === 0,
    failures: Object.freeze(failures),
  });
};

export const measureHostQuiescence = async ({
  readCpus = cpus,
  readLoad1 = () => loadavg()[0],
  wait = sleep,
  windowMs = NATIVE_FLOOR_CONTRACT.hostQuiescenceWindowMs,
} = {}) => {
  const firstRows = readCpus();
  const before = cpuTimeTotals(firstRows);
  await wait(windowMs);
  const secondRows = readCpus();
  return assessHostQuiescence({
    before,
    after: cpuTimeTotals(secondRows),
    load1: readLoad1(),
    logicalCpus: secondRows.length,
    windowMs,
  });
};

const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = true] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const allowedOptions = new Set([
  'help', 'browser', 'lane', 'chrome-wakes', 'chrome-processes',
  'firefox-wakes', 'firefox-processes', 'firefox-idle-ms',
  'cold-timeout-ms', 'diagnostic', 'allow-failures', 'no-sandbox',
  'graph-policy', 'require-timing-targets', 'comparison',
  'runtime-target',
]);
const unknownOption = Object.keys(options).find((name) => !allowedOptions.has(name));
if (unknownOption) throw new Error(`unknown cold-start option --${unknownOption}`);
const browserChoice = String(options.browser ?? 'all');
const runtimeTarget = String(options['runtime-target'] ?? 'release');
if (!['release', 'native-floor'].includes(runtimeTarget)) {
  throw new Error('--runtime-target must be release or native-floor');
}
const nativeFloor = runtimeTarget === 'native-floor';
// why: CDP/WebDriver open extension documents as tabs. A tab-backed copy of
// the browser-owned side panel is correctly refused by sender provenance, so
// Home is the exact human surface these harnesses can exercise honestly.
const runtimeSurface = 'home';
const coldBudgetMode = nativeFloor ? 'native-target' : 'enforce';
const intOption = (name, fallback, minimum) => {
  if (options[name] === undefined) return fallback;
  const parsed = Number(options[name]);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return parsed;
};
const boolOption = (name, fallback = false) => {
  if (options[name] === undefined) return fallback;
  if (options[name] === true || options[name] === 'true') return true;
  if (options[name] === 'false') return false;
  throw new Error(`--${name} must be true or false`);
};
const lane = String(options.lane ?? 'local');
const laneContract = COLD_START_LANES[lane];
if (!laneContract) throw new Error('--lane must be local, device, pr, main, or release');
const chromeWakes = intOption('chrome-wakes', nativeFloor
  ? NATIVE_FLOOR_CONTRACT.confirmedStopWakes : laneContract.chrome.wakes, 0);
const chromeProcesses = intOption('chrome-processes', nativeFloor
  ? NATIVE_FLOOR_CONTRACT.freshProcesses : laneContract.chrome.fresh, 1);
const firefoxProcesses = intOption('firefox-processes', laneContract.firefox.fresh ?? 1, 1);
const firefoxWakes = intOption('firefox-wakes', laneContract.firefox.wakes, 0);
const firefoxIdleMs = intOption('firefox-idle-ms', laneContract.firefox.idleMs, 1);
const coldTimeoutMs = intOption('cold-timeout-ms', laneContract.timeoutMs, 1);
const diagnostic = boolOption('diagnostic');
const allowFailures = boolOption('allow-failures');
const unsafeNoSandbox = boolOption('no-sandbox');
const comparisonMode = String(options.comparison ?? 'absolute-ratchet');
const requestedGraphPolicy = String(options['graph-policy'] ?? laneContract.graphPolicy);
const graphPolicy = nativeFloor ? 'target' : lane === 'local'
  ? requestedGraphPolicy
  : laneContract.graphPolicy;
const requestedTimingTargets = boolOption(
  'require-timing-targets', laneContract.requireTimingTargets,
);
const requireTimingTargets = nativeFloor ? true : lane === 'local'
  ? requestedTimingTargets
  : laneContract.requireTimingTargets;
if (lane !== 'local' && allowFailures) throw new Error('--allow-failures is local-only');
if (lane !== 'local' && unsafeNoSandbox) throw new Error('--no-sandbox is local-only');
if (!['absolute-ratchet', 'interleaved-candidate-base'].includes(comparisonMode)) {
  throw new Error('--comparison must be absolute-ratchet or interleaved-candidate-base');
}
if (!['local', 'device'].includes(lane) && comparisonMode !== 'absolute-ratchet') {
  throw new Error('interleaved candidate/base comparison is not a required-lane gate before target cutover');
}
if (nativeFloor) {
  if (lane !== 'local') throw new Error('--runtime-target=native-floor is local-only');
  if (browserChoice !== 'chrome') {
    throw new Error('--runtime-target=native-floor requires --browser=chrome');
  }
  if (comparisonMode !== 'absolute-ratchet') {
    throw new Error('--runtime-target=native-floor does not support comparison mode');
  }
  if (allowFailures) throw new Error('--runtime-target=native-floor cannot allow failures');
  if (unsafeNoSandbox) throw new Error('--runtime-target=native-floor requires the Chrome sandbox');
  if (chromeProcesses !== NATIVE_FLOOR_CONTRACT.freshProcesses
      || chromeWakes !== NATIVE_FLOOR_CONTRACT.confirmedStopWakes) {
    throw new Error('--runtime-target=native-floor requires exactly three fresh launches and three wakes');
  }
  if (options['graph-policy'] !== undefined && requestedGraphPolicy !== 'target') {
    throw new Error('--runtime-target=native-floor requires target graph policy');
  }
  if (options['require-timing-targets'] !== undefined && requestedTimingTargets !== true) {
    throw new Error('--runtime-target=native-floor requires the timing target');
  }
}
if (lane !== 'local' && browserChoice !== 'all') throw new Error(`the ${lane} lane requires --browser=all`);
if (lane !== 'local') {
  const mismatched = [
    ['cold-timeout-ms', coldTimeoutMs, laneContract.timeoutMs],
    ['chrome-processes', chromeProcesses, laneContract.chrome.fresh],
    ['chrome-wakes', chromeWakes, laneContract.chrome.wakes],
    ['firefox-processes', firefoxProcesses, laneContract.firefox.fresh],
    ['firefox-wakes', firefoxWakes, laneContract.firefox.wakes],
    ['firefox-idle-ms', firefoxIdleMs, laneContract.firefox.idleMs],
  ].find(([, actual, required]) => actual !== required);
  if (mismatched) throw new Error(`--${mismatched[0]} cannot alter the immutable ${lane} lane`);
  if (options['graph-policy'] !== undefined && requestedGraphPolicy !== laneContract.graphPolicy) {
    throw new Error(`--graph-policy cannot alter the immutable ${lane} lane`);
  }
  if (options['require-timing-targets'] !== undefined
      && requestedTimingTargets !== laneContract.requireTimingTargets) {
    throw new Error(`--require-timing-targets cannot alter the immutable ${lane} lane`);
  }
}
if (chromeWakes > chromeProcesses || firefoxWakes > firefoxProcesses) {
  throw new Error('cold-wake samples must use independent fresh browser processes');
}

const sha256File = (path) => new Promise((resolveDigest, rejectDigest) => {
  const digest = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => digest.update(chunk));
  input.on('error', rejectDigest);
  input.on('end', () => resolveDigest(digest.digest('hex')));
});
const gitValue = (args) => {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
};
const harnessSha256 = async () => {
  const digest = createHash('sha256');
  const graph = await collectStaticModuleGraph(ROOT, fileURLToPath(import.meta.url));
  const extras = ['bun.lock', 'package.json',
    'scripts/cdp/chrome-version.txt',
    'scripts/firefox/firefox-version.txt',
    'scripts/firefox/geckodriver-version.txt'];
  const files = new Set([
    ...[...graph].map((file) => file.slice(ROOT.length + 1)),
    ...extras,
  ]);
  for (const rel of [...files].sort()) {
    digest.update(rel);
    digest.update('\0');
    digest.update(readFileSync(join(ROOT, rel)));
    digest.update('\0');
  }
  return digest.digest('hex');
};

const treeSha256 = (root) => {
  const digest = createHash('sha256');
  for (const rel of readdirSync(root, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/')).sort()) {
    const path = join(root, rel);
    if (!statSync(path).isFile()) continue;
    digest.update(rel);
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
};

const plainRecord = (value) => value !== null && typeof value === 'object'
  && !Array.isArray(value);
const exactKeys = (value, keys) => plainRecord(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// The migration floor must prove which kernel ran without pretending the
// intentionally incomplete route/event/port ledger is cutover-ready.
export const inspectNativeFloorAssembly = (candidate) => {
  if (!plainRecord(candidate)) throw new Error('native-floor assembly is invalid');
  const assembly = /** @type {Record<string, any>} */ (candidate);
  const identity = parseKernelIdentity(assembly.identity);
  if (!identity) throw new Error('native-floor assembly identity is invalid');
  if (!exactKeys(assembly.target, ['firefox', 'selfHostedChrome'])
      || assembly.target.firefox !== false || assembly.target.selfHostedChrome !== false) {
    throw new Error('native-floor assembly target posture is invalid');
  }
  return Object.freeze({ identity, report: candidate });
};

const materializeGitSource = (commitSha, destination) => {
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', commitSha], {
    cwd: ROOT,
    maxBuffer: 512 * 1024 * 1024,
  });
  execFileSync('tar', ['-xf', '-', '-C', destination], {
    input: archive,
    maxBuffer: 512 * 1024 * 1024,
  });
  const packageVersion = String(JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).version);
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error(`historical source ${commitSha} has invalid package version ${packageVersion}`);
  }
  return {
    packageVersion,
    sourceArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    sourceTreeSha256: treeSha256(destination),
  };
};

export const interleavedRoleOrder = (sampleIndex) => {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 1) {
    throw new Error('sampleIndex must be a positive integer');
  }
  return sampleIndex % 2 === 1 ? ['base', 'candidate'] : ['candidate', 'base'];
};

const materializeComparisonSources = (candidateCommitSha, baseCommitSha) => {
  if (candidateCommitSha === baseCommitSha) {
    throw new Error('interleaved comparison requires different candidate and base commits');
  }
  const root = mkdtempSync(join(tmpdir(), 'peerd-cold-comparison-'));
  const roles = {};
  try {
    for (const [role, commitSha] of [
      ['candidate', candidateCommitSha],
      ['base', baseCommitSha],
    ]) {
      const sourceRoot = join(root, role, 'source');
      const artifactRoot = join(root, role, 'artifacts');
      const identity = materializeGitSource(commitSha, sourceRoot);
      roles[role] = { role, commitSha, sourceRoot, artifactRoot, ...identity };
    }
    return { root, roles };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
};

const assertComparisonSourcesUnchanged = (comparisonSources, measurements) => {
  for (const role of ['candidate', 'base']) {
    const source = comparisonSources.roles[role];
    const after = treeSha256(source.sourceRoot);
    if (measurements?.[role]) measurements[role].sourceTreeSha256After = after;
    if (after !== source.sourceTreeSha256) {
      throw new Error(`benchmark mutated the immutable ${role} source tree`);
    }
  }
};

const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};
const round = (value) => Math.round(value * 100) / 100;
const summarize = (values) => {
  const clean = values.filter(Number.isFinite);
  return clean.length ? {
    samples: clean.length,
    min: round(Math.min(...clean)),
    median: round(percentile(clean, 0.5)),
    p95: round(percentile(clean, 0.95)),
    max: round(Math.max(...clean)),
    mean: round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
  } : null;
};

const stagingTree = (browser) => {
  const path = join(ROOT, 'artifacts', 'staging', `store-${browser}`);
  if (!existsSync(path)) throw new Error(`missing packaged staging tree: ${path}`);
  return path;
};

const collectPackagedGraphStats = async (staging, entryRel) => {
  const entry = join(staging, entryRel);
  const graph = await collectStaticModuleGraph(staging, entry);
  const graphDigest = createHash('sha256');
  for (const file of [...graph].sort()) {
    graphDigest.update(file.slice(staging.length + 1));
    graphDigest.update('\0');
    graphDigest.update(readFileSync(file));
    graphDigest.update('\0');
  }
  return {
    entry: entryRel,
    entryBytes: statSync(entry).size,
    graphBytes: [...graph].reduce((sum, file) => sum + statSync(file).size, 0),
    graphModules: graph.size,
    graphSha256: graphDigest.digest('hex'),
    entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
  };
};

export const packagedGraphStats = async (browser, staging = stagingTree(browser)) => {
  const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'));
  const entryRel = manifest.background?.service_worker ?? manifest.background?.scripts?.[0];
  if (typeof entryRel !== 'string') throw new Error(`no packaged ${browser} background entry`);
  const serviceWorker = await collectPackagedGraphStats(staging, entryRel);
  const firstExistingEntry = (candidates) => candidates.find((entry) => existsSync(join(staging, entry)));
  const sidepanelEntry = firstExistingEntry(['sidepanel/boot.js', 'sidepanel/sidepanel.js']);
  const homeEntry = firstExistingEntry(['home/boot.js', 'home/home.js']);
  if (!sidepanelEntry || !homeEntry) throw new Error(`missing packaged ${browser} UI entry`);
  /** @type {Record<string, any>} */
  const graphEntries = {
    serviceWorker,
    sidepanel: await collectPackagedGraphStats(staging, sidepanelEntry),
    home: await collectPackagedGraphStats(staging, homeEntry),
  };
  if (browser === 'chrome' && existsSync(join(staging, 'offscreen', 'offscreen.js'))) {
    graphEntries.offscreen = await collectPackagedGraphStats(staging, 'offscreen/offscreen.js');
  }
  return {
    packagedEntryBytes: serviceWorker.entryBytes,
    packagedGraphBytes: serviceWorker.graphBytes,
    packagedGraphModules: serviceWorker.graphModules,
    packagedGraphSha256: serviceWorker.graphSha256,
    packagedEntrySha256: serviceWorker.entrySha256,
    packagedGraphs: graphEntries,
  };
};

const unpackArtifact = (archive, browser) => {
  const directory = mkdtempSync(join(tmpdir(), `peerd-cold-${browser}-artifact-`));
  execFileSync('unzip', ['-q', archive, '-d', directory]);
  return directory;
};

const prepareBrowserArtifacts = async (browser, {
  sourceRoot = ROOT,
  artifactRoot = join(ROOT, 'artifacts'),
  coldBudgetMode = 'enforce',
  verify = true,
  version = VERSION,
} = {}) => {
  const prepared = {};
  try {
    for (const channel of ['store', 'preview']) {
      const archive = await packageArtifact({
        channel, browser, version, sign: false, verify,
        sourceRoot, artifactRoot, coldBudgetMode,
      });
      const extensionDir = unpackArtifact(archive, `${channel}-${browser}`);
      prepared[channel] = {
        channel, archive, extensionDir, sourceRoot, artifactRoot, coldBudgetMode, verify,
        packageVersion: version,
      };
      prepared[channel].archiveSha256 = await sha256File(archive);
      prepared[channel].treeSha256 = treeSha256(extensionDir);
      prepared[channel].graphs = (await packagedGraphStats(browser, extensionDir)).packagedGraphs;
    }
    return prepared;
  } catch (error) {
    for (const artifact of Object.values(prepared)) {
      rmSync(artifact.extensionDir, { recursive: true, force: true });
    }
    throw error;
  }
};

const prepareNativeFloorArtifacts = async (browser) => {
  if (browser !== 'chrome') throw new Error('native floor currently supports Chrome only');
  const prepared = {};
  const artifactRoot = mkdtempSync(join(tmpdir(), 'peerd-cold-native-artifacts-'));
  try {
    for (const channel of ['store', 'preview']) {
      const built = await buildVaultKernelArtifact({
        browser, channel, releaseMinify: true, artifactRoot,
      });
      const extensionDir = unpackArtifact(built.artifact, `native-${channel}-${browser}`);
      prepared[channel] = {
        channel,
        archive: built.artifact,
        extensionDir,
        sourceRoot: ROOT,
        artifactRoot,
        removeArtifactRoot: true,
        coldBudgetMode: 'native-target',
        verify: channel === 'store',
        packageVersion: built.version,
      };
      prepared[channel].archiveSha256 = await sha256File(built.artifact);
      prepared[channel].treeSha256 = treeSha256(extensionDir);
      prepared[channel].graphs = (await packagedGraphStats(browser, extensionDir)).packagedGraphs;
    }
    return prepared;
  } catch (error) {
    cleanupPreparedArtifacts(prepared);
    rmSync(artifactRoot, { recursive: true, force: true });
    throw error;
  }
};

const assertPreparedArtifactsUnchanged = async (browser, prepared) => {
  for (const channel of ['store', 'preview']) {
    const artifact = prepared[channel];
    if (await sha256File(artifact.archive) !== artifact.archiveSha256) {
      throw new Error(`${browser} benchmark mutated the exact ${channel} archive`);
    }
    if (treeSha256(artifact.extensionDir) !== artifact.treeSha256) {
      throw new Error(`${browser} benchmark mutated the exact unpacked ${channel} artifact tree`);
    }
  }
};

const cleanupPreparedArtifacts = (prepared) => {
  const artifactRoots = new Set();
  for (const artifact of Object.values(prepared ?? {})) {
    rmSync(artifact.extensionDir, { recursive: true, force: true });
    if (artifact.removeArtifactRoot === true) artifactRoots.add(artifact.artifactRoot);
  }
  for (const artifactRoot of artifactRoots) {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
};

const attach = async (url) => {
  const socket = new WebSocket(url);
  await within(new Promise((resolveOpen, rejectOpen) => {
    socket.onopen = resolveOpen;
    socket.onerror = rejectOpen;
  }), 15_000, 'CDP WebSocket connection');
  let sequence = 0;
  const pending = new Map();
  const eventListeners = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const listener of eventListeners.get(message.method) ?? []) listener(message.params ?? {});
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolveReply, rejectReply } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectReply(new Error(message.error.message));
    else resolveReply(message.result);
  };
  socket.onclose = () => {
    for (const { rejectReply, timer } of pending.values()) {
      clearTimeout(timer);
      rejectReply(new Error('CDP WebSocket closed before replying'));
    }
    pending.clear();
  };
  return {
    send: (method, params = {}, budgetMs = 15_000) => new Promise((resolveReply, rejectReply) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        rejectReply(new Error(`CDP ${method} timed out after ${budgetMs}ms`));
      }, budgetMs);
      pending.set(id, {
        resolveReply: (value) => { clearTimeout(timer); resolveReply(value); },
        rejectReply: (error) => { clearTimeout(timer); rejectReply(error); },
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    on: (method, listener) => {
      const listeners = eventListeners.get(method) ?? new Set();
      listeners.add(listener);
      eventListeners.set(method, listeners);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
};

const waitForCdpPort = async (profile, { deadlineAt, child, getStderr }) => {
  const portFile = join(profile, 'DevToolsActivePort');
  while (hostNowMs() < deadlineAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited before DevTools started (code=${child.exitCode}, signal=${child.signalCode})\n${getStderr()}`);
    }
    try {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0 && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return port;
    } catch { /* Chrome is still starting. */ }
    await sleep(20);
  }
  throw new Error('Chrome DevTools endpoint did not start');
};

const listTargets = (port) => fetch(`http://127.0.0.1:${port}/json/list`).then((reply) => reply.json());
export const packagedBackgroundEntry = (extensionDir, browser = 'chrome') => {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const entry = browser === 'firefox'
    ? manifest?.background?.scripts?.[0]
    : manifest?.background?.service_worker;
  if (typeof entry !== 'string' || entry.length < 1 || entry.startsWith('/')
      || entry.includes('..') || entry.includes('\\')) {
    throw new Error(`invalid packaged ${browser} background entry`);
  }
  return entry;
};
const findChromeWorker = async (port, backgroundEntry) => {
  const suffix = `/${backgroundEntry}`;
  const targets = (await listTargets(port)).filter((candidate) =>
    candidate.type === 'service_worker' && String(candidate.url).endsWith(suffix));
  // A fresh benchmark profile should expose exactly the installed artifact's
  // worker. Never pick the first of an ambiguous set and accidentally time a
  // different extension that happens to use the same entry filename.
  if (targets.length !== 1) return null;
  const [target] = targets;
  const extensionId = String(target.url).match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1];
  return extensionId ? {
    extensionId,
    targetId: target.id,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  } : null;
};
const waitFor = async (probe, budgetMs = 30_000, pollMs = 5) => {
  const deadline = hostNowMs() + budgetMs;
  while (hostNowMs() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch { /* navigation or worker generation may still be changing */ }
    await sleep(pollMs);
  }
  return null;
};

const chromeBinary = () => {
  if (process.env.CHROME_PATH || process.env.CHROME) return process.env.CHROME_PATH || process.env.CHROME;
  const version = readFileSync(join(ROOT, 'scripts', 'cdp', 'chrome-version.txt'), 'utf8').trim();
  const platformDirectory = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64')
    : 'chrome-linux64';
  const relativeBinary = process.platform === 'darwin'
    ? join(platformDirectory, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    : join(platformDirectory, 'chrome');
  const cached = join(homedir(), '.cache', 'peerd-cft', version, relativeBinary);
  if (!existsSync(cached)) {
    throw new Error('Chrome for Testing is missing; run `bun run e2e:chrome` first');
  }
  return cached;
};

const sendChromeRuntimeMessage = async (page, message, budgetMs = coldTimeoutMs) => {
  const reply = await page.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: 'runtime message timed out after ${budgetMs}ms' }), ${budgetMs});
      try {
        chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
          const runtimeError = chrome.runtime.lastError?.message;
          clearTimeout(timer);
          resolve(runtimeError ? { ok: false, error: runtimeError } : response);
        });
      } catch (error) {
        clearTimeout(timer);
        resolve({ ok: false, error: error?.message || String(error) });
      }
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, budgetMs + 1_000);
  return reply?.result?.value;
};

const evaluateChrome = async (page, expression, budgetMs = coldTimeoutMs) => {
  const evaluated = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, budgetMs + 5_000);
  if (evaluated?.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails?.exception?.description
      ?? evaluated.exceptionDetails?.text ?? 'Chrome evaluation failed');
  }
  return evaluated?.result?.value;
};

const waitChromeExpression = (page, expression, budgetMs = coldTimeoutMs) => waitFor(async () => {
  const value = await evaluateChrome(page, expression, 2_000);
  return value === true;
}, budgetMs, 20);

const enableChromePrfFixture = async (page) => {
  await page.send('WebAuthn.enable');
  const common = {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true, hasPrf: true,
  };
  await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { ...common, transport: 'internal' },
  });
  await page.send('WebAuthn.addVirtualAuthenticator', {
    options: { ...common, transport: 'usb' },
  });
};

export const exactChromeWorkerVersion = (versions, scriptURL, expected = {}) =>
  [...versions].find((row) => row?.scriptURL === scriptURL
    && Object.entries(expected).every(([key, value]) => row?.[key] === value)) ?? null;

const runChromeProcess = async ({ extensionDir, wakeSamples }) => {
  const backgroundEntry = packagedBackgroundEntry(extensionDir, 'chrome');
  const profile = mkdtempSync(join(tmpdir(), 'peerd-cold-chrome-profile-'));
  const binary = chromeBinary();
  const launchStarted = hostNowMs();
  let deadlineAt = launchStarted + coldTimeoutMs;
  const remaining = () => Math.max(1, deadlineAt - hostNowMs());
  const chromeArgs = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`, 'about:blank',
  ];
  if (unsafeNoSandbox) chromeArgs.splice(3, 0, '--no-sandbox');
  const child = spawn(binary, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const workerErrors = [];
  const serviceWorkerVersions = new Map();
  const workerVersionTimeline = [];
  let expectedWorkerScriptURL = null;
  let workerStartupProbe = null;
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  let browserConnection;
  let page;
  try {
    const port = await waitForCdpPort(profile, {
      deadlineAt, child, getStderr: () => stderr.slice(-8_000),
    });
    const cdpReadyMs = hostNowMs() - launchStarted;
    console.log(`  CDP ready in ${round(cdpReadyMs)}ms`);
    const firstWorker = await waitFor(() => findChromeWorker(port, backgroundEntry), remaining());
    if (!firstWorker) throw new Error(`Chrome worker target did not appear\n${stderr}`);
    expectedWorkerScriptURL = `chrome-extension://${firstWorker.extensionId}/${backgroundEntry}`;
    const workerTargetMs = hostNowMs() - launchStarted;
    console.log(`  worker target ready in ${round(workerTargetMs)}ms`);
    // Browser launch remains reported, but the worker watchdog starts at the
    // same exact realm boundary as the enforced 3s service-worker UX metric.
    deadlineAt = hostNowMs() + coldTimeoutMs;
    if (diagnostic) {
      const startupWorker = await within(
        attach(firstWorker.webSocketDebuggerUrl), 1_000, 'Chrome startup worker attach',
      ).catch(() => null);
      if (startupWorker) {
        const exceptions = [];
        startupWorker.on('Runtime.exceptionThrown', (event) => {
          exceptions.push(event?.exceptionDetails?.exception?.description
            ?? event?.exceptionDetails?.text ?? 'unknown worker exception');
        });
        try {
          await startupWorker.send('Runtime.enable', {}, 1_000);
          const probe = await startupWorker.send('Runtime.evaluate', {
            expression: `({
              workerAgeMs: performance.now(),
              runtimeReady: !!globalThis.chrome?.runtime,
              messageListenerReady: globalThis.chrome?.runtime?.onMessage?.hasListeners?.() === true
            })`,
            returnByValue: true,
          }, 1_000);
          workerStartupProbe = {
            value: probe?.result?.value ?? null,
            exception: probe?.exceptionDetails?.exception?.description
              ?? probe?.exceptionDetails?.text ?? null,
            exceptions,
          };
        } finally {
          startupWorker.close();
        }
      }
    }
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((reply) => reply.json());
    const pinnedVersion = readFileSync(join(ROOT, 'scripts', 'cdp', 'chrome-version.txt'), 'utf8').trim();
    if (!String(version.Browser ?? '').includes(pinnedVersion)) {
      throw new Error(`Chrome ${version.Browser ?? 'unknown'} does not match pin ${pinnedVersion}`);
    }
    browserConnection = await within(attach(version.webSocketDebuggerUrl), remaining(), 'Chrome browser attach');
    const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    page = await within(attach(created.webSocketDebuggerUrl), remaining(), 'Chrome page attach');
    await page.send('Runtime.enable', {}, remaining());
    await page.send('Page.enable', {}, remaining());
    if (wakeSamples > 0) {
      page.on('ServiceWorker.workerErrorReported', (error) => {
        workerErrors.push({
          errorMessage: error?.errorMessage,
          sourceURL: error?.sourceURL,
          lineNumber: error?.lineNumber,
          columnNumber: error?.columnNumber,
        });
      });
      page.on('ServiceWorker.workerVersionUpdated', ({ versions = [] }) => {
        for (const row of versions) {
          if (typeof row?.versionId !== 'string' || row?.scriptURL !== expectedWorkerScriptURL) continue;
          serviceWorkerVersions.set(row.versionId, row);
          workerVersionTimeline.push({
            observedFromLaunchMs: round(hostNowMs() - launchStarted),
            versionId: row.versionId,
            status: row?.status ?? null,
            runningStatus: row?.runningStatus ?? null,
            errorMessage: row?.errorMessage ?? null,
          });
          if (workerVersionTimeline.length > 64) workerVersionTimeline.shift();
        }
      });
      await page.send('ServiceWorker.enable', {}, remaining());
    }
    await enableChromePrfFixture(page);
    // CDP cannot open Chrome's browser-owned side panel. Home is its exact
    // tab-owned human surface, so route provenance remains real.
    const surfacePath = 'home/home.html';
    const panelUrl = `chrome-extension://${firstWorker.extensionId}/${surfacePath}`;
    const navigationFromLaunchMs = hostNowMs() - launchStarted;
    const navigation = await page.send('Page.navigate', { url: panelUrl }, remaining());
    if (navigation?.errorText) throw new Error(`Chrome panel navigation failed: ${navigation.errorText}`);
    // ServiceWorker.workerVersionUpdated is diagnostic here. Chrome can leave
    // that observer at `new/starting` after the exact extension page and worker
    // are already exchanging authenticated messages. Bootstrap, assembly and
    // the visible CTA are the authoritative fresh-sample proof. The forced-stop
    // lane below still requires an exact running -> stopped transition.
    const pageReady = await waitFor(async () => {
      const evaluated = await page.send('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(panelUrl)} && document.readyState !== 'loading'`,
        returnByValue: true,
      });
      return evaluated?.result?.value === true;
    }, remaining());
    if (!pageReady) throw new Error('Chrome extension surface did not load');
    const shellPaintMarker = await waitChromeExpression(page,
      `document.documentElement.dataset.peerdStaticShellPainted === 'true'`, remaining());
    if (!shellPaintMarker) throw new Error('Chrome static vault shell did not paint');
    const painted = await evaluateChrome(page, `new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const node = document.querySelector('#app > *');
        const rect = node?.getBoundingClientRect();
        const style = node ? getComputedStyle(node) : null;
        resolve(!!node && rect.width > 0 && rect.height > 0
          && style.visibility !== 'hidden' && style.display !== 'none');
      }));
    })`, remaining());
    if (!painted) throw new Error('Chrome extension shell was not visibly painted');
    const staticShellFromLaunchMs = hostNowMs() - launchStarted;
    console.log(`  static extension shell ready in ${round(staticShellFromLaunchMs)}ms`);

    const bootstrapPromise = sendChromeRuntimeMessage(page, { type: 'bootstrap/ready' }, remaining())
      .then((reply) => {
        if (reply?.ok !== true) throw new Error(`Chrome bootstrap/ready failed: ${JSON.stringify(reply)}`);
        return { reply, elapsedMs: hostNowMs() - launchStarted };
      });
    const statePromise = bootstrapPromise.then(async () => {
      const reply = await sendChromeRuntimeMessage(page, { type: 'state/get' }, remaining());
      if (reply?.ok !== true || !reply.state) {
        throw new Error(`Chrome state/get failed: ${JSON.stringify(reply)}`);
      }
      return { reply, elapsedMs: hostNowMs() - launchStarted };
    });
    const bootModulePromise = waitChromeExpression(page,
      `document.documentElement.dataset.peerdBootModule === 'evaluated'`, remaining())
      .then((ready) => {
        if (!ready) throw new Error('Chrome vault boot module did not evaluate');
        return hostNowMs() - launchStarted;
      });
    const vaultGatePromise = bootModulePromise.then(() => waitChromeExpression(page, `(() => {
      if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return false;
      return [...document.querySelectorAll('.gate-card button')].some((button) =>
        !button.disabled && /create vault/i.test(button.textContent || ''));
    })()`, remaining())).then((ready) => {
        if (!ready) throw new Error('Chrome vault gate never became actionable');
        return hostNowMs() - launchStarted;
      });
    const [bootstrap, state, bootModuleFromLaunchMs, vaultGateReadyFromLaunchMs] = await within(Promise.all([
      bootstrapPromise, statePromise, bootModulePromise, vaultGatePromise,
    ]), remaining(), 'Chrome fresh sample');
    const assembly = nativeFloor ? inspectNativeFloorAssembly(bootstrap.reply?.assembly) : null;
    const assemblyIdentity = assembly?.identity ?? null;
    const vaultGateReadyFromWorkerTargetMs = Math.max(
      0, vaultGateReadyFromLaunchMs - workerTargetMs,
    );
    const vaultGateReadyFromNavigationMs = Math.max(
      0, vaultGateReadyFromLaunchMs - navigationFromLaunchMs,
    );
    const activatedVersion = exactChromeWorkerVersion(
      serviceWorkerVersions.values(), expectedWorkerScriptURL, { status: 'activated' },
    );
    console.log(`  native worker to actionable UI in ${round(vaultGateReadyFromWorkerTargetMs)}ms`);
    let workerAgeAtProbeMs = null;
    if (diagnostic) {
      const currentWorker = await findChromeWorker(port, backgroundEntry);
      if (currentWorker) {
        const worker = await within(
          attach(currentWorker.webSocketDebuggerUrl), 500, 'Chrome diagnostic worker attach',
        ).catch(() => null);
        if (worker) {
          try {
            await worker.send('Runtime.enable', {}, 500);
            const timing = await worker.send('Runtime.evaluate', {
              expression: 'performance.now()', returnByValue: true,
            }, 500);
            workerAgeAtProbeMs = timing?.result?.value ?? null;
          } catch { /* realm-relative age is diagnostic only */ }
          finally { worker.close(); }
        }
      }
    }
    if (diagnostic) {
      console.log(`  vault diagnostic: ${JSON.stringify(state.reply.state?.vault)}`);
    }
    const wakes = [];
    const wakeFailures = [];
    for (let sample = 0; sample < wakeSamples; sample += 1) {
      const retirementStarted = hostNowMs();
      let current;
      let stoppedVersion;
      try {
        current = await findChromeWorker(port, backgroundEntry);
        if (!current) throw new Error('Chrome worker disappeared before forced termination');
        const currentVersion = await waitFor(() => exactChromeWorkerVersion(
          serviceWorkerVersions.values(), expectedWorkerScriptURL, { runningStatus: 'running' },
        ), 8_000, 5);
        if (!currentVersion) throw new Error('Chrome ServiceWorker domain did not expose the running version');
        await page.send('Page.navigate', { url: 'about:blank' }, 5_000);
        const away = await waitFor(async () => {
          const reply = await page.send('Runtime.evaluate', {
            expression: `location.href === 'about:blank'`, returnByValue: true,
          }, 1_000);
          return reply?.result?.value === true;
        }, 5_000, 10);
        if (!away) throw new Error('Chrome extension surface did not release the worker');
        await page.send('ServiceWorker.stopWorker', { versionId: currentVersion.versionId }, 5_000);
        stoppedVersion = await waitFor(() => {
          const row = serviceWorkerVersions.get(currentVersion.versionId);
          return row?.runningStatus === 'stopped' ? row : null;
        }, 8_000, 5);
        if (!stoppedVersion) throw new Error('Chrome ServiceWorker version remained running');
        const gone = await waitFor(
          async () => !(await findChromeWorker(port, backgroundEntry)), 8_000, 5,
        );
        if (!gone) throw new Error('Chrome service worker did not terminate');
      } catch (error) {
        wakeFailures.push({
          elapsedMs: hostNowMs() - retirementStarted,
          targetAppeared: false,
          error: error?.message ?? String(error),
        });
        console.log(`  forced wake ${sample + 1}/${wakeSamples}: retirement failed`);
        break;
      }
      const started = hostNowMs();
      const wakeDeadlineAt = started + coldTimeoutMs;
      const wakeRemaining = () => Math.max(1, wakeDeadlineAt - hostNowMs());
      const wakeNavigation = await page.send('Page.navigate', { url: panelUrl }, wakeRemaining());
      if (wakeNavigation?.errorText) throw new Error(`Chrome wake panel navigation failed: ${wakeNavigation.errorText}`);
      const targetPromise = waitFor(() => findChromeWorker(port, backgroundEntry), wakeRemaining(), 2)
        .then((target) => ({ target, elapsedMs: hostNowMs() - started }));
      const wakePageReady = await waitFor(async () => {
        const ready = await page.send('Runtime.evaluate', {
          expression: `location.href === ${JSON.stringify(panelUrl)} && document.readyState !== 'loading'`,
          returnByValue: true,
        });
        return ready?.result?.value === true;
      }, wakeRemaining(), 10);
      if (!wakePageReady) throw new Error('Chrome wake panel did not load');
      const wakeShellReady = await waitChromeExpression(page,
        `document.documentElement.dataset.peerdStaticShellPainted === 'true'`, wakeRemaining());
      if (!wakeShellReady) throw new Error('Chrome wake static vault shell did not paint');
      const wakePainted = await evaluateChrome(page, `new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const node = document.querySelector('#app > *');
          const rect = node?.getBoundingClientRect();
          const style = node ? getComputedStyle(node) : null;
          resolve(!!node && rect.width > 0 && rect.height > 0
            && style.visibility !== 'hidden' && style.display !== 'none');
        }));
      })`, wakeRemaining());
      if (!wakePainted) throw new Error('Chrome wake extension shell was not visibly painted');
      const staticShellFromWakeMs = hostNowMs() - started;
      try {
        const wakeBootstrapPromise = sendChromeRuntimeMessage(page, { type: 'bootstrap/ready' }, wakeRemaining())
          .then((reply) => {
            if (reply?.ok !== true) throw new Error(`Chrome wake bootstrap failed: ${JSON.stringify(reply)}`);
            return { reply, elapsedMs: hostNowMs() - started };
          });
        const wakeStatePromise = wakeBootstrapPromise.then(async () => {
          const reply = await sendChromeRuntimeMessage(page, { type: 'state/get' }, wakeRemaining());
          if (reply?.ok !== true || !reply.state) throw new Error(`Chrome wake state failed: ${JSON.stringify(reply)}`);
          return hostNowMs() - started;
        });
        const wakeBootModulePromise = waitChromeExpression(page,
          `document.documentElement.dataset.peerdBootModule === 'evaluated'`, wakeRemaining())
          .then((ready) => {
            if (!ready) throw new Error('Chrome wake vault boot module did not evaluate');
            return hostNowMs() - started;
          });
        const wakeGatePromise = wakeBootModulePromise.then(() => waitChromeExpression(page, `(() => {
          if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return false;
          return [...document.querySelectorAll('.gate-card button')].some((button) =>
            !button.disabled && /create vault/i.test(button.textContent || ''));
        })()`, wakeRemaining())).then((ready) => {
          if (!ready) throw new Error('Chrome wake vault gate never became actionable');
          return hostNowMs() - started;
        });
        const [targetResult, wakeBootstrap, stateFromWakeMs,
          vaultGateReadyFromWakeMs, bootModuleFromWakeMs] = await within(Promise.all([
          targetPromise, wakeBootstrapPromise, wakeStatePromise, wakeGatePromise,
          wakeBootModulePromise,
        ]), wakeRemaining(), 'Chrome forced-wake sample');
        const { target, elapsedMs: workerTargetFromWakeMs } = targetResult;
        if (!target) throw new Error('Chrome wake produced no service-worker target');
        if (target.targetId === current.targetId) throw new Error('Chrome reused the terminated worker target');
        const wakeAssembly = nativeFloor
          ? inspectNativeFloorAssembly(wakeBootstrap.reply?.assembly) : null;
        let wakeGraphReadyMs = null;
        if (diagnostic) {
          const wakeWorker = await within(
            attach(target.webSocketDebuggerUrl), 500, 'Chrome diagnostic wake attach',
          ).catch(() => null);
          if (wakeWorker) {
            try {
              await wakeWorker.send('Runtime.enable', {}, 500);
              const timing = await wakeWorker.send('Runtime.evaluate', {
                expression: 'performance.now()', returnByValue: true,
              }, 500);
              wakeGraphReadyMs = timing?.result?.value ?? null;
            } catch { /* realm-relative age is diagnostic only */ }
            finally { wakeWorker.close(); }
          }
        }
        wakes.push({
          stoppedRunningStatus: stoppedVersion.runningStatus,
          workerAgeAtProbeMs: wakeGraphReadyMs,
          workerTargetFromWakeMs,
          staticShellFromWakeMs,
          bootModuleFromWakeMs,
          bootstrapFromWakeMs: wakeBootstrap.elapsedMs,
          stateFromWakeMs,
          vaultGateReadyFromWakeMs,
          kernelTiming: wakeBootstrap.reply?.timing ?? null,
          assemblyIdentity: wakeAssembly?.identity ?? null,
          assembly: wakeAssembly?.report ?? null,
        });
        console.log(`  forced wake ${sample + 1}/${wakeSamples}: actionable in ${round(vaultGateReadyFromWakeMs)}ms`);
      } catch (error) {
        const target = await targetPromise.then((value) => value.target).catch(() => null);
        wakeFailures.push({
          elapsedMs: hostNowMs() - started,
          targetAppeared: !!target,
          error: error?.message ?? String(error),
        });
        console.log(`  forced wake ${sample + 1}/${wakeSamples}: failed after ${round(hostNowMs() - started)}ms`);
        break;
      }
    }
    return {
      browserProduct: version.Browser ?? 'unknown',
      browserProtocolVersion: version['Protocol-Version'] ?? 'unknown',
      cdpReadyMs, workerTargetMs, workerAgeAtProbeMs,
      navigationFromLaunchMs,
      staticShellFromLaunchMs, bootModuleFromLaunchMs,
      bootstrapFromLaunchMs: bootstrap.elapsedMs,
      stateFromLaunchMs: state.elapsedMs,
      vaultGateReadyFromLaunchMs,
      vaultGateReadyFromWorkerTargetMs,
      vaultGateReadyFromNavigationMs,
      workerActivationObservedByActionable: !!activatedVersion,
      workerVersionTimeline,
      kernelTiming: bootstrap.reply?.timing ?? null,
      assemblyIdentity,
      assembly: assembly?.report ?? null,
      wakes, wakeFailures,
    };
  } catch (error) {
    const details = [
      workerErrors.length > 0
        ? `Chrome worker errors: ${JSON.stringify(workerErrors.slice(-5))}` : null,
      workerStartupProbe
        ? `Chrome startup worker probe: ${JSON.stringify(workerStartupProbe)}` : null,
      workerVersionTimeline.length > 0
        ? `Chrome exact worker version timeline: ${JSON.stringify(workerVersionTimeline)}` : null,
    ].filter(Boolean);
    throw new Error(`${error?.message ?? String(error)}${details.length ? `\n${details.join('\n')}` : ''}`);
  } finally {
    try { page?.close(); } catch { /* browser is closing */ }
    try { browserConnection?.close(); } catch { /* browser is closing */ }
    try { child.kill('SIGKILL'); } catch { /* already closed */ }
    if (child.exitCode === null && child.signalCode === null) {
      await within(new Promise((resolveExit) => child.once('exit', resolveExit)), 3_000, 'Chrome cleanup')
        .catch(() => {});
    }
    child.stderr.destroy();
    rmSync(profile, { recursive: true, force: true });
  }
};

const runChromeSample = async (prepared, sample, role = 'candidate') => {
  console.log(`Chrome ${role} fresh profile ${sample + 1}/${chromeProcesses}`);
  const hostQuiescence = nativeFloor ? await measureHostQuiescence() : null;
  if (hostQuiescence && !hostQuiescence.ok) {
    const failure = {
      sample: sample + 1,
      kind: 'host-overloaded',
      elapsedMs: 0,
      error: `host-overloaded: ${hostQuiescence.failures.join('; ')}`,
      hostQuiescence,
    };
    console.log(`  ${role} fresh profile ${sample + 1}/${chromeProcesses}: ${failure.error}`);
    return { failure };
  }
  const started = hostNowMs();
  try {
    const processResult = await runChromeProcess({
      extensionDir: prepared.store.extensionDir,
      wakeSamples: sample < chromeWakes ? 1 : 0,
    });
    processResult.sampleIndex = sample + 1;
    processResult.clock = 'host-monotonic';
    processResult.diagnosticWorkerClock = 'realm-performance';
    processResult.boundary = COLD_START_PHASES.chrome.freshProfile.boundary;
    if (hostQuiescence) processResult.hostQuiescence = hostQuiescence;
    processResult.wakes.forEach((wakeSample) => {
      wakeSample.sampleIndex = sample + 1;
      wakeSample.clock = 'host-monotonic';
      wakeSample.diagnosticWorkerClock = 'realm-performance';
      wakeSample.boundary = COLD_START_PHASES.chrome.forcedColdWake.boundary;
    });
    return { processResult };
  } catch (error) {
    const failure = {
      sample: sample + 1,
      elapsedMs: hostNowMs() - started,
      error: error?.message ?? String(error),
      ...(hostQuiescence ? { hostQuiescence } : {}),
    };
    console.log(`  ${role} fresh profile ${sample + 1}/${chromeProcesses}: failed after ${round(failure.elapsedMs)}ms`);
    return { failure };
  }
};

const buildChromeResult = async (measurement, prepared, processes, processFailures) => {
  const binary = chromeBinary();
  const store = prepared.store;
  const wakes = processes.flatMap((processResult) => processResult.wakes);
  const wakeFailures = processes.flatMap((processResult) => processResult.wakeFailures);
  const freshMetrics = COLD_START_PHASES.chrome.freshProfile.metrics;
  const wakeMetrics = COLD_START_PHASES.chrome.forcedColdWake.metrics;
  const freshProfile = {
    attempted: chromeProcesses,
    completed: processes.length,
    boundary: COLD_START_PHASES.chrome.freshProfile.boundary,
    failures: processFailures,
    rawSamples: processes,
    ...(nativeFloor ? {
      hostQuiescence: [...processes, ...processFailures]
        .map((row) => ({ sampleIndex: row.sampleIndex ?? row.sample, ...row.hostQuiescence }))
        .sort((left, right) => left.sampleIndex - right.sampleIndex),
    } : {}),
  };
  for (const metric of freshMetrics) freshProfile[metric] = summarize(processes.map((row) => row[metric]));
  const forcedColdWake = {
    attempted: chromeWakes,
    completed: wakes.length,
    boundary: COLD_START_PHASES.chrome.forcedColdWake.boundary,
    failures: wakeFailures,
    rawSamples: wakes,
  };
  for (const metric of wakeMetrics) forcedColdWake[metric] = summarize(wakes.map((row) => row[metric]));
  return {
    browser: 'chrome',
    version: processes[0]?.browserProduct ?? 'unknown',
    nativeFloor: nativeFloor ? NATIVE_FLOOR_CONTRACT : null,
    measurement,
    artifact: {
      channel: 'store',
      runtimeTarget,
      runtimeSurface,
      archiveSha256: store.archiveSha256,
      treeSha256: store.treeSha256,
      channels: Object.fromEntries(['store', 'preview'].map((channel) => [channel, {
        channel,
        archiveSha256: prepared[channel].archiveSha256,
        treeSha256: prepared[channel].treeSha256,
      }])),
      browserBinarySha256: await sha256File(binary),
      browserPin: CHROME_PIN,
      harnessSha256: await harnessSha256(),
      coldBudgetMode: store.coldBudgetMode,
      packageVersion: store.packageVersion,
      sourceCommitSha: measurement.sourceCommitSha,
      sourceDirty: measurement.sourceDirty,
      nativeFloor: nativeFloor ? NATIVE_FLOOR_CONTRACT : null,
    },
    packagedGraphs: store.graphs,
    packagedGraphsByChannel: Object.fromEntries(['store', 'preview']
      .map((channel) => [channel, prepared[channel].graphs])),
    freshProfile,
    forcedColdWake,
    failed: processFailures.length > 0 || wakeFailures.length > 0
      || processes.length !== chromeProcesses || wakes.length !== chromeWakes,
  };
};

const benchmarkChrome = async (measurement) => {
  const prepared = nativeFloor
    ? await prepareNativeFloorArtifacts('chrome')
    : await prepareBrowserArtifacts('chrome');
  try {
    const processes = [];
    const processFailures = [];
    for (let sample = 0; sample < chromeProcesses; sample += 1) {
      const outcome = await runChromeSample(prepared, sample);
      if (outcome.processResult) processes.push(outcome.processResult);
      else processFailures.push(outcome.failure);
    }
    return await buildChromeResult(measurement, prepared, processes, processFailures);
  } finally {
    try { await assertPreparedArtifactsUnchanged('Chrome', prepared); }
    finally { cleanupPreparedArtifacts(prepared); }
  }
};

const prepareInterleavedPair = async (browser, comparisonSources) => {
  const prepared = {};
  try {
    prepared.candidate = await prepareBrowserArtifacts(browser, {
      sourceRoot: comparisonSources.roles.candidate.sourceRoot,
      artifactRoot: comparisonSources.roles.candidate.artifactRoot,
      coldBudgetMode: 'enforce',
      verify: true,
      version: comparisonSources.roles.candidate.packageVersion,
    });
    prepared.base = await prepareBrowserArtifacts(browser, {
      sourceRoot: comparisonSources.roles.base.sourceRoot,
      artifactRoot: comparisonSources.roles.base.artifactRoot,
      coldBudgetMode: 'measure-only',
      // Historical sources are timing controls, not releasable artifacts;
      // they may predate candidate-only Store semantic assertions.
      verify: false,
      version: comparisonSources.roles.base.packageVersion,
    });
    return prepared;
  } catch (error) {
    for (const value of Object.values(prepared)) cleanupPreparedArtifacts(value);
    throw error;
  }
};

const benchmarkChromePair = async (measurements, comparisonSources) => {
  const prepared = await prepareInterleavedPair('chrome', comparisonSources);
  const samples = {
    candidate: { processes: [], failures: [] },
    base: { processes: [], failures: [] },
  };
  const schedule = [];
  try {
    for (let sample = 0; sample < chromeProcesses; sample += 1) {
      const order = interleavedRoleOrder(sample + 1);
      schedule.push({ sampleIndex: sample + 1, order });
      for (const role of order) {
        const outcome = await runChromeSample(prepared[role], sample, role);
        if (outcome.processResult) samples[role].processes.push(outcome.processResult);
        else samples[role].failures.push(outcome.failure);
      }
    }
    return {
      candidate: await buildChromeResult(
        measurements.candidate,
        prepared.candidate,
        samples.candidate.processes,
        samples.candidate.failures,
      ),
      base: await buildChromeResult(
        measurements.base,
        prepared.base,
        samples.base.processes,
        samples.base.failures,
      ),
      schedule,
    };
  } finally {
    for (const role of ['candidate', 'base']) {
      try { await assertPreparedArtifactsUnchanged(`Chrome ${role}`, prepared[role]); }
      finally { cleanupPreparedArtifacts(prepared[role]); }
    }
  }
};

const firefoxBinary = () => process.env.FIREFOX_PATH || process.env.FIREFOX_BIN
  || [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
    '/private/tmp/Firefox153-installed-copy.app/Contents/MacOS/firefox',
  ].find(existsSync)
  || onPath('firefox');
const geckodriverBinary = () => process.env.GECKODRIVER_PATH || onPath('geckodriver');

const waitFirefoxExpression = async (driver, expression, budgetMs = coldTimeoutMs) => {
  const deadline = hostNowMs() + budgetMs;
  while (hostNowMs() < deadline) {
    try {
      if (await driver.execute(`return !!(${expression});`)) return true;
    } catch { /* document or event page is still changing */ }
    await sleep(20);
  }
  return false;
};

const verifyFirefoxPaint = (driver) => driver.executeAsync(`
  const done = arguments[arguments.length - 1];
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const node = document.querySelector('#app > *');
    const rect = node?.getBoundingClientRect();
    const style = node ? getComputedStyle(node) : null;
    done(!!node && rect.width > 0 && rect.height > 0
      && style.visibility !== 'hidden' && style.display !== 'none');
  }));
`);

// Firefox's MV3 background is an event page. getBackgroundPage is a Firefox-
// only measurement boundary: it wakes the exact installed event page and does
// not require a benchmark script to be injected into the release artifact.
const wakeFirefoxAndBootstrap = async (driver) => {
  const hostStarted = hostNowMs();
  const reply = await driver.executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      try {
        const background = await browser.runtime.getBackgroundPage();
        if (!background) throw new Error('Firefox returned no extension background page');
        background.__peerdColdBootId ||= background.crypto.randomUUID();
        const workerAgeAtProbeMs = background.performance.now();
        const bootId = background.__peerdColdBootId;
        const bootstrap = await browser.runtime.sendMessage({ type: 'bootstrap/ready' });
        if (!bootstrap?.ok) throw new Error('bootstrap/ready failed: ' + JSON.stringify(bootstrap));
        done({ ok: true, bootId, workerAgeAtProbeMs });
      } catch (error) {
        done({ ok: false, error: error?.message || String(error) });
      }
    })();
  `);
  return { ...reply, hostRoundTripMs: hostNowMs() - hostStarted };
};

const readFirefoxState = (driver) => driver.executeAsync(`
  const done = arguments[arguments.length - 1];
  browser.runtime.sendMessage({ type: 'state/get' }).then(
    (state) => done(state?.ok && state.state
      ? { ok: true }
      : { ok: false, error: 'state/get failed: ' + JSON.stringify(state) }),
    (error) => done({ ok: false, error: error?.message || String(error) }),
  );
`);

const runFirefoxProcess = async ({ binary, driverBinary, artifact, wake }) => {
  let driver;
  const sessionStarted = hostNowMs();
  try {
    driver = await startGeckodriver({
      binary: driverBinary,
      firefoxBinary: binary,
      prefs: {
        'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: FIREFOX_UUID }),
        'app.update.auto': false,
        'app.update.enabled': false,
        'app.update.silent': false,
      },
    });
    const webdriverSessionMs = hostNowMs() - sessionStarted;
    // startGeckodriver verifies exact binary identity before it returns.
    const runtimeIdentity = driver.runtimeIdentity;
    const installStarted = hostNowMs();
    const deadlineAt = installStarted + coldTimeoutMs;
    const remaining = () => Math.max(1, deadlineAt - hostNowMs());
    const installedId = await within(driver.installAddon(artifact), remaining(), 'Firefox add-on install');
    const addonInstallMs = hostNowMs() - installStarted;
    if (installedId !== ADDON_ID) throw new Error(`unexpected Firefox add-on id: ${installedId}`);
    const userAgent = await driver.execute('return navigator.userAgent;');
    const version = String(userAgent).match(/Firefox\/([0-9.]+)/)?.[1] ?? 'unknown';
    await within(driver.navigate(`${FIREFOX_ORIGIN}/home/home.html`), remaining(), 'Firefox Home navigation');
    const staticShellReady = await waitFirefoxExpression(driver,
      `document.documentElement.dataset.peerdStaticShellPainted === 'true'`, remaining());
    if (!staticShellReady) throw new Error('Firefox static vault shell did not paint');
    if (!await within(verifyFirefoxPaint(driver), remaining(), 'Firefox shell paint')) {
      throw new Error('Firefox vault shell was not visibly painted');
    }
    const staticShellFromInstallMs = hostNowMs() - installStarted;
    const bootModuleReady = await waitFirefoxExpression(driver,
      `document.documentElement.dataset.peerdBootModule === 'evaluated'`, remaining());
    if (!bootModuleReady) throw new Error('Firefox vault boot module did not evaluate');
    const bootModuleFromInstallMs = hostNowMs() - installStarted;
    const routes = await within(wakeFirefoxAndBootstrap(driver), remaining(), 'Firefox cold bootstrap');
    const bootstrapFromInstallMs = hostNowMs() - installStarted;
    if (!routes?.ok) throw new Error(`Firefox cold bootstrap failed: ${routes?.error ?? 'unknown error'}`);
    const state = await within(readFirefoxState(driver), remaining(), 'Firefox cold state');
    const stateFromInstallMs = hostNowMs() - installStarted;
    if (!state?.ok) throw new Error(`Firefox cold state failed: ${state?.error ?? 'unknown error'}`);
    const gateReady = await waitFirefoxExpression(driver, `(() => {
      if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return false;
      return [...document.querySelectorAll('.gate-card button')].some((button) =>
        !button.disabled && /create vault/i.test(button.textContent || ''));
    })()`, remaining());
    if (!gateReady) throw new Error('Firefox vault gate never became actionable');
    const fresh = {
      webdriverSessionMs,
      addonInstallMs,
      workerAgeAtProbeMs: routes.workerAgeAtProbeMs,
      hostRoundTripMs: routes.hostRoundTripMs,
      bootstrapFromInstallMs,
      stateFromInstallMs,
      staticShellFromInstallMs,
      bootModuleFromInstallMs,
      vaultGateReadyFromInstallMs: hostNowMs() - installStarted,
      vaultGateReadyFromSessionMs: hostNowMs() - sessionStarted,
    };
    let wakeSample = null;
    let wakeFailure = null;
    if (wake) {
      const extensionHandle = await driver.windowHandle();
      const survivor = await driver.newWindow('tab');
      await driver.switchToWindow(survivor.handle);
      await driver.navigate('about:blank');
      await driver.switchToWindow(extensionHandle);
      await driver.closeWindow();
      await driver.switchToWindow(survivor.handle);
      await sleep(firefoxIdleMs);
      const wakeStarted = hostNowMs();
      const wakeDeadlineAt = wakeStarted + coldTimeoutMs;
      const wakeRemaining = () => Math.max(1, wakeDeadlineAt - hostNowMs());
      try {
        await within(driver.navigate(`${FIREFOX_ORIGIN}/home/home.html`), wakeRemaining(), 'Firefox wake Home navigation');
        const wakeStaticShellReady = await waitFirefoxExpression(driver,
          `document.documentElement.dataset.peerdStaticShellPainted === 'true'`, wakeRemaining());
        if (!wakeStaticShellReady) throw new Error('Firefox wake static vault shell did not paint');
        if (!await within(verifyFirefoxPaint(driver), wakeRemaining(), 'Firefox wake shell paint')) {
          throw new Error('Firefox wake vault shell was not visibly painted');
        }
        const staticShellFromWakeMs = hostNowMs() - wakeStarted;
        const wakeBootModuleReady = await waitFirefoxExpression(driver,
          `document.documentElement.dataset.peerdBootModule === 'evaluated'`, wakeRemaining());
        if (!wakeBootModuleReady) throw new Error('Firefox wake vault boot module did not evaluate');
        const bootModuleFromWakeMs = hostNowMs() - wakeStarted;
        const wakeRoutes = await within(wakeFirefoxAndBootstrap(driver), wakeRemaining(), 'Firefox wake bootstrap');
        const bootstrapFromWakeMs = hostNowMs() - wakeStarted;
        if (!wakeRoutes?.ok) throw new Error(wakeRoutes?.error ?? 'Firefox wake bootstrap failed');
        if (wakeRoutes.bootId === routes.bootId) throw new Error('Firefox event page was not discarded');
        const wakeState = await within(readFirefoxState(driver), wakeRemaining(), 'Firefox wake state');
        const stateFromWakeMs = hostNowMs() - wakeStarted;
        if (!wakeState?.ok) throw new Error(wakeState?.error ?? 'Firefox wake state failed');
        const wakeGateReady = await waitFirefoxExpression(driver, `(() => {
          if (document.documentElement.dataset.peerdBootStage !== 'vault-ready') return false;
          return [...document.querySelectorAll('.gate-card button')].some((button) =>
            !button.disabled && /create vault/i.test(button.textContent || ''));
        })()`, wakeRemaining());
        if (!wakeGateReady) throw new Error('Firefox wake vault gate never became actionable');
        wakeSample = {
          workerAgeAtProbeMs: wakeRoutes.workerAgeAtProbeMs,
          hostRoundTripMs: wakeRoutes.hostRoundTripMs,
          staticShellFromWakeMs,
          bootModuleFromWakeMs,
          bootstrapFromWakeMs,
          stateFromWakeMs,
          vaultGateReadyFromWakeMs: hostNowMs() - wakeStarted,
        };
      } catch (error) {
        wakeFailure = {
          elapsedMs: hostNowMs() - wakeStarted,
          error: error?.message ?? String(error),
        };
      }
    }
    return {
      version: runtimeIdentity.actual.firefox,
      userAgentVersion: version,
      runtimeIdentity,
      fresh,
      wakeSample,
      wakeFailure,
    };
  } finally {
    await driver?.close();
  }
};

const runFirefoxSample = async (
  prepared, sample, binary, driverBinary, role = 'candidate',
) => {
  console.log(`Firefox ${role} fresh profile ${sample + 1}/${firefoxProcesses}`);
  const started = hostNowMs();
  try {
    const processResult = await runFirefoxProcess({
      binary, driverBinary, artifact: prepared.store.archive, wake: sample < firefoxWakes,
    });
    processResult.fresh.sampleIndex = sample + 1;
    processResult.fresh.clock = 'host-monotonic';
    processResult.fresh.diagnosticWorkerClock = 'realm-performance';
    processResult.fresh.boundary = COLD_START_PHASES.firefox.freshProfile.boundary;
    if (processResult.wakeSample) {
      processResult.wakeSample.sampleIndex = sample + 1;
      processResult.wakeSample.clock = 'host-monotonic';
      processResult.wakeSample.diagnosticWorkerClock = 'realm-performance';
      processResult.wakeSample.boundary = COLD_START_PHASES.firefox.idleDiscardWake.boundary;
    }
    return { processResult };
  } catch (error) {
    return {
      failure: {
        sample: sample + 1,
        elapsedMs: hostNowMs() - started,
        error: error?.message ?? String(error),
      },
    };
  }
};

const buildFirefoxResult = async (
  measurement, prepared, processes, failures, binary, driverBinary,
) => {
  const store = prepared.store;
  const freshSamples = processes.map((row) => row.fresh);
  const wakeSamples = processes.flatMap((row) => row.wakeSample ? [row.wakeSample] : []);
  const wakeFailures = processes.flatMap((row) => row.wakeFailure ? [row.wakeFailure] : []);
  const freshMetrics = COLD_START_PHASES.firefox.freshProfile.metrics;
  const wakeMetrics = COLD_START_PHASES.firefox.idleDiscardWake.metrics;
  const freshProfile = {
    attempted: firefoxProcesses,
    completed: freshSamples.length,
    boundary: COLD_START_PHASES.firefox.freshProfile.boundary,
    failures,
    rawSamples: freshSamples,
  };
  for (const metric of freshMetrics) freshProfile[metric] = summarize(freshSamples.map((row) => row[metric]));
  const idleDiscardWake = {
    attempted: firefoxWakes,
    discarded: wakeSamples.length,
    boundary: COLD_START_PHASES.firefox.idleDiscardWake.boundary,
    failures: wakeFailures,
    rawSamples: wakeSamples,
  };
  for (const metric of wakeMetrics) idleDiscardWake[metric] = summarize(wakeSamples.map((row) => row[metric]));
  return {
    browser: 'firefox',
    version: processes[0]?.version ?? 'unknown',
    runtimeIdentity: processes[0]?.runtimeIdentity ?? null,
    measurement,
    artifact: {
      channel: 'store',
      runtimeTarget,
      runtimeSurface,
      archiveSha256: store.archiveSha256,
      treeSha256: store.treeSha256,
      channels: Object.fromEntries(['store', 'preview'].map((channel) => [channel, {
        channel,
        archiveSha256: prepared[channel].archiveSha256,
        treeSha256: prepared[channel].treeSha256,
      }])),
      browserBinarySha256: await sha256File(binary),
      browserBinaryPath: resolve(binary),
      driverBinarySha256: await sha256File(driverBinary),
      driverBinaryPath: resolve(driverBinary),
      driverVersion: execFileSync(driverBinary, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim(),
      browserPin: FIREFOX_PIN,
      driverPin: GECKODRIVER_PIN,
      harnessSha256: await harnessSha256(),
      coldBudgetMode: store.coldBudgetMode,
      packageVersion: store.packageVersion,
      sourceCommitSha: measurement.sourceCommitSha,
      sourceDirty: measurement.sourceDirty,
      nativeFloor: null,
    },
    packagedGraphs: store.graphs,
    packagedGraphsByChannel: Object.fromEntries(['store', 'preview']
      .map((channel) => [channel, prepared[channel].graphs])),
    freshProfile,
    idleDiscardWake,
    failed: failures.length > 0 || wakeFailures.length > 0
      || freshSamples.length !== firefoxProcesses || wakeSamples.length !== firefoxWakes,
  };
};

const benchmarkFirefox = async (measurement) => {
  const binary = firefoxBinary();
  const driverBinary = geckodriverBinary();
  if (!binary || !driverBinary) throw new Error('Firefox or geckodriver is unavailable');
  const prepared = await prepareBrowserArtifacts('firefox');
  try {
    const processes = [];
    const failures = [];
    for (let sample = 0; sample < firefoxProcesses; sample += 1) {
      const outcome = await runFirefoxSample(prepared, sample, binary, driverBinary);
      if (outcome.processResult) processes.push(outcome.processResult);
      else failures.push(outcome.failure);
    }
    return await buildFirefoxResult(
      measurement, prepared, processes, failures, binary, driverBinary,
    );
  } finally {
    try { await assertPreparedArtifactsUnchanged('Firefox', prepared); }
    finally { cleanupPreparedArtifacts(prepared); }
  }
};

const benchmarkFirefoxPair = async (measurements, comparisonSources) => {
  const binary = firefoxBinary();
  const driverBinary = geckodriverBinary();
  if (!binary || !driverBinary) throw new Error('Firefox or geckodriver is unavailable');
  const prepared = await prepareInterleavedPair('firefox', comparisonSources);
  const samples = {
    candidate: { processes: [], failures: [] },
    base: { processes: [], failures: [] },
  };
  const schedule = [];
  try {
    for (let sample = 0; sample < firefoxProcesses; sample += 1) {
      const order = interleavedRoleOrder(sample + 1);
      schedule.push({ sampleIndex: sample + 1, order });
      for (const role of order) {
        const outcome = await runFirefoxSample(
          prepared[role], sample, binary, driverBinary, role,
        );
        if (outcome.processResult) samples[role].processes.push(outcome.processResult);
        else samples[role].failures.push(outcome.failure);
      }
    }
    return {
      candidate: await buildFirefoxResult(
        measurements.candidate,
        prepared.candidate,
        samples.candidate.processes,
        samples.candidate.failures,
        binary,
        driverBinary,
      ),
      base: await buildFirefoxResult(
        measurements.base,
        prepared.base,
        samples.base.processes,
        samples.base.failures,
        binary,
        driverBinary,
      ),
      schedule,
    };
  } finally {
    for (const role of ['candidate', 'base']) {
      try { await assertPreparedArtifactsUnchanged(`Firefox ${role}`, prepared[role]); }
      finally { cleanupPreparedArtifacts(prepared[role]); }
    }
  }
};

export const main = async () => {
  if (options.help === true || options.help === 'true') {
    console.log('usage: bun run bench:cold-sw -- --lane=<local|device|pr|main|release> [--browser=<all|chrome|firefox>] [--runtime-target=<release|native-floor>] [--comparison=<absolute-ratchet|interleaved-candidate-base>]');
    console.log('Fixed lanes use the exact checked-in sample, timeout, graph, and timing profile.');
    return;
  }
  if (!['all', 'chrome', 'firefox'].includes(browserChoice)) {
    throw new Error('--browser must be all, chrome, or firefox');
  }
  if (!['ratchet', 'target'].includes(graphPolicy)) {
    throw new Error('--graph-policy must be ratchet or target');
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const processor = cpus()[0];
  const commitSha = gitValue(['rev-parse', 'HEAD']);
  const baseCommitSha = gitValue(['merge-base', 'HEAD', 'origin/main']) ?? (lane === 'local' ? commitSha : null);
  const status = gitValue(['status', '--porcelain']);
  if (!commitSha || !baseCommitSha || status === null) {
    throw new Error('cold-start evidence requires a readable Git commit, merge base, and worktree status');
  }
  const dirty = status !== '';
  if ((nativeFloor || lane === 'device') && dirty) {
    throw new Error(`${nativeFloor ? 'native-floor' : 'device'} evidence requires a clean committed worktree`);
  }
  const host = {
    platform: process.platform,
    release: osRelease(),
    arch: process.arch,
    kernel: {
      platform: process.platform,
      release: osRelease(),
      arch: process.arch,
    },
    runnerImage: {
      os: process.env.ImageOS ?? null,
      version: process.env.ImageVersion ?? null,
    },
    runner: {
      os: process.env.RUNNER_OS ?? null,
      arch: process.env.RUNNER_ARCH ?? null,
    },
    cpu: processor?.model ?? 'unknown',
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
  };
  const hostSha256 = createHash('sha256').update(JSON.stringify(host)).digest('hex');
  const comparisonSources = comparisonMode === 'interleaved-candidate-base'
    ? materializeComparisonSources(commitSha, baseCommitSha)
    : null;
  const measurements = comparisonSources
    ? Object.fromEntries(['candidate', 'base'].map((role) => {
      const source = comparisonSources.roles[role];
      return [role, {
        role,
        clock: 'host-monotonic:node-hrtime',
        lane,
        runtimeTarget,
        runtimeSurface,
        coldBudgetMode: role === 'candidate' ? coldBudgetMode : 'measure-only',
        nativeFloor: null,
        sourceCommitSha: source.commitSha,
        sourcePackageVersion: source.packageVersion,
        sourceDirty: false,
        sourceArchiveSha256: source.sourceArchiveSha256,
        sourceTreeSha256: source.sourceTreeSha256,
        sourceTreeSha256Before: source.sourceTreeSha256,
        hostSha256,
      }];
    }))
    : {
      candidate: {
        role: 'candidate',
        clock: 'host-monotonic:node-hrtime',
        lane,
        runtimeTarget,
        runtimeSurface,
        coldBudgetMode,
        nativeFloor: nativeFloor ? NATIVE_FLOOR_CONTRACT : null,
        sourceCommitSha: commitSha,
        sourcePackageVersion: VERSION,
        sourceDirty: dirty,
        hostSha256,
      },
    };
  try {
  const report = {
    schema: 3,
    measuredAt: new Date().toISOString(),
    packageVersion: VERSION,
    lane,
    runtimeTarget,
    runtimeSurface,
    coldBudgetMode,
    nativeFloor: nativeFloor ? NATIVE_FLOOR_CONTRACT : null,
    commitSha,
    baseCommitSha,
    dirty,
    hostSha256,
    comparison: {
      mode: comparisonMode,
      reason: comparisonMode === 'absolute-ratchet'
        ? 'Required CI enforces absolute release ceilings; interleaved comparison remains separate cutover evidence.'
        : 'Candidate and merge-base commits were packaged by the same candidate toolchain and alternated per sample on one host.',
      ...(comparisonSources ? { scheduleByBrowser: {} } : {}),
    },
    targetCutover: COLD_START_TARGET_CUTOVER,
    options: {
      browser: browserChoice,
      runtimeTarget,
      runtimeSurface,
      coldBudgetMode,
      enforcement: laneContract.enforcement,
      graphPolicy,
      requireTimingTargets,
      coldTimeoutMs,
      chromeProcesses,
      chromeWakes,
      firefoxProcesses,
      firefoxWakes,
      firefoxIdleMs,
      allowFailures,
      unsafeNoSandbox,
    },
    host,
    note: nativeFloor
      ? 'Local native-floor diagnostic: Chrome runs the exact one-module release-minified copied Store kernel artifact named by archiveSha256 in three independent fresh profiles, with one confirmed-stop wake per profile. Every raw sample binds the native assembly identity and exact worker-relative timing schema while host-monotonic raw maxima remain gated at three seconds. Store runs physically; Preview contributes a separately hashed native graph. CDP cannot open the browser-owned side panel, so the runtime CTA is measured on the exact tab-owned Home authority surface. Full browser launch remains reported but is not charged to the service worker. This does not change or claim the live release manifest.'
      : 'Every browser runs the exact unsigned Store artifact named by archiveSha256 and records both Store and Preview cold graphs against their own immutable archive/tree digests. Browser launch/install to visible shell, bootstrap, state and actionable-vault clocks are host-monotonic; page/worker clocks are diagnostic only and no benchmark source is injected into the extension.',
    results: {},
    ...(comparisonSources ? { baseResults: {}, pairAssessments: {} } : {}),
  };
  if (browserChoice === 'all' || browserChoice === 'chrome') {
    if (comparisonSources) {
      const pair = await benchmarkChromePair(measurements, comparisonSources);
      report.results.chrome = pair.candidate;
      report.baseResults.chrome = pair.base;
      report.comparison.scheduleByBrowser.chrome = pair.schedule;
    } else {
      report.results.chrome = await benchmarkChrome(measurements.candidate);
    }
    report.results.chrome.assessment = assessColdStartResult('chrome', report.results.chrome, {
      graphPolicy, requireTimingTargets, lane,
    });
    console.log(JSON.stringify(report.results.chrome, null, 2));
  }
  if (browserChoice === 'all' || browserChoice === 'firefox') {
    try {
      if (comparisonSources) {
        const pair = await benchmarkFirefoxPair(measurements, comparisonSources);
        report.results.firefox = pair.candidate;
        report.baseResults.firefox = pair.base;
        report.comparison.scheduleByBrowser.firefox = pair.schedule;
      } else {
        report.results.firefox = await benchmarkFirefox(measurements.candidate);
      }
    } catch (error) {
      let packaged = {};
      try { packaged = await packagedGraphStats('firefox'); } catch { /* packaging may also have failed */ }
      report.results.firefox = {
        browser: 'firefox',
        unavailable: true,
        failed: true,
        error: error?.message ?? String(error),
        ...packaged,
      };
    }
    report.results.firefox.assessment = assessColdStartResult('firefox', report.results.firefox, {
      graphPolicy, requireTimingTargets, lane,
    });
    console.log(JSON.stringify(report.results.firefox, null, 2));
  }
  if (comparisonSources) {
    assertComparisonSourcesUnchanged(comparisonSources, measurements);
    for (const browser of Object.keys(report.results)) {
      if (!report.baseResults[browser]) continue;
      report.pairAssessments[browser] = assessColdStartPair(
        browser, report.results[browser], report.baseResults[browser], {
          graphPolicy, requireTimingTargets, lane,
        },
      );
    }
  }
  report.assessment = assessColdStartReport(report, {
    expectedLane: lane,
    expectedCommitSha: commitSha,
    expectedBaseCommitSha: baseCommitSha,
    requireClean: ['device', 'release'].includes(lane) || nativeFloor,
  });
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${OUTPUT}`);
  const failures = Object.values(report.results).filter((result) =>
    result?.failed || result?.unavailable || result?.assessment?.ok === false);
  if ((failures.length || report.assessment.ok === false) && !allowFailures) {
    console.error(`cold service-worker benchmark failed in ${failures.map((result) => result.browser ?? 'unknown').join(', ')}`);
    process.exitCode = 1;
  }
  } finally {
    if (comparisonSources) {
      try { assertComparisonSourcesUnchanged(comparisonSources, measurements); }
      finally { rmSync(comparisonSources.root, { recursive: true, force: true }); }
    }
  }
};

if (import.meta.main) await main();
