import { expect, test } from 'bun:test';
import { activityEventMeta } from '../../extension/options/sections/activity.js';

test('a change of game internet access has a plain label in Activity', () => {
  const details = { kind: 'app-network', id: 'app-game', name: 'Racer' };
  expect(activityEventMeta({ type: 'permission_granted', details }))
    .toEqual({ label: 'internet access allowed', level: 'warn' });
  expect(activityEventMeta({ type: 'permission_revoked', details }))
    .toEqual({ label: 'internet access turned off', level: 'ok' });
});
