import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIREFOX_BACKGROUND_ENTRY,
  generateManifest,
  NATIVE_BACKGROUND_ENTRY,
  PREVIEW_CHROME_BACKGROUND_ENTRY,
  targetBackgroundEntry,
} from '../../packaging/gen-manifest.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { genChannelConfigSource } from '../../packaging/gen-channel-config.ts';

const EXTENSION = join(import.meta.dir, '..', '..', 'extension');

describe('target-specific native background entry', () => {
  test('generated Chrome entry matches its dweb build posture', () => {
    for (const channel of ['store', 'preview', 'dev'] as const) {
      const manifest = generateManifest({ channel, browser: 'chrome', version: '0.0.0' });
      const config = genChannelConfigSource(channel === 'dev' ? 'preview' : channel, 'chrome');
      const dweb = config.includes('export const DWEB_ENABLED = true;');
      expect(manifest.background.service_worker, channel).toBe(dweb
        ? PREVIEW_CHROME_BACKGROUND_ENTRY : NATIVE_BACKGROUND_ENTRY);
    }
  });

  test('adds Preview custody to dweb-enabled Chrome targets', () => {
    expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, 'preview', 'chrome'))
      .toBe(PREVIEW_CHROME_BACKGROUND_ENTRY);
    expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, 'dev', 'chrome'))
      .toBe(PREVIEW_CHROME_BACKGROUND_ENTRY);
    expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, 'store', 'chrome'))
      .toBe(NATIVE_BACKGROUND_ENTRY);
    for (const channel of ['store', 'preview', 'dev'] as const) {
      expect(targetBackgroundEntry(NATIVE_BACKGROUND_ENTRY, channel, 'firefox'))
        .toBe(FIREFOX_BACKGROUND_ENTRY);
    }
  });

  test('registers Firefox custody before the shared kernel evaluates', () => {
    const source = readFileSync(join(
      import.meta.dir, '..', '..', 'extension', FIREFOX_BACKGROUND_ENTRY,
    ), 'utf8');
    expect(source.indexOf("import './kernel-firefox-addon.js'"))
      .toBeLessThan(source.indexOf("import './vault-kernel.js'"));
  });

  test('statically owns the Firefox direct controller without entering Chrome', async () => {
    const firefox = await collectStaticModuleGraph(
      EXTENSION, join(EXTENSION, FIREFOX_BACKGROUND_ENTRY),
    );
    const chrome = await collectStaticModuleGraph(
      EXTENSION, join(EXTENSION, NATIVE_BACKGROUND_ENTRY),
    );
    for (const leaf of [
      'background/direct-controller-client.js',
      'background/firefox-storage-keepalive.js',
    ]) {
      const path = join(EXTENSION, leaf);
      expect(firefox.has(path), leaf).toBe(true);
      expect(chrome.has(path), leaf).toBe(false);
    }
    const kernel = readFileSync(join(EXTENSION, 'background', 'vault-kernel.js'), 'utf8');
    expect(kernel).not.toContain("import('./firefox-storage-keepalive.js')");
    expect(kernel).toContain('makeFirefoxGuard.connectDirectController');
  });

  test('generates target-exact browser ownership for every channel', () => {
    for (const channel of ['store', 'preview', 'dev'] as const) {
      const firefox = generateManifest({ channel, browser: 'firefox', version: '0.0.0' });
      expect(firefox.background).toEqual({
        scripts: [FIREFOX_BACKGROUND_ENTRY], type: 'module',
      });
      expect(firefox.permissions).toContain('webRequest');
      expect(firefox.permissions).toContain('webRequestBlocking');
      for (const permission of ['sidePanel', 'offscreen', 'debugger', 'tabGroups']) {
        expect(firefox.permissions).not.toContain(permission);
      }
      for (const key of ['side_panel', 'sandbox', 'update_url', 'key']) {
        expect(firefox).not.toHaveProperty(key);
      }

      const chrome = generateManifest({ channel, browser: 'chrome', version: '0.0.0' });
      expect(chrome.background).toEqual({
        service_worker: channel !== 'store'
          ? PREVIEW_CHROME_BACKGROUND_ENTRY : NATIVE_BACKGROUND_ENTRY,
        type: 'module',
      });
      expect(chrome.permissions).not.toContain('webRequest');
      expect(chrome.permissions).not.toContain('webRequestBlocking');
      expect(chrome).not.toHaveProperty('sidebar_action');
      expect(chrome).not.toHaveProperty('browser_specific_settings');
    }
  });
});
