// The service worker registers browser listeners at module load and cannot be
// imported under Bun. Pin the no-await delivery boundary statically: a delayed
// old actor snapshot must not overwrite a newer reused-id actor-start.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const serviceWorker = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');
const sidepanel = readFileSync(join(EXTENSION_DIR, 'sidepanel/sidepanel.js'), 'utf8');

describe('actor live snapshot ordering', () => {
  test('captures the projection only after awaited reads and broadcasts without another await', () => {
    const start = serviceWorker.indexOf('const buildStateSnapshot = async () => {');
    const end = serviceWorker.indexOf('const pushState = async () => {', start);
    const buildStateSnapshot = serviceWorker.slice(start, end);
    const vaultRead = buildStateSnapshot.indexOf(
      'const vaultInitialized = await vault.isInitialized();',
    );
    const actorCapture = buildStateSnapshot.indexOf(
      'const liveActors = actorLiveProjection.snapshot(',
    );

    expect(vaultRead).toBeGreaterThan(-1);
    expect(actorCapture).toBeGreaterThan(vaultRead);
    expect(buildStateSnapshot.slice(actorCapture)).not.toContain('await ');
  });

  test('disconnect resets the worker epoch and revision with the live actor projection', () => {
    const start = sidepanel.indexOf('const handlePortDisconnect = () => {');
    const end = sidepanel.indexOf('connectPort();', start);
    const disconnect = sidepanel.slice(start, end);
    expect(disconnect).toContain('actors: INITIAL_STATE.actors');
    expect(disconnect).toContain('actorProjectionEpoch: INITIAL_STATE.actorProjectionEpoch');
    expect(disconnect).toContain('actorProjectionRevision: INITIAL_STATE.actorProjectionRevision');
  });
});
