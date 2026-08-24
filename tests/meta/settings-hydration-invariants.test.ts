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
const statePushController = readFileSync(join(EXTENSION_DIR, 'background/state-push.js'), 'utf8');
const stateSnapshot = readFileSync(join(EXTENSION_DIR, 'background/state-snapshot.js'), 'utf8');

describe('settings hydration before UI state snapshots', () => {
  test('waits for persisted settings before reading session or provider state', () => {
    const hydration = stateSnapshot.indexOf('await ensureSettingsReady();');
    const sessionRead = stateSnapshot.indexOf("sessionCache.sessionGet('currentSessionId')");
    const providerRead = stateSnapshot.indexOf('const activeProv = resolveActiveProvider();');

    expect(hydration).toBeGreaterThan(-1);
    expect(sessionRead).toBeGreaterThan(hydration);
    expect(providerRead).toBeGreaterThan(hydration);
    expect(serviceWorker).toContain('const buildStateSnapshot = makeStateSnapshotBuilder({');
  });

  test('the boot promise uses the retryable full settings hydration gate', () => {
    expect(serviceWorker).toContain('const settingsReady = ensureSettingsReady();');
    const gateStart = serviceWorker.indexOf('const ensureSettingsReady = () => {');
    const gateEnd = serviceWorker.indexOf('/**\n * Resolve the provider', gateStart);
    expect(serviceWorker.slice(gateStart, gateEnd)).toContain('loadSettings()');
  });

  test('distributed identity and publication paths fail closed before hydration', () => {
    expect(serviceWorker).toContain('active: () => settingsHydrated && settingsStore.get().dwebEnabled');
    expect(serviceWorker).toContain('dweb: (DWEB_ENABLED && settingsHydrated && settingsStore.get().dwebEnabled)');
    const wiringStart = serviceWorker.indexOf('...makeDwebRoutes({');
    const wiringEnd = serviceWorker.indexOf('...makeDwebSelfRoutes({', wiringStart);
    expect(serviceWorker.slice(wiringStart, wiringEnd)).toContain('ensureSettingsReady');
  });

  test('older asynchronous snapshots cannot overwrite a newer state push', () => {
    const built = statePushController.indexOf('const state = await build();');
    const guarded = statePushController.indexOf('if (dirty || !isConnected()) continue;');
    const delivered = statePushController.indexOf('await deliver(state);');

    expect(built).toBeGreaterThan(-1);
    expect(guarded).toBeGreaterThan(built);
    expect(delivered).toBeGreaterThan(guarded);
    expect(serviceWorker).toContain('build: buildStateSnapshot');
  });
});
