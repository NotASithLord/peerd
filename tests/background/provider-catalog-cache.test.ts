import { describe, expect, test } from 'bun:test';
import { createProviderEgressAuthority } from '../../extension/background/provider-egress-authority.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';
import { providerModelContextWindow } from '../../extension/peerd-provider/index.js';

const grant = (owner = {}) => ({ owner, permitsProvider: (name: string) => name === 'openrouter' });
const input = { providerId: 'openrouter', modelId: 'z-ai/glm-5.1' };
const response = () => Response.json({ data: [{ id: input.modelId, context_length: 200_000 }] });
const setup = (overrides: Record<string, any> = {}) => {
  let reads = 0;
  const authority = createProviderEgressAuthority({
    vault: { getSecret: async () => 'test-key', captureRequestAuthority: () => () => true },
    settingsStore: { get: () => ({}) },
    safeFetch: async () => { reads += 1; return response(); }, ...overrides,
  });
  return { authority, reads: () => reads };
};

describe('host model catalog cache', () => {
  test('fresh model clients preserve the real served window through the host cache', async () => {
    let reads = 0;
    const authority = createProviderEgressAuthority({
      vault: { getSecret: async () => 'fixture-key', captureRequestAuthority: () => () => true },
      settingsStore: { get: () => ({}) },
      safeFetch: async () => { reads += 1; return Response.json({ data: [{ id: input.modelId,
        context_length: 256_000, top_provider: { context_length: 200_000 } }] }); },
    });
    for (let index = 0; index < 3; index += 1) {
      const modelEgress = { readModelContext: async () => {
        const reply = await authority.readModelContext(input, grant());
        if (!reply.ok || !reply.value) throw new Error('live model window unavailable');
        return new Response(reply.value.body, { status: reply.value.status, headers: reply.value.headers });
      } } as any;
      expect(await providerModelContextWindow('openrouter', input.modelId, { modelEgress })).toBe(200_000);
    }
    expect(reads).toBe(1);
  });
  test('fresh owners and both metadata operations share one bounded response without shared mutable bytes', async () => {
    let now = 0;
    const h = setup({ now: () => now });
    const first = await h.authority.readModelContext(input, grant());
    expect(first).toMatchObject({ ok: true, value: { status: 200 } });
    if (!first.ok || !first.value) throw new Error('missing catalog');
    first.value.body.fill(0);
    const second = await h.authority.readModelInventory({ providerId: 'openrouter' }, grant());
    expect(h.reads()).toBe(1);
    expect(new TextDecoder().decode(second.value?.body)).toContain('200000');
    if (second.value) second.value.headers.changed = 'caller mutation';
    expect((await h.authority.readModelContext(input, grant())).value?.headers.changed).toBeUndefined();
    now += 10 * 60_000;
    expect((await h.authority.readModelContext(input, grant())).ok).toBe(true);
    expect(h.reads()).toBe(2);
  });

  test('cache hits still refuse forbidden, retired and aborted owners', async () => {
    const h = setup();
    await h.authority.readModelContext(input, grant());
    const retired = grant();
    await h.authority.closeOwner(retired.owner);
    const aborted = new AbortController(); aborted.abort();
    for (const permit of [retired, { ...grant(), signal: aborted.signal }, { ...grant(), permitsProvider: () => false }]) {
      expect(await h.authority.readModelContext(input, permit)).toMatchObject({ ok: false, outcomeKnown: true });
    }
    expect(h.reads()).toBe(1);
  });

  test('the real vault revokes cached metadata on credential change and lock', async () => {
    const values = new Map<string, any>();
    const vault = createVault({ autoLockMs: 0, kv: {
      get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); },
      delete: async (key) => { values.delete(key); }, list: async (prefix = '') => Object.fromEntries(
        [...values].filter(([key]) => key.startsWith(prefix))), clear: async () => values.clear(),
    } });
    try {
      await vault.initializeWithPrfOnly({ credentialId: new Uint8Array([1, 2, 3]),
        prfSalt: new Uint8Array(32).fill(4), prfOutput: new Uint8Array(32).fill(5), transports: ['internal'] });
      await vault.setSecret('openrouter_api_key', 'first-test-key');
      const h = setup({ vault });
      await h.authority.readModelContext(input, grant());
      await vault.setSecret('openrouter_api_key', 'second-test-key');
      await h.authority.readModelContext(input, grant());
      expect(h.reads()).toBe(2);
      vault.lock();
      expect(await h.authority.readModelContext(input, grant())).toMatchObject({ ok: false, outcomeKnown: true });
      expect(h.reads()).toBe(2);
    } finally { vault.lock(); }
  });

  test.each(['http', 'json', 'shape'])('a failed %s catalog is not retained', async (kind) => {
    let reads = 0;
    const h = setup({ safeFetch: async () => {
      reads += 1;
      return reads > 1 ? response() : kind === 'http' ? new Response('unavailable', { status: 503 })
        : kind === 'json' ? new Response('{') : Response.json({ data: null });
    } });
    await h.authority.readModelContext(input, grant());
    await h.authority.readModelContext(input, grant());
    expect(reads).toBe(2);
    await h.authority.readModelInventory({ providerId: 'openrouter' }, grant());
    expect(reads).toBe(2);
  });

  test('a held metadata connect times out and its late response cannot enter the cache', async () => {
    let resolve!: (value: Response) => void;
    let signal: AbortSignal | null = null;
    let reads = 0;
    const h = setup({ probeTimeoutMs: 10, safeFetch: async (_url: unknown, init: RequestInit) => {
      reads += 1; signal = init.signal ?? null;
      return reads === 1 ? new Promise<Response>((done) => { resolve = done; }) : response();
    } });
    const started = performance.now();
    expect(await h.authority.readModelContext(input, grant())).toMatchObject({ ok: false, outcomeKnown: true });
    expect(performance.now() - started).toBeLessThan(250);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    resolve(response());
    await new Promise((done) => setTimeout(done, 0));
    expect((await h.authority.readModelContext(input, grant())).ok).toBe(true);
    expect(reads).toBe(2);
  });

  test('a held response body also times out and is cancelled', async () => {
    let cancelled = 0;
    const h = setup({ probeTimeoutMs: 10, safeFetch: async () => new Response(new ReadableStream({
      cancel: () => { cancelled += 1; },
    })) });
    expect(await h.authority.readModelContext(input, grant())).toMatchObject({ ok: false, outcomeKnown: true });
    expect(cancelled).toBe(1);
  });
});
