// The service worker registers browser listeners at module load and cannot be
// imported under Bun. Pin the no-await delivery boundary statically: a delayed
// old actor snapshot must not overwrite a newer reused-id actor-start.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  INITIAL_STATE, resetChatAfterRuntimeLoss,
} from '../../extension/sidepanel/chat-reducer.js';

const stateSnapshot = readFileSync(join(EXTENSION_DIR, 'background/state-snapshot.js'), 'utf8');

describe('actor live snapshot ordering', () => {
  test('captures the projection only after awaited reads and broadcasts without another await', () => {
    const vaultRead = stateSnapshot.indexOf(
      'const vaultInitialized = await vault.isInitialized();',
    );
    const actorCapture = stateSnapshot.indexOf(
      'const liveActors = actorLiveProjection.snapshot(',
    );

    expect(vaultRead).toBeGreaterThan(-1);
    expect(actorCapture).toBeGreaterThan(vaultRead);
    expect(stateSnapshot.slice(actorCapture)).not.toContain('await ');
  });

  test('disconnect reset drops worker-owned live projections and keeps durable posture', () => {
    const prior = {
      ...INITIAL_STATE,
      hydrated: true,
      projection: { authorityEpoch: 'old', generation: 9 },
      vault: { ...INITIAL_STATE.vault, initialized: true, locked: false, unlockedAt: 42 },
      providers: { ...INITIAL_STATE.providers, current: 'openai', hasKey: true },
      pendingConfirm: { id: 'stale' },
      streaming: true,
      actorProjectionEpoch: 'actor-old',
      actorProjectionRevision: 17,
      actors: { stale: { streaming: true } },
      spawned: { byToolUse: { stale: 'child' }, sessions: {} },
      asyncTasks: { stale: { status: 'running' } },
    } as any;
    const reset = resetChatAfterRuntimeLoss(prior) as any;
    expect(reset).toMatchObject({
      hydrated: false,
      projection: null,
      vault: { initialized: true, locked: true, unlockedAt: 0 },
      providers: { current: 'openai', hasKey: false },
      pendingConfirm: null,
      streaming: false,
      actorProjectionEpoch: INITIAL_STATE.actorProjectionEpoch,
      actorProjectionRevision: INITIAL_STATE.actorProjectionRevision,
    });
    expect(reset.actors).toBe(INITIAL_STATE.actors);
    expect(reset.spawned).toBe(INITIAL_STATE.spawned);
    expect(reset.asyncTasks).toBe(INITIAL_STATE.asyncTasks);
  });
});
