import { describe, expect, test } from 'bun:test';
import {
  NATIVE_BACKGROUND_ENTRY,
  PREVIEW_CHROME_BACKGROUND_ENTRY,
  targetBackgroundEntry,
} from '../../packaging/gen-manifest.ts';

describe('target-specific native background entry', () => {
  test('adds update custody only to native Preview Chrome', () => {
    expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, 'preview', 'chrome'))
      .toBe(PREVIEW_CHROME_BACKGROUND_ENTRY);
    for (const [channel, browser] of [
      ['store', 'chrome'], ['dev', 'chrome'], ['store', 'firefox'], ['preview', 'firefox'],
    ] as const) {
      expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, channel, browser))
        .toBe(NATIVE_BACKGROUND_ENTRY);
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
});
