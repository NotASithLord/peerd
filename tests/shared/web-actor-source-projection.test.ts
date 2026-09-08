import { describe, expect, test } from 'bun:test';
import {
  validateWebActorSourceProjection,
  webActorSourceProjectionRow,
} from '../../extension/shared/web-actor-source-projection.js';

const row = (tabId: number, overrides: Record<string, unknown> = {}) => ({
  tabId, sessionId: `actor-${tabId}`, url: `https://${tabId}.example/`,
  openerTabId: null, cookieStoreId: 'firefox-default', ...overrides,
});

describe('web actor source projection', () => {
  test('keeps exact rows while pruning contradictory and absent tabs', () => {
    const projection = [row(7), row(8), row(9), row(10), row(11)];
    const bindings = projection.map(({ tabId, sessionId }) => [tabId, sessionId]);
    const validated = validateWebActorSourceProjection(bindings, projection, [
      { id: 7, url: 'https://7.example/', cookieStoreId: 'firefox-default' },
      { id: 8, url: 'https://reused.example/', cookieStoreId: 'firefox-default' },
      {
        id: 9, url: 'https://9.example/', openerTabId: 4,
        cookieStoreId: 'firefox-default',
      },
      { id: 10, url: 'https://10.example/', cookieStoreId: 'firefox-container-2' },
    ]);

    expect([...validated ?? []]).toEqual([[7, 'actor-7']]);
  });

  test('fails closed when a surviving row has unavailable identity', () => {
    const exact = row(7);
    const stale = row(8);
    const cases: Array<{
      ambiguous: ReturnType<typeof row>, live: Record<string, unknown>,
    }> = [
      { ambiguous: row(9), live: { id: 9, cookieStoreId: 'firefox-default' } },
      { ambiguous: row(9), live: {
        id: 9, url: '', cookieStoreId: 'firefox-default',
      } },
      { ambiguous: row(9), live: { id: 9, url: 'https://9.example/' } },
      { ambiguous: row(9, { cookieStoreId: null }), live: {
        id: 9, url: 'https://9.example/', cookieStoreId: 'firefox-default',
      } },
      { ambiguous: row(9, { openerTabId: 4 }), live: {
        id: 9, url: 'https://9.example/', cookieStoreId: 'firefox-default',
      } },
    ];
    for (const { ambiguous, live } of cases) {
      const projection = [exact, stale, ambiguous];
      expect(validateWebActorSourceProjection(
        projection.map(({ tabId, sessionId }) => [tabId, sessionId]),
        projection,
        [
          { id: 7, url: 'https://7.example/', cookieStoreId: 'firefox-default' },
          { id: 8, url: 'https://reused.example/', cookieStoreId: 'firefox-default' },
          live,
        ],
      )).toBeNull();
    }
  });

  test('a known contradiction wins over an unavailable field on the same row', () => {
    const projection = [row(7)];
    expect(validateWebActorSourceProjection([[7, 'actor-7']], projection, [{
      id: 7, url: 'https://reused.example/',
    }])).toEqual(new Map());
  });

  test('does not persist an unavailable URL', () => {
    expect(webActorSourceProjectionRow({ id: 7, url: '' }, 'actor-7')).toBeNull();
  });
});
