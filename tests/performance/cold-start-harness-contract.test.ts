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

  test('does not silently switch a required lane onto the not-yet-required pair gate', () => {
    const run = spawnSync(process.execPath, [
      harness, '--lane=pr', '--comparison=interleaved-candidate-base', '--help',
    ], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not a required-lane gate');
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
      ['--graph-policy=integrity', '--graph-policy cannot alter the immutable pr lane'],
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
      ['--graph-policy=integrity', '--graph-policy cannot alter the immutable device lane'],
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

  test('release runner binds two packaged graphs and the actionable Home surface', async () => {
    const text = await Bun.file(harness).text();
    expect(text).toContain("for (const channel of ['store', 'preview'])");
    expect(text).toContain('prepareHistoricalBrowserArtifacts');
    expect(text).toContain("'packaging/package.ts', `--channel=${channel}`");
    expect(text).toContain("coldBudgetMode: 'measure-only'");
    expect(text).not.toContain('...(hostQuiescence');
    expect(text).toContain("const runtimeSurface = 'home'");
    expect(text).toContain("const surfacePath = 'home/home.html'");
    expect(text).not.toContain("'sidepanel/sidepanel.html'");
    expect(text).toContain('wakeSamples: sample < chromeWakes ? 1 : 0');
    expect(text).toContain('vaultGateReadyFromWorkerTargetMs');
    expect(text).toContain('deadlineAt = hostNowMs() + coldTimeoutMs');
    expect(text).toContain('exactChromeWorkerVersion(');
    expect(text).toContain("{ runningStatus: 'running' }");
    expect(text).not.toContain("row.scriptURL.endsWith(backgroundEntry)");
    expect(text).not.toContain("worker.send('Runtime.runIfWaitingForDebugger'");
    expect(text).toContain("location.href === 'about:blank'");
    expect(text).not.toContain('native-floor');
    expect(text).not.toContain('native-target');
  });
});
