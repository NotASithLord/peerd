import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR, REPO_ROOT } from '../../packaging/lib.ts';

/**
 * `no-restricted-imports` is what makes "index.js is the public API per module"
 * an enforced rule rather than a convention, and it enforces it through ONE
 * regex. That regex is the whole gate, and a character class is an easy place
 * to be quietly wrong.
 *
 * why this test: the class was `[a-z]+`, which stops at the first hyphen - so
 * `peerd-voice-host` sat outside the boundary entirely and a deep import into
 * it would have linted clean. Nothing failed, because the module happens to
 * contain only index.js today. This asserts the regex covers every module that
 * actually exists, so adding a hyphenated one cannot reopen the hole.
 */
const moduleNames = (): string[] => readdirSync(EXTENSION_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('peerd-'))
  .map((entry) => entry.name);

const boundaryRegex = (): RegExp => {
  const config = readFileSync(join(REPO_ROOT, 'eslint.config.js'), 'utf8');
  const match = /regex:\s*'((?:[^'\\]|\\.)*)'/.exec(config);
  if (!match) throw new Error('no cross-module import regex in eslint.config.js');
  return new RegExp(JSON.parse(`"${match[1].replace(/"/g, '\\"')}"`));
};

describe('cross-module import boundary', () => {
  test('every peerd-* module on disk is inside the gate', () => {
    const regex = boundaryRegex();
    const names = moduleNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(regex.test(`/${name}/internal/deep.js`)).toBe(true);
    }
  });

  test('a hyphenated module name does not escape the gate', () => {
    // The exact shape that was slipping through.
    expect(boundaryRegex().test('/peerd-voice-host/internal/deep.js')).toBe(true);
  });

  test('the declared public entry points stay reachable', () => {
    const regex = boundaryRegex();
    for (const name of moduleNames()) {
      for (const entry of ['index.js', 'background.js', 'offscreen.js']) {
        expect(regex.test(`/${name}/${entry}`)).toBe(false);
      }
    }
  });
});
