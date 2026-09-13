import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

describe('test module resolution', () => {
  test('imports live copied modules from their exact extension and verifier roots', async () => {
    const roots = [
      mkdtempSync(join(tmpdir(), 'peerd-module-resolution-')),
      mkdtempSync(join(tmpdir(), 'peerd-verify-resolution-')),
    ];
    try {
      const files = [
        join(roots[0], 'extension', 'shared', 'cold-util.js'),
        join(roots[1], 'shared', 'cold-util.js'),
      ];
      const modules = [];
      for (const [index, file] of files.entries()) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `export const fixture = ${index}; export const source = import.meta.url;\n`);
        const module = await import(`${pathToFileURL(file).href}?isolation=${index}`);
        expect(module.fixture).toBe(index);
        expect(realpathSync(fileURLToPath(module.source))).toBe(realpathSync(file));
        modules.push(module);
      }
      expect(modules[0]).not.toBe(modules[1]);
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps browser-root imports bound to the current extension', async () => {
    const browserRoot = await import('/shared/cold-util.js');
    const source = await import('../../extension/shared/cold-util.js');
    expect(browserRoot).toBe(source);
    expect(browserRoot.bytesToBase64(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });
});
