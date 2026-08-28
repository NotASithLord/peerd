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
