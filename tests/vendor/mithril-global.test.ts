import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { mithrilClassicSource } from '../../extension/engine-tabs/app-tab/mithril-classic-source.js';

// The App runtime derives its classic script from the one canonical ESM body.
// Guard both halves of that contract so a re-vendor cannot silently re-add a
// duplicate runtime or hand Apps source that still contains an ESM export.
const esmPath = fileURLToPath(
  new URL('../../extension/vendor/mithril/mithril.js', import.meta.url),
);
const removedGlobalPath = fileURLToPath(
  new URL('../../extension/vendor/mithril/mithril.global.js', import.meta.url),
);
const esmSource = readFileSync(
  esmPath,
  'utf8',
);
const classicSource = mithrilClassicSource(esmSource);

describe('Mithril App classic projection', () => {
  test('stores only one full Mithril runtime body', () => {
    expect(existsSync(removedGlobalPath)).toBe(false);
  });

  test('has no top-level ESM export/import statements', () => {
    expect(/^\s*export\b/m.test(classicSource)).toBe(false);
    expect(/^\s*import\b/m.test(classicSource)).toBe(false);
  });

  test('assigns the global m', () => {
    expect(classicSource.endsWith('window.m = m;\n')).toBe(true);
  });

  test('executes as a classic script', () => {
    const windowObject: Record<string, unknown> = {};
    runInNewContext(classicSource, { window: windowObject });
    expect(typeof windowObject.m).toBe('function');
  });

  test('still contains the Mithril core (sanity)', () => {
    expect(classicSource.includes('function Vnode(')).toBe(true);
  });

  test('is safe to inline inside a script element', () => {
    expect(/<\/script/i.test(classicSource)).toBe(false);
  });

  test('fails closed if the canonical export footer drifts', () => {
    expect(() => mithrilClassicSource(`${esmSource}\n// drift`))
      .toThrow('mithril-esm-footer-mismatch');
  });
});
