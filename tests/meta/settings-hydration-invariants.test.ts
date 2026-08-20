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

describe('settings hydration before UI state snapshots', () => {
  test('waits for persisted settings before reading session or provider state', () => {
    const start = serviceWorker.indexOf('const buildStateSnapshot = async () => {');
    const end = serviceWorker.indexOf('const pushState = makeCoalescedStatePush({', start);
    const snapshot = serviceWorker.slice(start, end);
    const hydration = snapshot.indexOf('await ensureSettingsReady();');
    const sessionRead = snapshot.indexOf("sessionCache.sessionGet('currentSessionId')");
    // The snapshot must resolve the active provider through the READINESS-aware
    // resolver. The bare resolveActiveProvider falls back to Anthropic whenever
    // providerName is empty - the shipped default - which is the other half of
    // issue #384: hydration alone cannot save a projection that never asks
    // whether the provider it picked can serve a turn.
    const providerRead = snapshot.indexOf('const activeProv = await resolveActiveProviderForDisplay();');
    expect(snapshot).not.toContain('const activeProv = resolveActiveProvider();');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(hydration).toBeGreaterThan(-1);
    expect(sessionRead).toBeGreaterThan(hydration);
    expect(providerRead).toBeGreaterThan(hydration);
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
    const wiringEnd = serviceWorker.indexOf('}),', wiringStart);
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
