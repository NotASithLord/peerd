import { expect, test } from 'bun:test';
import { activityEventMeta } from '../../extension/options/sections/activity.js';

test('web request uncertainty is visible under Issues without claiming a known failure', () => {
  expect(activityEventMeta({ type: 'web_fetch', details: { method: 'POST', outcome: 'unknown' } }))
    .toEqual({ label: 'web request', level: 'warn' });
  expect(activityEventMeta({ type: 'web_fetch', details: { method: 'GET' } }))
    .toEqual({ label: 'web request', level: 'info' });
});
