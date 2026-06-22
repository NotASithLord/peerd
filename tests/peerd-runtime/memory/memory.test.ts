import { describe, test, expect } from 'bun:test';

import {
  scopeId, normalizeWorkspace, normalizeSubpath, subpathInScope,
  countLines, normalizeBody, buildWriteProposal, assembleAlwaysLoaded,
  ALWAYS_LOADED_LINE_BUDGET, MAX_DOC_CHARS,
  seedInitializerBody, appendProgress, initializerScope, INITIALIZER_SUBPATH,
} from '../../../extension/peerd-runtime/memory/memory.js';

import { draftAgentsMd, resolveWorkspaceKey, deriveChecklist }
  from '../../../extension/peerd-runtime/memory/initializer.js';

import { createMemoryStore }
  from '../../../extension/peerd-runtime/memory/store.js';

import type { MemoryDoc } from '../../../extension/peerd-runtime/memory/memory.js';

// ── scope identity ─────────────────────────────────────────────────────

describe('scopeId', () => {
  test('user scope is a constant', () => {
    expect(scopeId({ kind: 'user' })).toBe('user');
  });
  test('project scope keys on normalized workspace', () => {
    expect(scopeId({ kind: 'project', workspace: 'https://GitHub.com' }))
      .toBe('project:https://github.com');
  });
  test('subtree scope keys on workspace + normalized subpath', () => {
    expect(scopeId({ kind: 'subtree', workspace: 'https://x.com', subpath: '/src//api/' }))
      .toBe('subtree:https://x.com:src/api');
  });
  test('project without workspace throws', () => {
    expect(() => scopeId({ kind: 'project' })).toThrow();
  });
  test('subtree without subpath throws', () => {
    expect(() => scopeId({ kind: 'subtree', workspace: 'a' })).toThrow();
  });
});

describe('normalizeWorkspace', () => {
  test('lowercases origin host but keeps opaque ids verbatim', () => {
    expect(normalizeWorkspace('https://EXAMPLE.com/path')).toBe('https://example.com');
    expect(normalizeWorkspace('vm:AbC123')).toBe('vm:AbC123');
    expect(normalizeWorkspace('  ')).toBe('');
  });
});

describe('subpathInScope', () => {
  test('segment-prefix match, not substring', () => {
    expect(subpathInScope('src/api', 'src/api/handlers')).toBe(true);
    expect(subpathInScope('src/api', 'src/api')).toBe(true);
    expect(subpathInScope('src/api', 'src/apix')).toBe(false);
    expect(subpathInScope('', 'x')).toBe(false);
  });
});

// ── body validation ────────────────────────────────────────────────────

