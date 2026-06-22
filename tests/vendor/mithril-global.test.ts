import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The app runtime injects vendor/mithril/mithril.global.js into sandboxed
// apps as a classic <script> so `window.m` is available. Guard the build
// contract: it must be a classic script (no ESM import/export statements)
// that assigns the global. If mithril.js is ever re-vendored, the global
// twin must be regenerated — this catches a botched/forgotten regen.
const src = readFileSync(
  fileURLToPath(new URL('../../extension/vendor/mithril/mithril.global.js', import.meta.url)),
  'utf8',
);

describe('mithril.global.js (app-facing classic build)', () => {
  test('has no top-level ESM export/import statements', () => {
    expect(/^\s*export\b/m.test(src)).toBe(false);
    expect(/^\s*import\b/m.test(src)).toBe(false);
  });

  test('assigns the global m', () => {
    expect(src.includes('window.m = m')).toBe(true);
  });

  test('still contains the Mithril core (sanity)', () => {
    expect(src.includes('function Vnode(')).toBe(true);
  });
});
