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
    // vault-kernel.js is an explicitly isolated, test-only manifest target.
    // The release manifest still names service-worker.js; its package contract
    // separately proves the kernel cannot enter the release artifact matrix.
    expect(registrations).toEqual([
      'background/service-worker.js',
      'background/vault-kernel.js',
    ]);
  });

  test('Chrome actor jobs and relays are absent from runtime messaging', () => {
    const serviceWorker = stripComments(readFileSync(
      join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8',
    ));
    const offscreen = stripComments(readFileSync(
      join(EXTENSION_DIR, 'offscreen/offscreen.js'), 'utf8',
    ));
    const supervisorChannels = stripComments(readFileSync(
      join(EXTENSION_DIR, 'offscreen/supervisor-channels.js'), 'utf8',
    ));
    const dispatcher = serviceWorker.slice(
      serviceWorker.indexOf('browser.runtime.onMessage.addListener'),
    );
    expect(dispatcher).not.toContain('actorClient?.routes');
    expect(offscreen).not.toMatch(/['"]actor\/(?:run|abort)['"]/);
    expect(serviceWorker).toContain('makeOffscreenActorChannelClient');
    expect(offscreen).toContain('registerServiceWorkerChannels');
    expect(supervisorChannels).toContain("event.data?.type !== ACTOR_CHANNEL_OFFER");
    expect(supervisorChannels).toContain('bindActorChannel');
  });

  test('no source aliases onConnect outside the guarded registration', () => {
    const offenders = filesUnder(EXTENSION_DIR)
      .filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
      .filter((path) => relative(EXTENSION_DIR, path) !== 'background/service-worker.js')
      .filter((path) => /\bonConnect\b/.test(stripComments(readFileSync(path, 'utf8'))));
    expect(offenders.map((path) => relative(EXTENSION_DIR, path))).toEqual([
      'background/vault-kernel-assembly.js',
      'background/cold-kernel-capture.js',
      'background/cold-kernel-inventory.js',
      'background/vault-kernel.js',
    ]);
  });

  test('the production listener disconnects every trusted but unknown Port', () => {
    const serviceWorker = stripComments(readFileSync(
      join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8',
    ));
    const start = serviceWorker.indexOf("coldEvent('runtime.onConnect'");
    const end = serviceWorker.indexOf('\nvault.subscribe(', start);
    const listener = serviceWorker.slice(start, end);
    expect(listener).toContain('dwebCustodyClient.attach');
    expect(listener).toMatch(/dwebCustodyClient\.attach[\s\S]*?return;[\s\S]*?port\.disconnect\(\)/);
  });
});
