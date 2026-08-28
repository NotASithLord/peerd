// The shared repeat-injection dedup guard (schema-diet 6b). oncePerSession is
// the flat "disclose a note once per session" gate the create-result notes and
// large one-shot tool bodies; shouldInjectBody is the trim-AWARE variant load_skill uses —
// it re-injects a scrolled-out body once the rolling-summary watermark passes
// the prior load. Pure logic, module-scope registries — reset between cases.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  oncePerSession, shouldInjectBody, _resetOncePerSession,
} from '../../../extension/peerd-runtime/tools/defs/once-per-session.js';

beforeEach(() => { _resetOncePerSession(); });

describe('oncePerSession', () => {
  test('true the first time a (session, key) pair is seen, false after', () => {
    expect(oncePerSession('s1', 'note')).toBe(true);
    expect(oncePerSession('s1', 'note')).toBe(false);
    expect(oncePerSession('s1', 'note')).toBe(false);
  });

  test('keys are independent within a session', () => {
    expect(oncePerSession('s1', 'a')).toBe(true);
    expect(oncePerSession('s1', 'b')).toBe(true); // different key → still first
    expect(oncePerSession('s1', 'a')).toBe(false);
  });

  test('re-arms per session id', () => {
    expect(oncePerSession('s1', 'note')).toBe(true);
    expect(oncePerSession('s2', 'note')).toBe(true); // different session → first again
    expect(oncePerSession('s1', 'note')).toBe(false);
  });

  test('a falsy sessionId always discloses (cannot be deduped)', () => {
    expect(oncePerSession(null, 'note')).toBe(true);
    expect(oncePerSession(undefined, 'note')).toBe(true);
    expect(oncePerSession('', 'note')).toBe(true);
  });

  test('a fresh Worker derives an earlier disclosure from the persisted transcript', () => {
    const messages = [{
      role: 'user',
      toolResults: [{
        content: 'prefix UNIQUE RUNTIME NOTE suffix',
        meta: { toolName: 'script' },
      }],
    }];
    _resetOncePerSession();
    expect(oncePerSession(
      's1', 'note', messages, 'script', 'UNIQUE RUNTIME NOTE',
    )).toBe(false);
    // An unrelated tool cannot forge/suppress the disclosure marker.
    expect(oncePerSession(
      's2', 'note', messages, 'sandbox_create', 'UNIQUE RUNTIME NOTE',
    )).toBe(true);
  });
});

describe('shouldInjectBody — trim-aware once-per-session', () => {
  test('injects the first load, dedups the second while still in context', () => {
    // first load at message #5, nothing trimmed yet
    expect(shouldInjectBody('s1', 'skill:x', 5, 0)).toBe(true);
    // second load later (message #12), still nothing trimmed past #5 → dedup
    expect(shouldInjectBody('s1', 'skill:x', 12, 0)).toBe(false);
    expect(shouldInjectBody('s1', 'skill:x', 20, 5)).toBe(false); // covered=5 not > 5
  });

  test('re-injects once the trim watermark passes the prior load', () => {
    expect(shouldInjectBody('s1', 'skill:x', 5, 0)).toBe(true);
    // rolling summary folded the first 6 messages away → the body at #5 is gone
    expect(shouldInjectBody('s1', 'skill:x', 30, 6)).toBe(true);
    // and the anchor advanced to #30 — a follow-up while #30 is still in context dedups
    expect(shouldInjectBody('s1', 'skill:x', 33, 6)).toBe(false);
  });

  test('a deduped call does NOT advance the anchor (stays pinned to the live body)', () => {
    expect(shouldInjectBody('s1', 'skill:x', 5, 0)).toBe(true);   // body at #5
    expect(shouldInjectBody('s1', 'skill:x', 40, 3)).toBe(false); // deduped; anchor stays 5
    // now the watermark passes #5 → must re-inject (proving the anchor stayed at 5, not 40)
    expect(shouldInjectBody('s1', 'skill:x', 50, 6)).toBe(true);
  });

  test('distinct bodies + distinct sessions are independent', () => {
    expect(shouldInjectBody('s1', 'skill:x', 5, 0)).toBe(true);
    expect(shouldInjectBody('s1', 'skill:y', 5, 0)).toBe(true); // other skill → first
    expect(shouldInjectBody('s2', 'skill:x', 5, 0)).toBe(true); // other session → first
  });

  test('a falsy sessionId always injects', () => {
    expect(shouldInjectBody(null, 'skill:x', 5, 0)).toBe(true);
    expect(shouldInjectBody(null, 'skill:x', 5, 0)).toBe(true);
  });
});
