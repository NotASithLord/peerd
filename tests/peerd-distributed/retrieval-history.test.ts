import { test, expect } from 'bun:test';
import { createRetrievalHistory, RETRIEVAL_HISTORY_LIMIT, RETRIEVAL_MISS_TTL_MS } from '../../extension/peerd-distributed/apps/retrieval-history.js';

test('retrieval misses expire and direct retry supersedes late failures', () => {
  let time = 1;
  const history = createRetrievalHistory({ now: () => time });
  const first = history.begin('author/version');
  history.miss('author/version', first);
  expect(history.read('author/version')?.outcome).toBe('no-provider-found');
  expect(history.read('other-author/version')).toBeNull();
  expect(history.read('author/other-version')).toBeNull();
  const retry = history.begin('author/version');
  history.miss('author/version', first);
  expect(history.read('author/version')).toBeNull();
  history.forget('author/version', retry);
  history.miss('author/version', retry);
  expect(history.read('author/version')).toBeNull();
  const next = history.begin('author/version');
  history.miss('author/version', next);
  time += RETRIEVAL_MISS_TTL_MS;
  expect(history.read('author/version')).toBeNull();
});

test('policy reset, clock rollback and bounded eviction cannot resurrect old misses', () => {
  let time = 100;
  const history = createRetrievalHistory({ now: () => time });
  const old = history.begin('old');
  history.clear();
  history.begin('old');
  history.miss('old', old);
  expect(history.read('old')).toBeNull();
  const current = history.begin('old');
  history.miss('old', current);
  time--;
  expect(history.read('old')).toBeNull();
  for (let i = 0; i <= RETRIEVAL_HISTORY_LIMIT; i++) {
    const key = String(i);
    history.miss(key, history.begin(key));
  }
  expect(history.read('0')).toBeNull();
  expect(history.read(String(RETRIEVAL_HISTORY_LIMIT))).not.toBeNull();
});
