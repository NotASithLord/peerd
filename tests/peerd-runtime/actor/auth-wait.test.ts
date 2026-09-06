import { describe, expect, test } from 'bun:test';
import { authWaitGate } from '../../../extension/peerd-runtime/tools/gates.js';

describe('auth wait parks the complete actor capability surface', () => {
  test('DOM, code, fetch, cache, site-client, delegation, and login all stop', () => {
    for (const name of [
      'snapshot', 'page_code', 'fetch_url', 'read_result',
      'site_client_read', 'site_client_run', 'message_actor', 'login',
    ]) {
      expect(authWaitGate({ name } as any, {}, { authWaitingForUser: true } as any))
        .toEqual({ allowed: false, reason: 'auth_waiting_for_user' });
    }
  });

  test('the gate disappears after the live context builder verifies exact home', () => {
    expect(authWaitGate({ name: 'snapshot' } as any, {}, { authWaitingForUser: false } as any).allowed)
      .toBe(true);
  });
});
