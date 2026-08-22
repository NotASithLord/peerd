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
    expect(run.stderr).toContain('not a required-lane gate before target cutover');
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

  test('native floor is one fixed clean Chrome fresh-and-wake target', () => {
    const base = [harness, '--lane=local', '--browser=chrome', '--runtime-target=native-floor'];
    const accepted = spawnSync(process.execPath, [...base, '--help'], { encoding: 'utf8' });
    expect(accepted.status).toBe(0);

    const attacks = [
      ['--chrome-wakes=0', 'requires exactly one fresh launch and one wake'],
      ['--chrome-processes=2', 'requires exactly one fresh launch and one wake'],
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
      expect(text).toContain("coldBudgetMode: 'native-target'");
      expect(text).toContain("extensionDir: prepared.store.extensionDir");
      expect(text).toContain('wakeSamples: sample < chromeWakes ? 1 : 0');
      expect(text).toContain('vaultGateReadyFromWorkerTargetMs');
      expect(text).toContain("requireClean: lane === 'release' || nativeFloor");
      expect(text).not.toContain('runNativeFloorChromeProcess');
    });
  });
});
