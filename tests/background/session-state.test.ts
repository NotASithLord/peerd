import { describe, test, expect } from 'bun:test';
import { makeSessionState } from '../../extension/background/session-state.js';

describe('session-state', () => {
  test('starts empty', () => {
    expect(makeSessionState().current()).toBeNull();
  });
  test('set/current round-trips the record', () => {
    const s = makeSessionState();
    s.set({ sessionId: 'a', model: 'm' });
    expect(s.current()).toEqual({ sessionId: 'a', model: 'm' });
  });
  test('clear drops the cache', () => {
    const s = makeSessionState();
    s.set({ sessionId: 'a' });
    s.clear();
    expect(s.current()).toBeNull();
  });
  test('set replaces wholesale (no merge)', () => {
    const s = makeSessionState();
    s.set({ sessionId: 'a', model: 'm' });
    s.set({ sessionId: 'a', model: 'n' });
    expect(s.current()).toEqual({ sessionId: 'a', model: 'n' });
  });
});
