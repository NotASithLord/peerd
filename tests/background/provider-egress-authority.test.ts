import { describe, expect, test } from 'bun:test';
import { createProviderEgressAuthority } from '../../extension/background/provider-egress-authority.js';

const makeGrant = (owner: object, signal?: AbortSignal) => ({
  owner,
  signal,
  maxOutputTokens: 256,
  permits: (providerId: string, modelId: string) =>
    providerId === 'anthropic' && modelId === 'claude-test',
  permitsProvider: (providerId: string) => providerId === 'anthropic',
  redeemOpaque: (token: string) => token === 'opaque:1' ? 'BASE64-PLAINTEXT' : null,
});

describe('fixed provider egress authority', () => {
  test('pins destination, credential and transport while redeeming only provider media fields', async () => {
    const calls: Array<{ resource: string; init?: RequestInit }> = [];
    const authority = createProviderEgressAuthority({
      safeFetch: async (resource, init) => {
        calls.push({ resource: String(resource), init });
        return new Response('event: message_stop\ndata: {}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-private': 'hidden' },
        });
      },
      vault: { getSecret: async (name) => name === 'anthropic_api_key' ? 'vault-key' : null },
      settingsStore: { get: () => ({ ollamaHost: 'http://localhost:11434' }) },
      newId: () => 'stream-1',
    });
    const owner = {};
    const request = {
      providerId: 'anthropic',
      modelId: 'claude-test',
      nativeBody: {
        model: 'claude-test', stream: true, max_tokens: 128, system: '',
        messages: [{ role: 'user', content: [{
          type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'opaque:1' },
        }] }],
      },
    };
    const opened = await authority.openInference(request, makeGrant(owner));

    expect(opened).toMatchObject({ ok: true, outcomeKnown: true,
      value: { streamId: 'stream-1', status: 200, hasBody: true } });
    expect((opened as any).value.headers).toEqual({ 'content-type': 'text/event-stream' });
    expect(calls).toHaveLength(1);
    expect(calls[0].resource).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init?.headers).toMatchObject({
      'x-api-key': 'vault-key', 'anthropic-version': '2023-06-01',
    });
    expect(String(calls[0].init?.body)).toContain('BASE64-PLAINTEXT');
    expect(String(calls[0].init?.body)).not.toContain('opaque:1');
    expect(await authority.openInference({
      ...request,
      url: 'https://attacker.invalid',
    }, makeGrant(owner))).toMatchObject({
      ok: false, code: 'model-egress-request-invalid', outcomeKnown: true,
    });
    expect(calls).toHaveLength(1);
  });

  test('binds streams to their owner and reports pre-response network loss as unknown', async () => {
    const owner = {};
    const other = {};
    const authority = createProviderEgressAuthority({
      safeFetch: async () => new Response('chunk'),
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
      newId: () => 'stream-2',
    });
    const request = {
      providerId: 'anthropic', modelId: 'claude-test',
      nativeBody: {
        model: 'claude-test', stream: true, max_tokens: 128,
        system: '', messages: [{ role: 'user', content: 'hello' }],
      },
    };
    expect(await authority.openInference(request, makeGrant(owner)))
      .toMatchObject({ ok: true, value: { streamId: 'stream-2' } });
    expect(await authority.readInferenceChunk({ streamId: 'stream-2' }, makeGrant(other)))
      .toMatchObject({ ok: false, code: 'model-egress-stream-invalid', outcomeKnown: true });
    expect(await authority.readInferenceChunk({ streamId: 'stream-2' }, makeGrant(owner)))
      .toMatchObject({ ok: true, value: { done: false } });

    const failed = createProviderEgressAuthority({
      safeFetch: async () => {
        throw new TypeError('connection reset at https://api.anthropic.com/v1/messages');
      },
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
    });
    const failure = await failed.openInference(request, makeGrant({}));
    expect(failure).toMatchObject({
      ok: false, code: 'model-egress-connect-failed', outcomeKnown: false, retryable: false,
    });
    expect((failure as any).error).toBe('model-egress-connect-failed');
    expect((failure as any).error).not.toContain('https://');
  });

  test('refuses unbound providers, models and output limits before network entry', async () => {
    let fetches = 0;
    const authority = createProviderEgressAuthority({
      safeFetch: async () => { fetches += 1; return new Response(); },
      vault: { getSecret: async () => 'vault-key' },
      settingsStore: { get: () => ({}) },
    });
    const owner = {};
    const base = {
      providerId: 'anthropic', modelId: 'claude-test',
      nativeBody: {
        model: 'claude-test', stream: true, max_tokens: 128,
        system: '', messages: [{ role: 'user', content: 'hello' }],
      },
    };
    expect(await authority.openInference({ ...base, modelId: 'other' }, makeGrant(owner)))
      .toMatchObject({ ok: false, code: 'model-egress-request-invalid' });
    expect(await authority.openInference({
      ...base, nativeBody: { ...base.nativeBody, max_tokens: 257 },
    }, makeGrant(owner))).toMatchObject({ ok: false, code: 'model-egress-output-limit-denied' });
    expect(fetches).toBe(0);
  });

  test('keeps credential failure details inside authority custody', async () => {
    const authority = createProviderEgressAuthority({
      safeFetch: async () => { throw new Error('must not fetch'); },
      vault: { getSecret: async () => { throw new Error('anthropic_api_key leaked'); } },
      settingsStore: { get: () => ({}) },
    });
    const result = await authority.openInference({
      providerId: 'anthropic', modelId: 'claude-test',
      nativeBody: { model: 'claude-test', stream: true, messages: [], max_tokens: 64 },
    }, makeGrant({}));
    expect(result).toEqual({
      ok: false,
      code: 'model-egress-credential-unavailable',
      error: 'model-egress-credential-unavailable',
      outcomeKnown: true,
    });
    expect(JSON.stringify(result)).not.toContain('anthropic_api_key');
  });
});
