// Standing peer conversations — the pure thread registry. Open/adopt,
// turn recording with per-thread cap, reply consent, wire-safety (a convId
// is a bearer token; only its owning did may extend it), TTL + count
// eviction, and the dweb_block cascade.

import { describe, test, expect } from 'bun:test';
import {
  createConversationRegistry,
  MAX_CONVERSATIONS, MAX_TURNS_PER_CONVERSATION, CONVERSATION_TTL_MS,
} from '../../extension/peerd-runtime/subagent/conversation-registry.js';

let clock = 0;
const reg = (over = {}) => {
  clock = 1000;
  return createConversationRegistry({ now: () => clock, newConvId: (() => { let n = 0; return () => `c${++n}`; })(), ...over });
};

describe('open + record', () => {
  test('open mints a thread with the first self turn; turnsFor is a copy', () => {
    const r = reg();
    const { convId } = r.open('did:key:zA', 'hello there');
    expect(convId).toBe('c1');
    expect(r.didFor(convId)).toBe('did:key:zA');
    const turns = r.turnsFor(convId);
    expect(turns).toEqual([{ role: 'self', message: 'hello there', ts: 1000 }]);
    turns[0].message = 'tampered';
    expect(r.turnsFor(convId)[0].message).toBe('hello there'); // store untouched
  });

  test('record appends peer/self turns and caps at MAX_TURNS_PER_CONVERSATION', () => {
    const r = reg();
    const { convId } = r.open('did:key:zA', 'start');
    for (let i = 0; i < MAX_TURNS_PER_CONVERSATION + 5; i++) r.record(convId, i % 2 ? 'self' : 'peer', `m${i}`);
    const turns = r.turnsFor(convId);
    expect(turns.length).toBe(MAX_TURNS_PER_CONVERSATION);
    expect(turns.at(-1)!.message).toBe(`m${MAX_TURNS_PER_CONVERSATION + 4}`); // newest kept
  });
});

describe('adopt — inbound threads', () => {
  test('a fresh convId is adopted; a repeat from the SAME did is not fresh', () => {
    const r = reg();
    expect(r.adopt('peer-conv-1', 'did:key:zB')).toEqual({ fresh: true });
    expect(r.adopt('peer-conv-1', 'did:key:zB')).toEqual({ fresh: false });
    expect(r.didFor('peer-conv-1')).toBe('did:key:zB');
  });

  test('a convId is a bearer token: another did cannot extend or hijack the thread', () => {
    const r = reg();
    r.adopt('peer-conv-1', 'did:key:zB');
    // an attacker who observed the convId claims it from a different did
    expect(r.adopt('peer-conv-1', 'did:key:zEVIL')).toEqual({ fresh: false });
    expect(r.ownedBy('peer-conv-1', 'did:key:zEVIL')).toBe(false);
    expect(r.ownedBy('peer-conv-1', 'did:key:zB')).toBe(true);
    expect(r.didFor('peer-conv-1')).toBe('did:key:zB'); // owner unchanged
  });
});

describe('reply consent (per-conversation)', () => {
  test('a fresh thread has no reply consent until granted', () => {
    const r = reg();
    const { convId } = r.open('did:key:zA', 'hi');
    expect(r.hasReplyConsent(convId)).toBe(false);
    r.grantReplyConsent(convId);
    expect(r.hasReplyConsent(convId)).toBe(true);
  });
});

describe('eviction keeps the SW bounded', () => {
  test('TTL reclaims an idle thread on the next write', () => {
    const r = reg();
    const { convId } = r.open('did:key:zA', 'hi');
    clock += CONVERSATION_TTL_MS + 1;
    r.open('did:key:zB', 'other'); // any write sweeps
    expect(r.turnsFor(convId)).toEqual([]); // gone
    expect(r.didFor(convId)).toBeNull();
  });

  test('the count cap evicts the oldest-idle thread', () => {
    const r = reg({ maxConversations: 3, newConvId: (() => { let n = 0; return () => `k${++n}`; })() });
    const ids = [];
    for (let i = 0; i < 5; i++) { clock += 10; ids.push(r.open(`did:key:z${i}`, 'x').convId); }
    expect(r._size()).toBe(3);
    expect(r.didFor(ids[0])).toBeNull(); // oldest evicted
    expect(r.didFor(ids[4])).not.toBeNull(); // newest kept
  });
});

describe('revocation', () => {
  test('closeDid drops every thread with a blocked peer', () => {
    const r = reg();
    const a1 = r.open('did:key:zA', '1').convId;
    const a2 = r.open('did:key:zA', '2').convId;
    const b1 = r.open('did:key:zB', '3').convId;
    r.closeDid('did:key:zA');
    expect(r.didFor(a1)).toBeNull();
    expect(r.didFor(a2)).toBeNull();
    expect(r.didFor(b1)).toBe('did:key:zB'); // unrelated peer kept
  });
});
