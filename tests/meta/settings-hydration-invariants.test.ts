// The service worker cannot be imported under Bun because it registers browser
// listeners at module load. Pin the cold-start ordering statically: every UI
// snapshot must wait for persisted settings before it resolves the active
// provider, or an Ollama/Local-WebGPU install can be projected as keyless
// Anthropic until another state push happens (issue #384).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const serviceWorker = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');

describe('settings hydration before UI state snapshots', () => {
  test('waits for persisted settings before reading session or provider state', () => {
    const start = serviceWorker.indexOf('const buildStateSnapshot = async () => {');
    const end = serviceWorker.indexOf('const pushState = async () => {', start);
    const snapshot = serviceWorker.slice(start, end);
    const hydration = snapshot.indexOf('await settingsReady;');
    const sessionRead = snapshot.indexOf("sessionCache.sessionGet('currentSessionId')");
    const providerRead = snapshot.indexOf('const activeProv = resolveActiveProvider();');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(hydration).toBeGreaterThan(-1);
    expect(sessionRead).toBeGreaterThan(hydration);
    expect(providerRead).toBeGreaterThan(hydration);
  });

  test('the readiness promise is the persisted settings load', () => {
    expect(serviceWorker).toContain('const settingsReady = loadSettings();');
  });
});
