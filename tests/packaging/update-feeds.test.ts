import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genUpdateFeeds } from '../../packaging/gen-update-feeds.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('update feed release assets', () => {
  test('writes only the two browser feeds into the requested artifact directory', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'peerd-update-feeds-'));
    temporaryDirectories.push(outDir);

    genUpdateFeeds({ version: '9.8.7', repo: 'example/peerd', outDir });

    expect(readdirSync(outDir).sort()).toEqual([
      'chrome-preview.xml',
      'firefox-preview.json',
    ]);

    const chrome = readFileSync(join(outDir, 'chrome-preview.xml'), 'utf8');
    expect(chrome).toContain('version="9.8.7"');
    expect(chrome).toContain(
      'https://github.com/example/peerd/releases/download/v9.8.7/peerd-preview-chrome.crx',
    );

    const firefox = JSON.parse(
      readFileSync(join(outDir, 'firefox-preview.json'), 'utf8'),
    ) as {
      addons: Record<string, {
        updates: Array<{ version: string; update_link: string }>;
      }>;
    };
    const update = Object.values(firefox.addons)[0].updates[0];
    expect(update.version).toBe('9.8.7');
    expect(update.update_link).toBe(
      'https://github.com/example/peerd/releases/download/v9.8.7/peerd-preview-firefox.xpi',
    );
  });
});
