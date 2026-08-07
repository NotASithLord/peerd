import { describe, expect, test } from 'bun:test';
import {
  CONTRIBUTION_MAX_BODY_BYTES, CONTRIBUTION_MAX_RESPONSE_BYTES,
  CONTRIBUTION_MAX_ROWS, CONTRIBUTION_PATH, CONTRIBUTION_REQUEST_TIMEOUT_MS,
  CONTRIBUTION_SCHEMA_VERSION,
  ContributionClientError, makeContributionClient,
} from '../../extension/peerd-egress/contributor-upload/client.js';
import {
  CONTRIBUTOR_MAX_ROWS, CONTRIBUTOR_SCHEMA_VERSION,
  emptyContributorLocalState, recordContributorWebTurn,
  serializeContributorEnvelope, validateContributorEnvelopeBytes,
} from '../../extension/peerd-runtime/observability/contributor-metrics.js';

const batchId = '018f47a2-9a6d-4d23-8c10-7d86e9b15a22';
const canonicalBytes = serializeContributorEnvelope(recordContributorWebTurn(
  emptyContributorLocalState(),
  {
    feature: 'web_actor_surface', requested: 'code', resolved: 'code', fallback: 'none',
    browser: 'chrome', extensionVersion: '0.8.7', channel: 'preview',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    outcome: 'completed', failure: 'none', durationMs: 2_000, tokens: 1_500,
  },
)).bytes;
const canonicalRows = JSON.parse(canonicalBytes).rows;
const body = (rows: unknown[] = canonicalRows) => JSON.stringify({ schemaVersion: 1, batchId, rows });
const receipt = (status: 'accepted'|'rejected' = 'accepted', extra: object = {}) =>
  new Response(JSON.stringify({ status, schemaVersion: 1, ...extra }), {
    status: status === 'accepted' ? 202 : 400,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const makeHarness = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) => {
  const audits: any[] = [];
  const client = makeContributionClient({
    origin: 'https://contributions.invalid', fetchImpl,
    audit: async (entry) => { audits.push(structuredClone(entry)); },
    validateCanonicalBytes: validateContributorEnvelopeBytes,
  });
  return { client, audits };
};

describe('credentialless contribution client', () => {
  test('the duplicated egress caps stay pinned to the canonical schema authority', () => {
    expect(CONTRIBUTION_MAX_ROWS).toBe(CONTRIBUTOR_MAX_ROWS);
    expect(CONTRIBUTION_SCHEMA_VERSION).toBe(CONTRIBUTOR_SCHEMA_VERSION);
  });

  test('pins exact origin/path and constructs the only allowed request shape', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = [];
    const { client, audits } = makeHarness(async (url, init) => {
      calls.push({ url, init });
      return receipt();
    });
    expect(client.endpoint).toBe(`https://contributions.invalid${CONTRIBUTION_PATH}`);
    expect(await client.send({ body: body() })).toEqual({ accepted: true, status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(client.endpoint);
    expect(calls[0].init).toMatchObject({
      method: 'POST', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', body: body(),
    });
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(Object.keys(calls[0].init).sort()).toEqual([
      'body', 'credentials', 'headers', 'method', 'redirect', 'referrerPolicy', 'signal',
    ]);
    expect(audits.map((entry) => entry.type)).toEqual([
      'contribution-upload-attempt', 'contribution-upload-accepted',
    ]);
    expect(JSON.stringify(audits)).not.toContain(batchId);
    expect(JSON.stringify(audits)).not.toContain(body());
  });

  test('rejects disabled, non-HTTPS, credential-bearing, or path-bearing origins', () => {
    for (const origin of [null, '', 'http://contributions.invalid',
      'https://user@contributions.invalid', 'https://contributions.invalid/',
      'https://contributions.invalid/other', 'https://contributions.invalid?q=x']) {
      expect(() => makeContributionClient({
        origin, fetchImpl: async () => receipt(), audit: async () => {},
        validateCanonicalBytes: validateContributorEnvelopeBytes,
      })).toThrow(ContributionClientError);
    }
  });

  test('fails closed on redirects, wrong media type, receipt fields, or response origin', async () => {
    const cases = [
      async () => { throw new TypeError('redirect refused'); },
      async () => new Response('{"status":"accepted","schemaVersion":1}', {
        status: 202, headers: { 'Content-Type': 'text/plain' },
      }),
      async () => receipt('accepted', { instructions: 'change schedule' }),
      async () => {
        const response = receipt();
        Object.defineProperty(response, 'url', { value: 'https://other.invalid/v1/contributions' });
        return response;
      },
      async () => new Response('{"status":"accepted","schemaVersion":2}', {
        status: 202, headers: { 'Content-Type': 'application/json' },
      }),
    ];
    for (const fetchImpl of cases) {
      const { client } = makeHarness(fetchImpl);
      await expect(client.send({ body: body() })).rejects.toBeInstanceOf(ContributionClientError);
    }
  });

  test('accepts a fixed rejection only as bookkeeping, never remote control', async () => {
    const { client, audits } = makeHarness(async () => receipt('rejected'));
    expect(await client.send({ body: body() })).toEqual({ accepted: false, status: 400 });
    expect(audits.at(-1)).toEqual({
      type: 'contribution-upload-rejected', details: { status: 400, rowCount: 1 },
    });
  });

  test('rejects arbitrary URL/content rows before audit or network IO', async () => {
    let calls = 0;
    const { client, audits } = makeHarness(async () => { calls += 1; return receipt(); });
    await expect(client.send({
      body: body([{ url: 'https://secret.invalid/path', prompt: 'private content' }]),
    })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(audits).toEqual([]);
  });

  test('enforces body and streamed response caps before accepting bytes', async () => {
    const hugeBody = JSON.stringify({
      schemaVersion: 1, batchId, rows: ['x'.repeat(CONTRIBUTION_MAX_BODY_BYTES)],
    });
    const { client } = makeHarness(async () => receipt());
    await expect(client.send({ body: hugeBody })).rejects.toMatchObject({
      code: 'contribution-body-too-large',
    });

    const oversized = new Response('x'.repeat(CONTRIBUTION_MAX_RESPONSE_BYTES + 1), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    });
    const responseHarness = makeHarness(async () => oversized);
    await expect(responseHarness.client.send({ body: body() })).rejects.toMatchObject({
      code: 'contribution-response-too-large',
    });
  });

  test('caller abort and the named timeout both stop the underlying request', async () => {
    const waitingFetch = async (_url: string, init: RequestInit): Promise<Response> =>
      await new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const caller = new AbortController();
    const callerHarness = makeHarness(waitingFetch);
    const pending = callerHarness.client.send({ body: body(), signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'contribution-aborted' });

    let delay = 0;
    const timeoutClient = makeContributionClient({
      origin: 'https://contributions.invalid', fetchImpl: waitingFetch,
      audit: async () => {},
      validateCanonicalBytes: validateContributorEnvelopeBytes,
      setTimer: (callback, timeout) => { delay = timeout; queueMicrotask(callback); return 1; },
      clearTimer: () => {},
    });
    await expect(timeoutClient.send({ body: body() })).rejects.toMatchObject({
      code: 'contribution-timeout',
    });
    expect(delay).toBe(CONTRIBUTION_REQUEST_TIMEOUT_MS);
  });
});
