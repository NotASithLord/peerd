import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = join(import.meta.dir, '..', '..', 'scripts', 'bench', 'cold-service-worker.mjs');

describe('cold-start browser harness contract', () => {
  test('imports without launching browsers or packaging artifacts', async () => {
    const module = await import('../../scripts/bench/cold-service-worker.mjs');
    expect(typeof module.main).toBe('function');
    expect(module.interleavedRoleOrder(1)).toEqual(['base', 'candidate']);
    expect(module.interleavedRoleOrder(2)).toEqual(['candidate', 'base']);
  });

  test('measures a fixed CPU window and fails closed on a busy host', async () => {
    const { assessHostQuiescence, measureHostQuiescence } = await import(
      '../../scripts/bench/cold-service-worker.mjs'
    );
    const quiet = assessHostQuiescence({
      before: { idle: 100, total: 1_000 },
      after: { idle: 900, total: 2_000 },
      load1: 5,
      logicalCpus: 10,
      windowMs: 1_000,
    });
    expect(quiet.ok).toBe(true);
    expect(quiet.busyFraction).toBe(0.2);
    expect(quiet.load1PerCpu).toBe(0.5);

    let read = 0;
    let waited = 0;
    const measured = await measureHostQuiescence({
      readCpus: () => [{
        model: 'test', speed: 1,
        times: read++ === 0
          ? { idle: 100, user: 900, nice: 0, sys: 0, irq: 0 }
          : { idle: 500, user: 1_500, nice: 0, sys: 0, irq: 0 },
      }],
      readLoad1: () => 1,
      wait: async (ms: number) => { waited = ms; },
    });
    expect(waited).toBe(1_000);
    expect(measured.ok).toBe(false);
    expect(measured.failures.join(' ')).toContain('busyFraction');
  });

  test('matches only the exact service-worker script and state', async () => {
    const { exactChromeWorkerVersion } = await import(
      '../../scripts/bench/cold-service-worker.mjs'
    );
    const scriptURL = 'chrome-extension://abc/background/vault-kernel.js';
    const exact = { scriptURL, status: 'activated', runningStatus: 'running' };
    const sibling = { ...exact, scriptURL: `${scriptURL}?forged` };
    expect(exactChromeWorkerVersion([sibling, exact], scriptURL, {
      runningStatus: 'running',
    })).toBe(exact);
    expect(exactChromeWorkerVersion([sibling], scriptURL, { status: 'activated' })).toBeNull();
  });

  test('derives the worker target from the exact packaged manifest entry', async () => {
    const module = await import('../../scripts/bench/cold-service-worker.mjs');
    const root = mkdtempSync(join(tmpdir(), 'peerd-cold-entry-contract-'));
    mkdirSync(join(root, 'background'));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      background: { service_worker: 'background/vault-kernel.js', type: 'module' },
    }));
    expect(module.packagedBackgroundEntry(root, 'chrome'))
      .toBe('background/vault-kernel.js');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      background: { scripts: ['background/vault-kernel.js'], type: 'module' },
    }));
    expect(module.packagedBackgroundEntry(root, 'firefox'))
      .toBe('background/vault-kernel.js');
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      background: { service_worker: '../outside.js', type: 'module' },
    }));
    expect(() => module.packagedBackgroundEntry(root, 'chrome')).toThrow();
  });

  test('native floor accepts honest migration assembly but rejects identity or target forgery', async () => {
    const { inspectNativeFloorAssembly } = await import(
      '../../scripts/bench/cold-service-worker.mjs'
    );
    const candidate = {
      identity: {
        schema: 1 as const, buildId: `0.7.3:${'a'.repeat(64)}`,
        bootId: 'native-floor-boot', kernelEpoch: 'native-floor-epoch',
      },
      target: { firefox: false, selfHostedChrome: false },
      cutoverReady: false,
      semantic: { schema: 2, total: 161, migrated: 86, ready: false },
      missingRequiredEvents: ['runtime.onStartup'],
    };
    const accepted = inspectNativeFloorAssembly(candidate);
    expect(accepted.report).toBe(candidate);
    expect(accepted.identity).toEqual(candidate.identity);
    expect(candidate.cutoverReady).toBe(false);
    expect(() => inspectNativeFloorAssembly({
      ...candidate, identity: { ...candidate.identity, forged: true },
    })).toThrow('assembly identity is invalid');
    expect(() => inspectNativeFloorAssembly({
      ...candidate, target: { firefox: false, selfHostedChrome: true },
    })).toThrow('assembly target posture is invalid');
  });

  test('does not silently switch a required lane onto the not-yet-required pair gate', () => {
    const run = spawnSync(process.execPath, [
      harness, '--lane=pr', '--comparison=interleaved-candidate-base', '--help',
    ], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not a required-lane gate before target cutover');
  });

  test('device lane accepts the interleaved pair gate without launching browsers', () => {
    const run = spawnSync(process.execPath, [
      harness, '--lane=device', '--comparison=interleaved-candidate-base', '--help',
    ], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('local|device|pr|main|release');
    expect(run.stderr).toBe('');
  });

  test('has a runnable side-effect-free help path', () => {
    const run = spawnSync(process.execPath, [harness, '--help'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('usage: bun run bench:cold-sw');
    expect(run.stderr).toBe('');
  });

  test('required lane cardinality cannot be weakened or inflated', () => {
    for (const processes of ['6', '8']) {
      const run = spawnSync(process.execPath, [
        harness, '--lane=pr', `--chrome-processes=${processes}`, '--help',
      ], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('--chrome-processes cannot alter the immutable pr lane');
    }
  });

  test('required lane timeout, discard, graph, timing, and browser posture are immutable', () => {
    const attacks = [
      ['--cold-timeout-ms=10001', '--cold-timeout-ms cannot alter the immutable pr lane'],
      ['--firefox-idle-ms=1', '--firefox-idle-ms cannot alter the immutable pr lane'],
      ['--graph-policy=ratchet', '--graph-policy cannot alter the immutable pr lane'],
      ['--require-timing-targets=false', '--require-timing-targets cannot alter the immutable pr lane'],
      ['--browser=chrome', 'the pr lane requires --browser=all'],
    ];
    for (const [attack, message] of attacks) {
      const run = spawnSync(process.execPath, [harness, '--lane=pr', attack, '--help'], {
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(message);
    }
  });

  test('device lane sample, safety, timing, and browser posture are immutable', () => {
    const attacks = [
      ['--chrome-processes=14', '--chrome-processes cannot alter the immutable device lane'],
      ['--firefox-processes=14', '--firefox-processes cannot alter the immutable device lane'],
      ['--firefox-wakes=14', '--firefox-wakes cannot alter the immutable device lane'],
      ['--firefox-idle-ms=1', '--firefox-idle-ms cannot alter the immutable device lane'],
      ['--graph-policy=ratchet', '--graph-policy cannot alter the immutable device lane'],
      ['--require-timing-targets=false', '--require-timing-targets cannot alter the immutable device lane'],
      ['--browser=firefox', 'the device lane requires --browser=all'],
      ['--allow-failures=true', '--allow-failures is local-only'],
      ['--no-sandbox=true', '--no-sandbox is local-only'],
    ];
    for (const [attack, message] of attacks) {
      const run = spawnSync(process.execPath, [harness, '--lane=device', attack, '--help'], {
        encoding: 'utf8',
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(message);
    }
  });

  test('native floor is one fixed clean Chrome three-profile fresh-and-wake target', () => {
    const base = [harness, '--lane=local', '--browser=chrome', '--runtime-target=native-floor'];
    const accepted = spawnSync(process.execPath, [...base, '--help'], { encoding: 'utf8' });
    expect(accepted.status).toBe(0);

    const attacks = [
      ['--chrome-wakes=2', 'requires exactly three fresh launches and three wakes'],
      ['--chrome-wakes=4', 'requires exactly three fresh launches and three wakes'],
      ['--chrome-processes=2', 'requires exactly three fresh launches and three wakes'],
      ['--chrome-processes=4', 'requires exactly three fresh launches and three wakes'],
      ['--graph-policy=ratchet', 'requires target graph policy'],
      ['--require-timing-targets=false', 'requires the timing target'],
      ['--allow-failures=true', 'cannot allow failures'],
      ['--comparison=interleaved-candidate-base', 'does not support comparison mode'],
    ];
    for (const [attack, message] of attacks) {
      const run = spawnSync(process.execPath, [...base, attack, '--help'], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(message);
    }
  });

  test('native floor reuses the release runner and binds two release-minified graphs', () => {
    const source = Bun.file(harness).text();
    return source.then((text) => {
      expect(text).toContain("for (const channel of ['store', 'preview'])");
      expect(text).toContain('releaseMinify: true');
      expect(text).toContain("mkdtempSync(join(tmpdir(), 'peerd-cold-native-artifacts-'))");
      expect(text).toContain('releaseMinify: true, artifactRoot');
      expect(text).toContain("coldBudgetMode: 'native-target'");
      expect(text).toContain('NATIVE_FLOOR_CONTRACT.freshProcesses');
      expect(text).toContain('NATIVE_FLOOR_CONTRACT.confirmedStopWakes');
      expect(text).toContain("const runtimeSurface = 'home'");
      expect(text).toContain("const surfacePath = 'home/home.html'");
      expect(text).not.toContain("'sidepanel/sidepanel.html'");
      expect(text).toContain("extensionDir: prepared.store.extensionDir");
      expect(text).toContain('wakeSamples: sample < chromeWakes ? 1 : 0');
      expect(text).toContain('vaultGateReadyFromWorkerTargetMs');
      expect(text).toContain('assemblyIdentity');
      expect(text).toContain('inspectNativeFloorAssembly(bootstrap.reply?.assembly)');
      expect(text).toContain('deadlineAt = hostNowMs() + coldTimeoutMs');
      expect(text).toContain('Bootstrap, assembly and');
      expect(text).toContain('exactChromeWorkerVersion(');
      expect(text).toContain("{ runningStatus: 'running' }");
      expect(text).toContain("kind: 'host-overloaded'");
      expect(text).not.toContain("row.scriptURL.endsWith(backgroundEntry)");
      expect(text).not.toContain("worker.send('Runtime.runIfWaitingForDebugger'");
      expect(text).toContain("location.href === 'about:blank'");
      expect(text).toContain("requireClean: ['device', 'release'].includes(lane) || nativeFloor");
      expect(text).not.toContain('runNativeFloorChromeProcess');
    });
  });
});
