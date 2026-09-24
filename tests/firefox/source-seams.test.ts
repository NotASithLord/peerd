import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  injectFirefoxKeepaliveLossFault,
  injectFirefoxLifetimeProbe,
} from '../../scripts/firefox/source-seams.mjs';

describe('Firefox diagnostic artifact source seams', () => {
  test('keeps packaged direct-controller Stop and Goal in the physical runtime gate', () => {
    const source = readFileSync(join(import.meta.dir,
      '../../scripts/firefox/run-runtime-tests.mjs'), 'utf8');
    const start = source.indexOf('const runDirectControllerStopGoalSmoke =');
    const end = source.indexOf('const runBoundActorSmoke =', start);
    const lane = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(lane).toContain("type: 'agent/stop'");
    expect(lane).toContain('providerServer.rootStopAborts - stopAbortStart === 1');
    expect(lane).toContain("type: 'agent/send', text: prompt, goal: true");
    expect(lane).toContain('goalRecords.length === 3');
    expect(lane).toContain("message?.synthetic === true");
    expect(lane).toContain('probeRecords.length === 1');
    expect(source).toContain("FIREFOX_RUNTIME_ONLY === 'controller-lifecycle'");
    expect(source.match(/await runDirectControllerStopGoalSmoke\(driver, providerServer\);/g))
      .toHaveLength(2);
    expect(source.indexOf('await runDirectControllerStopGoalSmoke(driver, providerServer);'))
      .toBeLessThan(source.indexOf('await runPrivateNetworkDnrSmoke(driver, providerServer);'));
  });

  test('injects the lifetime probe into readable and release-minified source', () => {
    const source = readFileSync(join(import.meta.dir,
      '../../extension/background/kernel-feature-host.js'), 'utf8');
    const transpiler = new Bun.Transpiler({
      loader: 'js', target: 'browser', minifyWhitespace: true,
      deadCodeElimination: false, inline: false, treeShaking: false,
      trimUnusedImports: false,
    });
    for (const candidate of [source, transpiler.transformSync(source)]) {
      const output = injectFirefoxLifetimeProbe(candidate);
      expect(output).toContain('peerdFirefoxLifetimeProbe?.record(');
      expect(output).toMatch(/\?\.onChanged\s*\(/);
    }
  });

  test('injects the heartbeat fault into current and release-minified source', () => {
    const source = readFileSync(join(import.meta.dir,
      '../../extension/background/firefox-storage-keepalive.js'), 'utf8');
    const transpiler = new Bun.Transpiler({
      loader: 'js', target: 'browser', minifyWhitespace: true,
      deadCodeElimination: false, inline: false, treeShaking: false,
      trimUnusedImports: false,
    });
    for (const candidate of [source, transpiler.transformSync(source)]) {
      const output = injectFirefoxKeepaliveLossFault(candidate);
      expect(output).toContain('peerdFirefoxKeepaliveLossFault?.consume()');
      expect(output).toContain("Promise.reject(new Error('Firefox runtime test fault");
    }
    expect(() => injectFirefoxKeepaliveLossFault(readFileSync(join(import.meta.dir,
      '../../extension/background/direct-actor-host.js'), 'utf8'))).toThrow(/matched 0 locations/);
  });

  test('fails closed when a semantic anchor is absent or duplicated', () => {
    expect(() => injectFirefoxLifetimeProbe('export const x = 1;')).toThrow(/matched 0 locations/);
    expect(() => injectFirefoxLifetimeProbe(
      `const first = registry?.event?.("storage.session.onChanged", storage.onChanged);
       first.addListener((changes) => { A?.onChanged(changes); });
       const second = registry?.event?.("storage.session.onChanged", storage.onChanged);
       second.addListener((changes) => { B?.onChanged(changes); });`,
    )).toThrow(/matched 2 locations/);
  });
});
