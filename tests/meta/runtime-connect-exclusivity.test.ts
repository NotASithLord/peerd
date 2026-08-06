// Confidential extension Ports rely on one shipped runtime.onConnect receiver.
// Chrome permits multiple receivers, so adding a listener anywhere outside the
// service worker would turn offscreen or options-originated messages into a
// broadcast. Keep that architectural boundary fail-closed in CI.

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
  test('only the service worker registers runtime.onConnect', () => {
    const registrations = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .flatMap((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        const count = [...source.matchAll(/\bruntime\.onConnect\.addListener\s*\(/g)].length;
        return Array.from({ length: count }, () => relative(EXTENSION_DIR, path));
      });
    expect(registrations).toEqual(['background/service-worker.js']);
  });

  test('no source aliases onConnect outside the guarded registration', () => {
    const offenders = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .filter((path) => relative(EXTENSION_DIR, path) !== 'background/service-worker.js')
      .filter((path) => /\bonConnect\b/.test(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders.map((path) => relative(EXTENSION_DIR, path))).toEqual([]);
  });
});
