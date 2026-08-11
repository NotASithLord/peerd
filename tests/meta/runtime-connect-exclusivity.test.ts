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

  test('Chrome actor jobs and relays are absent from runtime messaging', () => {
    const serviceWorker = stripComments(readFileSync(
      join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8',
    ));
    const offscreen = stripComments(readFileSync(
      join(EXTENSION_DIR, 'offscreen/offscreen.js'), 'utf8',
    ));
    const dispatcher = serviceWorker.slice(
      serviceWorker.indexOf('browser.runtime.onMessage.addListener'),
    );
    expect(dispatcher).not.toContain('actorClient?.routes');
    expect(offscreen).not.toMatch(/['"]actor\/(?:run|abort)['"]/);
    expect(serviceWorker).toContain('makeOffscreenActorChannelClient');
    expect(offscreen).toContain('bindActorChannel');
  });

  test('no source aliases onConnect outside the guarded registration', () => {
    const offenders = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .filter((path) => relative(EXTENSION_DIR, path) !== 'background/service-worker.js')
      .filter((path) => /\bonConnect\b/.test(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders.map((path) => relative(EXTENSION_DIR, path))).toEqual([]);
  });
});
