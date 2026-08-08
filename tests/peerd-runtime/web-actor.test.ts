import { describe, test, expect } from 'bun:test';
import {
  fenceWebActorSummary,
  safeWebActorSummaryOrigin,
  WEB_ACTOR_SUMMARY_PROMPT,
  makeWebActorTabBindings,
  makeWebActorRegistry,
} from '../../extension/peerd-runtime/actor/web-actor.js';
import { stripUntrustedFences } from '../../extension/shared/util.js';

describe('fenceWebActorSummary — self-fence the actor\'s own memory', () => {
  test('wraps the summary as untrusted, body preserved (round-trips with the strip)', () => {
    const fenced = fenceWebActorSummary('clicked Login; the form is a modal', { now: () => 0 });
    expect(fenced.includes('<untrusted_web_content')).toBe(true);
    expect(fenced.includes('clicked Login; the form is a modal')).toBe(true);
    expect(stripUntrustedFences(fenced)).toBe('clicked Login; the form is a modal');
  });
  test('tags the origin as the web actor (not a real web origin)', () => {
    expect(fenceWebActorSummary('x', { tabOrigin: 'https://app.com', now: () => 0 }))
      .toContain('web-actor(https://app.com)');
  });
  test('a non-string summary fences to an empty body, never throws', () => {
    expect(stripUntrustedFences(fenceWebActorSummary(undefined as unknown as string, { now: () => 0 }))).toBe('');
  });

  test('keeps only a public origin and removes path, query, fragment, and credentials', () => {
    const raw = 'https://user:pass@app.example/private/path?secret=token#fragment';
    expect(safeWebActorSummaryOrigin(raw)).toBe('https://app.example');
    const fenced = fenceWebActorSummary('x', { tabOrigin: raw, now: () => 0 });
    expect(fenced).toContain('web-actor(https://app.example)');
    expect(fenced).not.toContain('private/path');
    expect(fenced).not.toContain('secret=token');
    expect(fenced).not.toContain('user:pass');
  });

  test('omits private, metadata, and denylisted locations from model-facing provenance', () => {
    const privateFence = fenceWebActorSummary('x', {
      tabOrigin: 'http://127.0.0.1/admin?secret=loopback',
      now: () => 0,
    });
    expect(privateFence).toContain('origin="web-actor"');
    expect(privateFence).not.toContain('127.0.0.1');
    expect(privateFence).not.toContain('secret=loopback');

    const restricted = [
      safeWebActorSummaryOrigin('http://127.0.0.1/admin?secret=loopback'),
      safeWebActorSummaryOrigin('http://169.254.169.254/latest/meta-data/?secret=metadata'),
      safeWebActorSummaryOrigin('https://vault.example/account?secret=denylisted', ['vault.example']),
    ];
    expect(restricted).toEqual([undefined, undefined, undefined]);
    for (const tabOrigin of restricted) {
      const fenced = fenceWebActorSummary('x', { tabOrigin, now: () => 0 });
      expect(fenced).toContain('origin="web-actor"');
      expect(fenced).not.toContain('secret=');
    }
  });
});

describe('WEB_ACTOR_SUMMARY_PROMPT — action-log shaped', () => {
  test('keeps progress, drops verbatim page text, treats injection as data', () => {
    expect(WEB_ACTOR_SUMMARY_PROMPT).toContain('PROGRESS');
    expect(WEB_ACTOR_SUMMARY_PROMPT).toContain('DROP verbatim page text');
    expect(WEB_ACTOR_SUMMARY_PROMPT.toLowerCase()).toContain('instruction');
  });
});

describe('makeWebActorTabBindings — tab→session store (the tab is the durable handle)', () => {
  test('bind / resolve / has / drop', () => {
    const b = makeWebActorTabBindings();
    expect(b.resolve(7)).toBeNull();
    b.bind(7, 'res-web-1');
    expect(b.resolve(7)).toBe('res-web-1');
    expect(b.has(7)).toBe(true);
    expect(b.drop(7)).toBe(true);
    expect(b.resolve(7)).toBeNull();
  });
  test('entries + load (rehydrate on SW boot)', () => {
    const b = makeWebActorTabBindings();
    b.bind(1, 'a'); b.bind(2, 'b');
    expect(b.entries().sort()).toEqual([[1, 'a'], [2, 'b']]);
    const b2 = makeWebActorTabBindings();
    b2.load(b.entries());
    expect(b2.resolve(2)).toBe('b');
  });
  test('tabFor — the reverse lookup (the web actor reads its owned tab from here)', () => {
    const b = makeWebActorTabBindings();
    expect(b.tabFor('actor-1')).toBeUndefined();   // 0-tab state
    b.bind(42, 'actor-1');
    expect(b.tabFor('actor-1')).toBe(42);          // 1-tab state
    // a tab close (drop) returns the actor to the 0-tab state — no separate bookkeeping.
    b.drop(42);
    expect(b.tabFor('actor-1')).toBeUndefined();
  });
});

describe('makeWebActorRegistry — the chat→web-actor map (0-or-1-tab actor)', () => {
  test('resolve / bind / drop, keyed by owner chat', () => {
    const r = makeWebActorRegistry();
    expect(r.resolve('chat-1')).toBeNull();
    r.bind('chat-1', 'actor-web-1');
    expect(r.resolve('chat-1')).toBe('actor-web-1');
    // a DIFFERENT chat is a different actor (web actors are chat-scoped).
    expect(r.resolve('chat-2')).toBeNull();
    expect(r.drop('chat-1')).toBe(true);
    expect(r.resolve('chat-1')).toBeNull();
  });
  test('entries + load (rehydrate on SW boot)', () => {
    const r = makeWebActorRegistry();
    r.bind('chat-1', 'a'); r.bind('chat-2', 'b');
    const r2 = makeWebActorRegistry();
    r2.load(r.entries());
    expect(r2.resolve('chat-2')).toBe('b');
  });
});
