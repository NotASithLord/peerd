import { describe, expect, test } from 'bun:test';
import { fetchJson, HttpRequestError } from '../../gtm/lib/http.ts';

describe('GTM HTTP client', () => {
  test('paces successful requests to one origin', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const options = {
      fetchImpl: (async (_input: string | URL | Request) => Response.json({ ok: true })) as typeof fetch,
      minimumIntervalMs: 25,
      nowImpl: () => now,
      sleepImpl: async (milliseconds: number) => { sleeps.push(milliseconds); now += milliseconds; },
    };

    await fetchJson('https://pace.example/one', options);
    await fetchJson('https://pace.example/two', options);

    expect(sleeps).toEqual([25]);
  });

  test('stops a request after its timeout', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;

    await expect(fetchJson('https://timeout.example/data', {
      fetchImpl,
      maxAttempts: 1,
      minimumIntervalMs: 0,
      timeoutMs: 1,
    })).rejects.toMatchObject({ status: 0, url: 'https://timeout.example/data' });
  });

  test('retries network and transient failures with backoff', async () => {
    const responses: Array<Error | Response> = [
      new TypeError('offline'),
      new Response(null, { status: 503 }),
      Response.json({ ok: true }),
    ];
    const sleeps: number[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ accept: 'application/json', authorization: 'token' });
      const response = responses.shift()!;
      if (response instanceof Error) throw response;
      return response;
    }) as typeof fetch;

    const result = await fetchJson<{ ok: boolean }>('https://api.example/data', {
      fetchImpl,
      headers: { authorization: 'token' },
      maxAttempts: 3,
      minimumIntervalMs: 0,
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    });

    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([1000, 2000]);
  });

  test('waits for a rate reset within the attempt limit', async () => {
    const responses = [
      new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      }),
      Response.json({ ok: true }),
    ];
    const sleeps: number[] = [];
    const fetchImpl = (async (_input: string | URL | Request) => responses.shift()!) as typeof fetch;

    await expect(fetchJson('https://api.example/data', {
      fetchImpl,
      maxAttempts: 2,
      minimumIntervalMs: 0,
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    })).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  test('stops repeated rate resets at the attempt limit', async () => {
    let fetches = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async (_input: string | URL | Request) => {
      fetches++;
      return new Response(null, {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      });
    }) as typeof fetch;

    await expect(fetchJson('https://api.example/data', {
      fetchImpl,
      maxAttempts: 2,
      minimumIntervalMs: 0,
      sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    })).rejects.toMatchObject({ status: 403 });
    expect(fetches).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  for (const status of [403, 429, 503]) {
    for (const retryAfter of ['60', 'Tue, 06 Oct 2026 12:01:00 GMT']) {
      test(`honors Retry-After ${retryAfter} on ${status}`, async () => {
        const sleeps: number[] = [];
        let calls = 0;
        const result = await fetchJson('https://retry.example/data', {
          fetchImpl: (async (_input: string | URL | Request) => ++calls === 1
            ? new Response(null, { status, headers: { 'retry-after': retryAfter } })
            : Response.json({ ok: true })) as typeof fetch,
          nowImpl: () => Date.parse('2026-10-06T12:00:00Z'),
          sleepImpl: async (delay) => { sleeps.push(delay); },
          minimumIntervalMs: 0,
          maxAttempts: 2,
        });
        expect(result).toEqual({ ok: true });
        expect(sleeps).toEqual([60_000]);
      });
    }
  }

  test('Retry-After remains bounded by the attempt count', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(fetchJson('https://retry.example/data', {
      fetchImpl: (async (_input: string | URL | Request) => {
        calls++;
        return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
      }) as typeof fetch,
      nowImpl: () => Date.parse('2026-10-06T12:00:00Z'),
      sleepImpl: async (delay) => { sleeps.push(delay); },
      minimumIntervalMs: 0,
      maxAttempts: 2,
    })).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([60_000]);
  });

  test('invalid Retry-After falls back to transient backoff', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await fetchJson('https://retry.example/data', {
      fetchImpl: (async (_input: string | URL | Request) => ++calls === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': 'invalid' } })
        : Response.json({ ok: true })) as typeof fetch,
      sleepImpl: async (delay) => { sleeps.push(delay); },
      minimumIntervalMs: 0,
      maxAttempts: 2,
    });
    expect(sleeps).toEqual([1000]);
  });

  for (const retryAfter of ['9'.repeat(100), '9'.repeat(400), '2147484']) {
    test(`rejects excessive retry delay without sleeping or retrying: ${retryAfter}`, async () => {
      let calls = 0;
      const sleeps: number[] = [];
      await expect(fetchJson('https://retry.example/data', {
        fetchImpl: (async (_input: string | URL | Request) => {
          calls++;
          return new Response(null, { status: 429, headers: { 'retry-after': retryAfter } });
        }) as typeof fetch,
        sleepImpl: async (delay) => { sleeps.push(delay); },
        minimumIntervalMs: 0,
      })).rejects.toMatchObject({ status: 429, message: 'server retry delay exceeds one day; retry this crawl later' });
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    });
  }

  test('returns status and URL for a permanent HTTP error', async () => {
    const fetchImpl = (async (_input: string | URL | Request) =>
      new Response('denied', { status: 401 })) as typeof fetch;

    try {
      await fetchJson('https://api.example/private', { fetchImpl, minimumIntervalMs: 0 });
      throw new Error('expected fetchJson to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRequestError);
      expect(error).toMatchObject({ status: 401, url: 'https://api.example/private' });
    }
  });
});
