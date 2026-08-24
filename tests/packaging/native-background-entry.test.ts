import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIREFOX_BACKGROUND_ENTRY,
  NATIVE_BACKGROUND_ENTRY,
  PREVIEW_CHROME_BACKGROUND_ENTRY,
  targetBackgroundEntry,
} from '../../packaging/gen-manifest.ts';

describe('target-specific native background entry', () => {
  test('adds update custody only to native Preview Chrome', () => {
    expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, 'preview', 'chrome'))
      .toBe(PREVIEW_CHROME_BACKGROUND_ENTRY);
    for (const [channel, browser] of [['store', 'chrome'], ['dev', 'chrome']] as const) {
      expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, channel, browser))
        .toBe(NATIVE_BACKGROUND_ENTRY);
    }
    for (const channel of ['store', 'preview', 'dev'] as const) {
      expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, channel, 'firefox'))
        .toBe(FIREFOX_BACKGROUND_ENTRY);
    }
  });

  test('does not rewrite the live legacy entry before atomic cutover', () => {
    for (const channel of ['store', 'preview', 'dev'] as const) {
      for (const browser of ['chrome', 'firefox'] as const) {
        expect(targetBackgroundEntry('background/service-worker.js', channel, browser))
          .toBe('background/service-worker.js');
      }
    }
  });

  test('registers Firefox custody before the shared kernel evaluates', () => {
    const source = readFileSync(join(
      import.meta.dir, '..', '..', 'extension', FIREFOX_BACKGROUND_ENTRY,
    ), 'utf8');
    expect(source.indexOf("import './kernel-firefox-addon.js'"))
      .toBeLessThan(source.indexOf("import './vault-kernel.js'"));
  });
});
