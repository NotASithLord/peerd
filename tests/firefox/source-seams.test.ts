import { describe, expect, test } from 'bun:test';
import {
  injectFirefoxKeepaliveLossFault,
  injectFirefoxLifetimeProbe,
} from '../../scripts/firefox/source-seams.mjs';

describe('Firefox diagnostic artifact source seams', () => {
  test('injects the lifetime probe into readable and release-minified source', () => {
    for (const source of [
      'function changed(changes) {\n    actorHostKeepAlive.onChanged(changes);\n}\n',
      'function changed(changes){actorHostKeepAlive.onChanged(changes)}\n',
    ]) {
      const output = injectFirefoxLifetimeProbe(source);
      expect(output).toContain('peerdFirefoxLifetimeProbe?.record(changes)');
      expect(output).toContain('actorHostKeepAlive.onChanged(changes)');
    }
  });

  test('injects the heartbeat fault into readable and release-minified source', () => {
    for (const source of [
      'async function beat() {\n    const write = storage.set({ [key]: value });\n}\n',
      'async function beat(){const write=storage.set({[key]:value});await write}\n',
    ]) {
      const output = injectFirefoxKeepaliveLossFault(source);
      expect(output).toContain('peerdFirefoxKeepaliveLossFault?.consume()');
      expect(output).toContain("Promise.reject(new Error('Firefox runtime test fault");
    }
  });

  test('fails closed when a semantic anchor is absent or duplicated', () => {
    expect(() => injectFirefoxLifetimeProbe('export const x = 1;')).toThrow(/matched 0 locations/);
    expect(() => injectFirefoxLifetimeProbe(
      'actorHostKeepAlive.onChanged(changes);actorHostKeepAlive.onChanged(changes);',
    )).toThrow(/matched 2 locations/);
  });
});
