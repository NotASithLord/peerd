import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

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

const boundaryRegex = async (): Promise<RegExp> => {
  // Read the LIVE config object rather than scraping the source. The rule's
  // pattern is a JS string full of backslashes, and un-escaping it by hand is
  // both fragile and a genuine incomplete-sanitization bug - importing gives
  // the exact value ESLint itself enforces.
  const config = (await import('../../eslint.config.js')).default as Array<{
    rules?: Record<string, unknown>;
  }>;
  for (const block of config) {
    const rule = block.rules?.['no-restricted-imports'];
    if (!Array.isArray(rule)) continue;
    const options = rule[1] as { patterns?: Array<{ regex?: string }> } | undefined;
    for (const pattern of options?.patterns ?? []) {
      if (pattern.regex?.includes('peerd-')) return new RegExp(pattern.regex);
    }
  }
  throw new Error('no cross-module import regex in eslint.config.js');
};

describe('cross-module import boundary', () => {
  test('every peerd-* module on disk is inside the gate', async () => {
    const regex = await boundaryRegex();
    const names = moduleNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(regex.test(`/${name}/internal/deep.js`)).toBe(true);
    }
  });

  test('a hyphenated module name does not escape the gate', async () => {
    // The exact shape that was slipping through.
    expect((await boundaryRegex()).test('/peerd-voice-host/internal/deep.js')).toBe(true);
  });

  test('the declared public entry points stay reachable', async () => {
    const regex = await boundaryRegex();
    for (const name of moduleNames()) {
      for (const entry of ['index.js', 'background.js', 'offscreen.js']) {
        expect(regex.test(`/${name}/${entry}`)).toBe(false);
      }
    }
  });
});
