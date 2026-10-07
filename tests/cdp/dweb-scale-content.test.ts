import { expect, test } from 'bun:test';
import { contentEvidence } from '../../extension/tests/dweb-scale-content.js';
const hash = 'a'.repeat(64);
test('content observation retains metadata only and bounds first events without losing latest phase', () => {
  const evidence = contentEvidence(() => 123);
  evidence.phase('fetch-entered');
  for (let i = 0; i < 70; i++) evidence.frame(JSON.stringify({ t: 'CHUNK', hash, bytes: 'SECRET', manifest: { private: 'SECRET' }, sig: 'SECRET' }), 'receive', 2, 'open', 3);
  evidence.failed(new TypeError('SECRET raw payload'));
  const snapshot = evidence.snapshot();
  expect(snapshot.events).toHaveLength(64); expect(snapshot.dropped).toBe(8);
  expect(snapshot.phase).toBe('failed'); expect(snapshot.failure).toBe('TypeError'); expect(snapshot.events[0]).toEqual({ at: 123, phase: 'fetch-entered' });
  expect(snapshot.events[1]).toMatchObject({ type: 'CHUNK', hash, direction: 'receive', channel: 2 });
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
  expect(JSON.stringify(snapshot)).not.toContain('manifest');
});
test('malformed and oversized frames cannot disturb observation; HELLO is only a syntactically checked claim', () => {
  const evidence = contentEvidence();
  for (const data of [null, new Uint8Array(3), '{bad', 'x'.repeat(32769), JSON.stringify({ t: 'CHUNK', hash: 'bad' })])
    expect(evidence.frame(data, 'send', 1, 'open', 0)).toBeNull();
  const did = 'did:key:z' + 'a'.repeat(48);
  expect(evidence.frame(JSON.stringify({ __t: 'HELLO', env: { from: did, sig: 'SECRET' } }), 'receive', 1, 'open', 0)).toBe(did);
  expect(evidence.frame(JSON.stringify({ __t: 'HELLO', env: { from: did } }), 'send', 1, 'open', 0)).toBeNull();
  expect(evidence.snapshot().events).toEqual([]);
  evidence.phase('fetch-progress', { phase: 'manifest', total: 1, publisher: 'SECRET', extra: 'SECRET' });
  expect(JSON.stringify(evidence.snapshot())).not.toContain('SECRET');
});
