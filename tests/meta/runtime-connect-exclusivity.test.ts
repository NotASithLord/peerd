// Firefox backup transfer uses one exact-sender background Port. Chrome uses a
// targeted WindowClient MessageChannel because runtime Ports can have multiple
// receivers. Keep both boundaries fail-closed in CI.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const filesUnder = (directory: string): string[] => readdirSync(directory)
  .flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

describe('runtime Port receiver exclusivity', () => {
  test('only the kernel registers runtime.onConnect', () => {
    const registrations = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .flatMap((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        const direct = [...source.matchAll(/\bruntime\.onConnect\.addListener\s*\(/g)].length;
        const captured = [...source.matchAll(
          /\bcoldEvent\(\s*['"]runtime\.onConnect['"]\s*,\s*browser\.runtime\.onConnect\s*\)\.addListener\s*\(/g,
        )].length;
        const registered = [...source.matchAll(
          /\bkernelEvents\.event\(\s*['"]runtime\.onConnect['"]\s*,\s*browser\.runtime\.onConnect\s*,[\s\S]{0,160}?\)\s*\?*\.addListener\s*\(/g,
        )].length;
        const count = direct + captured + registered;
        return Array.from({ length: count }, () => relative(EXTENSION_DIR, path));
      });
    expect(registrations).toEqual(['background/vault-kernel.js']);
  });

  test('no source aliases onConnect outside the guarded registration', () => {
    const offenders = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .filter((path) => /\bonConnect\b/.test(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders.map((path) => relative(EXTENSION_DIR, path))).toEqual([
      'background/vault-kernel-assembly.js',
      'background/cold-kernel-capture.js',
      'background/cold-kernel-inventory.js',
      'background/vault-kernel.js',
    ]);
  });

});
