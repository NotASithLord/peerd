// DESIGN-18: the API actor — a web actor (actorType:'web') with NO tab, owning ONE
// fixed origin (fetch_url only). These pin the PURE core: the origin normalizer (the
// addressing + same-origin-lock anchor), the (chat, origin)→session binding store
// (parallel to the tab store, but origin-keyed because an API origin never moves),
// the self-fence on the actor's own learned memory, and the "what I learned" prompt.

import { describe, test, expect } from 'bun:test';
import {
  normalizeApiOrigin,
  makeApiActorBindings,
  fenceApiActorSummary,
  API_ACTOR_SUMMARY_PROMPT,
} from '../../extension/peerd-runtime/subagent/web-actor.js';
import { stripUntrustedFences } from '../../extension/shared/util.js';

describe('normalizeApiOrigin — the canonical owned-origin (addressing + lock anchor)', () => {
  test('a bare host assumes https and yields scheme://host', () => {
    expect(normalizeApiOrigin('api.stripe.com')).toBe('https://api.stripe.com');
  });
  test('a full URL is reduced to its origin (path/query/default-port dropped)', () => {
    expect(normalizeApiOrigin('https://api.github.com/repos/x?page=2')).toBe('https://api.github.com');
    expect(normalizeApiOrigin('https://api.github.com:443/x')).toBe('https://api.github.com');
    expect(normalizeApiOrigin('https://api.github.com:8443/x')).toBe('https://api.github.com:8443');
  });
  test('host is lowercased; a non-default port is kept', () => {
    expect(normalizeApiOrigin('HTTPS://API.Example.COM:9000')).toBe('https://api.example.com:9000');
  });
  test('http is allowed in P0 (keyless public APIs); P1 keyed-grant is https-only', () => {
    expect(normalizeApiOrigin('http://data.example.org')).toBe('http://data.example.org');
  });
  test('rejects what would collide with web / tabId / engine handles', () => {
    expect(normalizeApiOrigin('web')).toBeNull();            // the chat web-actor handle
    expect(normalizeApiOrigin('42')).toBeNull();             // a tabId
    expect(normalizeApiOrigin('vm-abc')).toBeNull();         // an engine instance id (no dot)
    expect(normalizeApiOrigin('notebook-xyz')).toBeNull();
    expect(normalizeApiOrigin('localhost')).toBeNull();      // no public dotted host
  });
  test('rejects non-http(s) schemes and junk', () => {
    expect(normalizeApiOrigin('ftp://files.example.com')).toBeNull();
    expect(normalizeApiOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeApiOrigin('')).toBeNull();
    expect(normalizeApiOrigin(undefined)).toBeNull();
  });
  test('spoof shapes do NOT canonicalize to a victim origin (the same-origin lock holds)', () => {
    // host-suffix and userinfo tricks land on a DIFFERENT origin than the victim.
    expect(normalizeApiOrigin('https://api.stripe.com.evil.com')).toBe('https://api.stripe.com.evil.com');
    expect(normalizeApiOrigin('https://api.stripe.com@evil.com')).toBe('https://evil.com');
  });
});

describe('makeApiActorBindings — (chat, origin)→session, origin-keyed because the origin is fixed', () => {
  test('bind / resolve / drop, scoped by BOTH chat and origin', () => {
    const b = makeApiActorBindings();
    expect(b.resolve('chat-1', 'https://api.stripe.com')).toBeNull();
    b.bind('chat-1', 'https://api.stripe.com', 'api-actor-1');
    expect(b.resolve('chat-1', 'https://api.stripe.com')).toBe('api-actor-1');
    // a different origin in the SAME chat is a different integration
    expect(b.resolve('chat-1', 'https://api.github.com')).toBeNull();
    // the SAME origin in a DIFFERENT chat is a different integration (chat-scoped v1)
    expect(b.resolve('chat-2', 'https://api.stripe.com')).toBeNull();
    expect(b.drop('chat-1', 'https://api.stripe.com')).toBe(true);
    expect(b.resolve('chat-1', 'https://api.stripe.com')).toBeNull();
  });
  test('originsFor — a chat\'s integrations (feeds actor_list + cleanup)', () => {
    const b = makeApiActorBindings();
    b.bind('chat-1', 'https://api.stripe.com', 'a');
    b.bind('chat-1', 'https://api.github.com', 'b');
    b.bind('chat-2', 'https://api.openai.com', 'c');
    expect(b.originsFor('chat-1').sort()).toEqual(['https://api.github.com', 'https://api.stripe.com']);
    expect(b.originsFor('chat-2')).toEqual(['https://api.openai.com']);
    expect(b.originsFor('chat-3')).toEqual([]);
  });
  test('entries + load (rehydrate on SW boot)', () => {
    const b = makeApiActorBindings();
    b.bind('chat-1', 'https://api.stripe.com', 'a');
    b.bind('chat-2', 'https://api.github.com', 'b');
    const b2 = makeApiActorBindings();
    b2.load(b.entries());
    expect(b2.resolve('chat-2', 'https://api.github.com')).toBe('b');
    expect(b2.resolve('chat-1', 'https://api.stripe.com')).toBe('a');
  });
});

describe('fenceApiActorSummary — self-fence the API actor\'s own learned memory', () => {
  test('wraps as untrusted, body round-trips with the strip', () => {
    const fenced = fenceApiActorSummary('GET /v1/charges paginates via starting_after', { now: () => 0 });
    expect(fenced.includes('<untrusted_web_content')).toBe(true);
    expect(stripUntrustedFences(fenced)).toBe('GET /v1/charges paginates via starting_after');
  });
  test('tags the owned origin (not a real web origin)', () => {
    expect(fenceApiActorSummary('x', { origin: 'https://api.stripe.com', now: () => 0 }))
      .toContain('api-actor(https://api.stripe.com)');
  });
  test('a non-string summary fences to an empty body, never throws', () => {
    expect(stripUntrustedFences(fenceApiActorSummary(undefined as unknown as string, { now: () => 0 }))).toBe('');
  });
});

describe('API_ACTOR_SUMMARY_PROMPT — learned-API shaped', () => {
  test('keeps endpoints/auth/pagination, drops verbatim bodies, treats injection as data', () => {
    expect(API_ACTOR_SUMMARY_PROMPT.toLowerCase()).toContain('endpoints');
    expect(API_ACTOR_SUMMARY_PROMPT.toLowerCase()).toContain('pagination');
    expect(API_ACTOR_SUMMARY_PROMPT).toContain('DROP');
    expect(API_ACTOR_SUMMARY_PROMPT.toLowerCase()).toContain('instruction');
  });
});
