import { expect, test } from 'bun:test';
import { activityEventMeta } from '../../extension/options/sections/activity.js';

test('adding the Chat rooms app reads under the name Discover and the Library show', () => {
  expect(activityEventMeta({ type: 'dweb_seed_installed', details: { appId: 'app-commons' } }))
    .toEqual({ label: 'Chat rooms app installed', level: 'ok' });
});
