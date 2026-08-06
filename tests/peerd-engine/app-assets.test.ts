import { describe, expect, test } from 'bun:test';
import {
  BINARY_ASSET_EXTENSIONS,
  appFileCheckpointContent,
  inferAppFileKind,
  isBinaryAppFile,
  isBinaryAssetPath,
  isLosslessUtf8Text,
} from '../../extension/peerd-engine/app-assets.js';

describe('App binary asset classification', () => {
  test('recognizes shipped byte-oriented formats case-insensitively', () => {
    for (const path of ['engine.wasm', 'IMAGE.PNG', 'audio/clip.ogg', 'font.woff2', 'model.glb']) {
      expect(isBinaryAssetPath(path)).toBe(true);
    }
  });

  test('keeps composed source formats on the text path', () => {
    for (const path of ['index.html', 'style.css', 'app.js', 'data.json', 'icon.svg', 'game.wasm.map']) {
      expect(isBinaryAssetPath(path)).toBe(false);
    }
  });

  test('the extension registry stays normalized', () => {
    for (const extension of BINARY_ASSET_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase());
    }
  });

  test('unknown binary bytes stay binary without relying on the suffix', () => {
    const archiveHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(inferAppFileKind('asset.custom', archiveHeader)).toBe('binary');
    expect(isBinaryAppFile('asset.custom', archiveHeader, undefined)).toBe(true);
  });

  test('explicit binary provenance wins even when bytes look like text', () => {
    const bytes = new TextEncoder().encode('binary protocol header');
    expect(inferAppFileKind('asset.custom', bytes)).toBe('text');
    expect(isBinaryAppFile('asset.custom', bytes, 'binary')).toBe(true);
  });

  test('UTF-8 text with a BOM round-trips losslessly', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('<h1>x</h1>')]);
    expect(isLosslessUtf8Text(bytes)).toBe(true);
    expect(inferAppFileKind('index.html', bytes)).toBe('text');
  });

  test('checkpoint markers detect binary add, change, and delete without decoding', async () => {
    const first = await appFileCheckpointContent('asset.custom', new Uint8Array([0xff, 0x00]), 'binary');
    const changed = await appFileCheckpointContent('asset.custom', new Uint8Array([0xff, 0x01]), 'binary');
    expect(first).toStartWith('\u0000peerd-binary:2:');
    expect(changed).not.toBe(first);
    expect(await appFileCheckpointContent('index.html', new TextEncoder().encode('hello'), 'text')).toBe('hello');
  });
});