describe('normalizeBody', () => {
  test('whitespace-only collapses to empty (delete signal)', () => {
    expect(normalizeBody('   \n\n  ')).toBe('');
  });
  test('over-budget throws', () => {
    expect(() => normalizeBody('x'.repeat(MAX_DOC_CHARS + 1))).toThrow();
  });
  test('collapses 3+ blank lines to one', () => {
    expect(normalizeBody('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('countLines', () => {
  test('trailing newline does not add a line', () => {
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

// ── always-loaded assembly + budget ────────────────────────────────────

describe('assembleAlwaysLoaded', () => {
  const userDoc: MemoryDoc = { id: 'user', kind: 'user', workspace: '', body: 'global note', updatedAt: 1, createdAt: 1 };
  const projDoc: MemoryDoc = { id: 'project:https://x.com', kind: 'project', workspace: 'https://x.com', body: 'proj note', updatedAt: 1, createdAt: 1 };

  test('orders user before project and wraps in <memory>', () => {
    const r = assembleAlwaysLoaded([projDoc, userDoc]);
    expect(r.text.startsWith('<memory>')).toBe(true);
    expect(r.text.indexOf('user (global)')).toBeLessThan(r.text.indexOf('project https://x.com'));
    expect(r.includedIds).toEqual(['user', 'project:https://x.com']);
    expect(r.truncated).toBe(false);
  });

  test('excludes subtree docs (on-demand only)', () => {
    const sub: MemoryDoc = { id: 'subtree:https://x.com:a', kind: 'subtree', workspace: 'https://x.com', subpath: 'a', body: 'deep', updatedAt: 1, createdAt: 1 };
    const r = assembleAlwaysLoaded([userDoc, sub]);
    expect(r.includedIds).toEqual(['user']);
    expect(r.text.includes('deep')).toBe(false);
  });

  test('respects the line budget and marks truncation', () => {
    const big: MemoryDoc = { id: 'user', kind: 'user', workspace: '', body: Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), updatedAt: 1, createdAt: 1 };
    const r = assembleAlwaysLoaded([big, projDoc], { budget: 10 });
    // user doc alone (50+2 lines) exceeds budget 10 → nothing fits → truncated
    expect(r.includedIds.length).toBe(0);
    expect(r.truncated).toBe(true);
  });

  test('empty docs produce empty text', () => {
    expect(assembleAlwaysLoaded([]).text).toBe('');
  });

  test('default budget is ~200 lines', () => {
    expect(ALWAYS_LOADED_LINE_BUDGET).toBe(200);
  });
});

// ── write proposal (lethal-trifecta seam) ──────────────────────────────

describe('buildWriteProposal', () => {
  test('agent-origin create REQUIRES confirmation', () => {
    const p = buildWriteProposal({ scope: { kind: 'user' }, prior: null, body: 'hi', origin: 'agent' });
    expect(p.op).toBe('create');
    expect(p.requiresConfirmation).toBe(true);
  });
  test('user-origin write does NOT require confirmation', () => {
    const p = buildWriteProposal({ scope: { kind: 'user' }, prior: null, body: 'hi', origin: 'user' });
    expect(p.requiresConfirmation).toBe(false);
  });
  test('empty body over existing doc is a delete', () => {
    const prior: MemoryDoc = { id: 'user', kind: 'user', workspace: '', body: 'old', updatedAt: 1, createdAt: 1 };
    const p = buildWriteProposal({ scope: { kind: 'user' }, prior, body: '', origin: 'agent' });
    expect(p.op).toBe('delete');
  });
  test('identical body is a noop and never confirms', () => {
    const prior: MemoryDoc = { id: 'user', kind: 'user', workspace: '', body: 'same', updatedAt: 1, createdAt: 1 };
    const p = buildWriteProposal({ scope: { kind: 'user' }, prior, body: 'same', origin: 'agent' });
    expect(p.op).toBe('noop');
    expect(p.requiresConfirmation).toBe(false);
  });
  test('carries a line delta for the diff badge', () => {
    const prior: MemoryDoc = { id: 'user', kind: 'user', workspace: '', body: 'a\nb', updatedAt: 1, createdAt: 1 };
    const p = buildWriteProposal({ scope: { kind: 'user' }, prior, body: 'a\nc\nd', origin: 'agent' });
    expect(p.addedLines).toBe(2);
    expect(p.removedLines).toBe(1);
  });
});

// ── initializer pattern (pure) ─────────────────────────────────────────

describe('initializer journal', () => {
  test('seed body carries checklist + progress log + deterministic ts', () => {
    const body = seedInitializerBody({ workspace: 'https://x.com', checklist: ['ship it'], nowIso: '2026-06-09T00:00:00.000Z' });
    expect(body).toContain('- [ ] ship it');
    expect(body).toContain('## Progress log');
    expect(body).toContain('2026-06-09T00:00:00.000Z — initialized.');
  });
  test('appendProgress adds under existing log heading', () => {
    const seed = seedInitializerBody({ workspace: 'w', nowIso: '2026-06-09T00:00:00.000Z' });
    const next = appendProgress(seed, 'did a thing', '2026-06-09T01:00:00.000Z');
    expect(next).toContain('2026-06-09T01:00:00.000Z — did a thing');
    // checklist heading still intact
    expect(next).toContain('## Feature checklist');
  });
  test('initializerScope is a reserved subtree path', () => {
    const s = initializerScope('https://x.com');
    expect(s.kind).toBe('subtree');
    expect(s.subpath).toBe(INITIALIZER_SUBPATH);
  });
});

// ── /init drafter (browser-native: @tab + apps) ────────────────────────

describe('draftAgentsMd', () => {
  test('incorporates a live tab probe (the browser-native superpower)', () => {
    const probe = {
      tab: {
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        headings: ['Revenue', 'Users'],
        textSnippet: 'Welcome back. Your metrics for the week.',
      },
      apps: [{ id: 'a1', name: 'Chart', description: 'a chart app' }],
    };
    const { workspace, body, sources, checklist } = draftAgentsMd(probe, { nowIso: '2026-06-09T00:00:00.000Z' });
    expect(workspace).toBe('https://app.example.com');
    expect(body).toContain('# AGENTS.md — https://app.example.com');
    expect(body).toContain('## Live page snapshot');
    expect(body).toContain('Revenue');
    expect(body).toContain('## peerd Apps');
    expect(body).toContain('Chart');
    expect(sources).toContain('tab');
    expect(sources).toContain('apps');
    expect(checklist).toContain('document the goal for https://app.example.com/dashboard');
  });

  test('incorporates a WebVM filesystem probe', () => {
    const probe = {
      workspace: 'vm:demo',
      vm: {
        entries: ['package.json', 'src', 'README.md'],
        readme: '# My Tool\nDoes things.',
        packageJson: { name: 'my-tool', version: '1.0.0', scripts: { test: 'bun test', build: 'tsc' } },
      },
    };
    const { body, sources, checklist } = draftAgentsMd(probe, { nowIso: '2026-06-09T00:00:00.000Z' });
    expect(body).toContain('## Filesystem (WebVM)');
    expect(body).toContain('package.json');
    expect(body).toContain('my-tool');
    expect(body).toContain('## Scripts');
    expect(sources).toContain('vm:fs');
    expect(checklist).toEqual(expect.arrayContaining(['verify `test` runs clean', 'verify `build` runs clean']));
  });

  test('deterministic for a given probe', () => {
    const probe = { tab: { url: 'https://x.com', title: 'X' } };
    const a = draftAgentsMd(probe, { nowIso: '2026-06-09T00:00:00.000Z' });
    const b = draftAgentsMd(probe, { nowIso: '2026-06-09T00:00:00.000Z' });
    expect(a.body).toBe(b.body);
  });

  test('resolveWorkspaceKey falls back through tab → vm → label', () => {
    expect(resolveWorkspaceKey({ tab: { url: 'https://a.com/x' } })).toBe('https://a.com');
    expect(resolveWorkspaceKey({ vm: { id: 'z' } })).toBe('vm:z');
    expect(resolveWorkspaceKey({})).toBe('workspace');
  });
});

// ── store integration with an in-memory idb fake ───────────────────────

/** Minimal in-memory stand-in for the egress idb adapter. */
const fakeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const s = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => s(store).get(key),
    put: async (store: string, value: any) => { s(store).set(value.id, value); },
    getAll: async (store: string) => [...s(store).values()],
    del: async (store: string, key: string) => { s(store).delete(key); },
  };
};

describe('createMemoryStore', () => {
  test('agent write WITHOUT a confirm channel fails closed (no persist)', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    const res = await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'secret', origin: 'agent' });
    expect(res.ok).toBe(false);
    expect(res.rejected).toBe(true);
    expect(await store.readScope({ kind: 'user' })).toBeNull();
  });

  test('agent write persists ONLY after a yes', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    const no = await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'a', origin: 'agent', confirm: async () => 'no' });
    expect(no.ok).toBe(false);
    expect(await store.readScope({ kind: 'user' })).toBeNull();

    const yes = await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'a', origin: 'agent', confirm: async () => 'yes_once' });
    expect(yes.ok).toBe(true);
    expect(yes.op).toBe('create');
    expect((await store.readScope({ kind: 'user' }))!.body).toBe('a');
  });

  test('user-origin write persists with no confirm fn', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    const res = await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'mine', origin: 'user' });
    expect(res.ok).toBe(true);
    expect((await store.readScope({ kind: 'user' }))!.body).toBe('mine');
  });

  test('loadAlwaysLoaded fetches user + active-workspace docs only', async () => {
    const idb = fakeIdb();
    const store = createMemoryStore({ idb, now: () => 1000 });
    await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'U', origin: 'user' });
    await store.writeWithConfirm({ scope: { kind: 'project', workspace: 'https://x.com' }, body: 'P', origin: 'user' });
    await store.writeWithConfirm({ scope: { kind: 'project', workspace: 'https://other.com' }, body: 'OTHER', origin: 'user' });
    const loaded = await store.loadAlwaysLoaded({ workspace: 'https://x.com' });
    expect(loaded.text).toContain('U');
    expect(loaded.text).toContain('P');
    expect(loaded.text).not.toContain('OTHER'); // different workspace, not loaded
  });

  test('readSubtree returns in-scope subtree docs, most-specific first', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    await store.writeWithConfirm({ scope: { kind: 'subtree', workspace: 'https://x.com', subpath: 'src' }, body: 'SRC', origin: 'user' });
    await store.writeWithConfirm({ scope: { kind: 'subtree', workspace: 'https://x.com', subpath: 'src/api' }, body: 'API', origin: 'user' });
    const docs = await store.readSubtree('https://x.com', 'src/api/handlers');
    expect(docs.map((d) => d.body)).toEqual(['API', 'SRC']);
  });

  test('export → deleteAll → import round-trips (reversibility)', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    await store.writeWithConfirm({ scope: { kind: 'user' }, body: 'keep me', origin: 'user' });
    const dump = await store.exportAll();
    expect(dump.docs.length).toBe(1);
    await store.deleteAll();
    expect(await store.readScope({ kind: 'user' })).toBeNull();
    const imp = await store.importAll(dump);
    expect(imp.written).toBe(1);
    expect((await store.readScope({ kind: 'user' }))!.body).toBe('keep me');
  });

  test('ensureInitializer is idempotent; logProgress appends', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => Date.parse('2026-06-09T00:00:00.000Z') });
    const first = await store.ensureInitializer({ workspace: 'https://x.com', checklist: ['ship'] });
    expect(first.created).toBe(true);
    const second = await store.ensureInitializer({ workspace: 'https://x.com' });
    expect(second.created).toBe(false);
    await store.logProgress({ workspace: 'https://x.com', entry: 'made progress' });
    const journal = await store.readInitializer('https://x.com');
    expect(journal!.body).toContain('- [ ] ship');
    expect(journal!.body).toContain('made progress');
  });
});
