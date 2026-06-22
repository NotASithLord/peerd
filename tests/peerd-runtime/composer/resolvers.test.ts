import { describe, test, expect } from 'bun:test';
import {
  decideTabGate, buildTabPayload, buildFilePayload,
  resolveTabRef, resolveFileRef, resolveAllRefs, originOfUrl,
} from '../../../extension/peerd-runtime/composer/resolvers.js';
import { parseRefs } from '../../../extension/peerd-runtime/composer/parse.js';

const DENY = ['*.chase.com', 'chase.com', '*.proton.me'];

describe('decideTabGate — origin denylist gate (lethal-trifecta)', () => {
  test('allows an ordinary https origin', () => {
    const g = decideTabGate({ url: 'https://en.wikipedia.org/wiki/Cat', denylist: DENY });
    expect(g.allowed).toBe(true);
    expect(g.origin).toBe('https://en.wikipedia.org');
  });
  test('blocks a denylisted subdomain', () => {
    const g = decideTabGate({ url: 'https://secure.chase.com/login', denylist: DENY });
    expect(g.allowed).toBe(false);
    expect(g.reason).toBe('denylisted');
    expect(g.pattern).toBe('*.chase.com');
  });
  test('blocks the denylisted apex too', () => {
    expect(decideTabGate({ url: 'https://chase.com/', denylist: DENY }).allowed).toBe(false);
  });
  test('does NOT block a look-alike (boundary safety)', () => {
    // evilchase.com must not match *.chase.com
    expect(decideTabGate({ url: 'https://evilchase.com/', denylist: DENY }).allowed).toBe(true);
  });
  test('refuses chrome:// and extension pages outright', () => {
    expect(decideTabGate({ url: 'chrome://settings', denylist: [] }).allowed).toBe(false);
    expect(decideTabGate({ url: 'chrome-extension://abc/page.html', denylist: [] }).allowed).toBe(false);
  });
});

describe('buildTabPayload — the untrusted wrap', () => {
  const payload = buildTabPayload({
    snapshot: { title: 'Hello', url: 'https://example.com/x', text: 'visible body text' },
    origin: 'https://example.com',
    retrievedAt: '2026-06-09T00:00:00.000Z',
  });

  test('wraps in <untrusted_web_content> with origin + tool attribution', () => {
    expect(payload).toContain('<untrusted_web_content origin="https://example.com" tool="at_tab" retrieved_at="2026-06-09T00:00:00.000Z">');
    expect(payload).toContain('</untrusted_web_content>');
  });
  test('carries title, url, and the visible text inside the fence', () => {
    expect(payload).toContain('Title: Hello');
    expect(payload).toContain('URL: https://example.com/x');
    expect(payload).toContain('visible body text');
  });
  test('matches read_page wrap shape exactly (same tag, attrs order)', () => {
    expect(payload).toBe(
      '<untrusted_web_content origin="https://example.com" tool="at_tab" retrieved_at="2026-06-09T00:00:00.000Z">\n'
      + 'Title: Hello\nURL: https://example.com/x\n\n[TEXT]\nvisible body text\n'
      + '</untrusted_web_content>',
    );
  });
});

describe('buildFilePayload — first-party file fence', () => {
  test('fences content in <peerd_file> with an escaped path', () => {
    const out = buildFilePayload({ path: 'notes/"x".md', content: 'body' });
    expect(out).toContain('<peerd_file path="notes/&quot;x&quot;.md">');
    expect(out).toContain('body');
    expect(out).toContain('</peerd_file>');
  });
});

// ── resolveTabRef: orchestration over a mocked tab snapshot ────────────────

const makeCtx = (over: any = {}) => ({
  activeTab: { id: 1, url: 'https://example.com', origin: 'https://example.com' },
  denylist: DENY,
  tabs: {
    get: async (id: number) => ({ id, url: over.tabUrl ?? 'https://example.com/page', title: 'T' }),
    query: async () => [{ id: 1, url: over.tabUrl ?? 'https://example.com/page', title: 'T' }],
  },
  scripting: {
    executeScript: async () => [{
      result: { title: 'Doc', url: over.snapUrl ?? 'https://example.com/page', text: 'real DOM text' },
    }],
  },
  appClient: {
    readFile: async ({ path }: any) => `contents of ${path}`,
  },
  session: { sessionId: 's1' },
  ...over.ctx,
});

describe('resolveTabRef', () => {
  test('builds an untrusted-wrapped payload from the captured snapshot', async () => {
    const r = await resolveTabRef({ arg: '' }, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('<untrusted_web_content');
      expect(r.content).toContain('tool="at_tab"');
      expect(r.content).toContain('real DOM text');
      expect(r.origin).toBe('https://example.com');
    }
  });

  test('refuses a denylisted tab BEFORE capture', async () => {
    const ctx = makeCtx({ tabUrl: 'https://mail.proton.me/inbox' });
    const r = await resolveTabRef({ arg: '' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('denylisted');
  });

  test('re-gates on the post-redirect URL the page reports', async () => {
    // tab record looks safe, but the snapshot URL landed on a denylisted host
    const ctx = makeCtx({ tabUrl: 'https://example.com/go', snapUrl: 'https://secure.chase.com/x' });
    const r = await resolveTabRef({ arg: '' }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('resolveFileRef', () => {
  test('reads the file and fences it', async () => {
    const r = await resolveFileRef({ arg: 'todo.md' }, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('<peerd_file path="todo.md">');
      expect(r.content).toContain('contents of todo.md');
    }
  });
  test('errors with path_required for an empty arg', async () => {
    const r = await resolveFileRef({ arg: '' }, makeCtx());
    expect(r.ok).toBe(false);
  });
});

describe('resolveAllRefs — splice back-to-front', () => {
  test('replaces each @-ref with its payload, leaving surrounding text intact', async () => {
    const src = 'before @file:a.md middle @tab after';
    const refs = parseRefs(src);
    const { text, resolved } = await resolveAllRefs(refs, src, makeCtx());
    expect(resolved.every((r) => r.ok)).toBe(true);
    expect(text.startsWith('before ')).toBe(true);
    expect(text).toContain('<peerd_file path="a.md">');
    expect(text).toContain('<untrusted_web_content');
    expect(text.includes(' middle ')).toBe(true);
    expect(text.trimEnd().endsWith('after')).toBe(true);
  });

  test('a failing ref is left inline with a note; the turn still proceeds', async () => {
    const src = 'see @tab';
    const refs = parseRefs(src);
    const ctx = makeCtx({ tabUrl: 'https://chase.com/' });
    const { text, resolved } = await resolveAllRefs(refs, src, ctx);
    expect(resolved[0].ok).toBe(false);
    expect(text).toContain('@tab (could not resolve:');
  });
});

describe('originOfUrl', () => {
  test('scheme://host for https', () => {
    expect(originOfUrl('https://a.b.com/x?y=1')).toBe('https://a.b.com');
  });
  test('empty for garbage', () => {
    expect(originOfUrl('not a url')).toBe('');
  });
});
