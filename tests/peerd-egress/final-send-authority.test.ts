import { describe, expect, test } from 'bun:test';
import {
  makeWebFetch, withWebRequestAuthority, withSessionScopedCredentials,
  withApiCredentials, withDpopCredentials,
} from '../../extension/peerd-egress/fetch/web-fetch.js';

describe('host-private final-send authority', () => {
  test('selects cookie scope after the last awaited assertion, ignoring forged callback fields', async () => {
    let origin = 'https://app.example';
    let checks = 0;
    let forged = 0;
    const calls: any[] = [];
    const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async (_url, init) => { calls.push(init); return new Response('ok'); }) as typeof fetch });
    const send = withWebRequestAuthority(withSessionScopedCredentials(raw, () => origin), async () => {
      checks += 1;
      await Promise.resolve();
      if (checks === 2) origin = 'https://other.example';
    });
    await send('https://app.example/write', { method: 'POST',
      assertCurrent: () => { forged += 1; }, requestAuthority: { checks: [] }, credentials: 'include' });
    expect(checks).toBe(2);
    expect(forged).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toBe('omit');
  });

  test.each(['api', 'dpop', 'dpop-anonymous'])('preserves authority through %s credential option copies', async (kind) => {
    let allowed = true;
    let calls = 0;
    const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
      pace: { canonicalOrigin: (origin) => origin, isWriteMethod: () => true,
        reserve: async () => { allowed = false; return { outcome: 'waited', waitedMs: 1 }; },
        observe: async () => {} },
      fetchFn: (async () => { calls += 1; return new Response('sent'); }) as unknown as typeof fetch });
    const getOrigin = () => kind === 'dpop-anonymous' ? null : 'https://app.example';
    const wrapped = kind === 'api'
      ? withApiCredentials(raw, getOrigin, { getSecret: async () => null })
      : withDpopCredentials(raw, getOrigin, { getSecret: async () => null, getDpopKey: async () => null });
    const send = withWebRequestAuthority(wrapped, () => { if (!allowed) throw new Error('revoked'); });
    await expect(send('https://app.example/write', { method: 'POST' })).rejects.toMatchObject({
      performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
    expect(calls).toBe(0);
  });

  test('preserves a Request signal through the final asynchronous assertion', async () => {
    const controller = new AbortController();
    let calls = 0;
    let checks = 0;
    const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async () => { calls += 1; return new Response('sent'); }) as unknown as typeof fetch });
    const send = withWebRequestAuthority(withSessionScopedCredentials(raw, () => 'https://app.example'), async () => {
      checks += 1;
      if (checks === 2) controller.abort();
    });
    await expect(send(new Request('https://app.example/write', { method: 'POST', signal: controller.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});
