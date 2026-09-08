import { describe, expect, test } from 'bun:test';
import { createKernelMemoryAuthority } from '../../extension/background/kernel-memory-authority.js';
import {
  normalizeBody as richNormalizeBody,
  normalizeWorkspace as richNormalizeWorkspace,
  scopeId as richScopeId,
} from '../../extension/peerd-runtime/memory/memory.js';
import {
  normalizeBody,
  normalizeWorkspace,
  scopeId,
} from '../../extension/shared/memory-authority-policy.js';

const makeIdb = () => {
  let rows = new Map<string, any>();
  let fail = false;
  return {
    rows,
    failNext() { fail = true; },
    get: async (_store: string, key: string) => structuredClone(rows.get(key)),
    getAll: async () => [...rows.values()].map((row) => structuredClone(row)),
    transact: async (_stores: string[], fn: Function) => {
      const draft = new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
      const callbacks: Function[] = [];
      let aborted = false;
      const store = {
        get(key: string) {
          const request: any = { result: undefined, onsuccess: null };
          callbacks.push(() => {
            request.result = structuredClone(draft.get(key));
            request.onsuccess?.();
          });
          return request;
        },
        getAllKeys() {
          const request: any = { result: [], onsuccess: null };
          callbacks.push(() => {
            request.result = [...draft.keys()];
            request.onsuccess?.();
          });
          return request;
        },
        count() {
          const request: any = { result: 0, onsuccess: null };
          callbacks.push(() => {
            request.result = draft.size;
            request.onsuccess?.();
          });
          return request;
        },
        clear() { draft.clear(); },
        put(value: any) { draft.set(value.id, structuredClone(value)); },
        delete(key: string) { draft.delete(key); },
      };
      const result = fn({ agents_memory: store }, { abort: () => { aborted = true; } });
      for (const callback of callbacks) callback();
      if (fail) { fail = false; throw new Error('commit-failed'); }
      if (aborted) throw new Error('aborted');
      rows.clear();
      for (const [key, value] of draft) rows.set(key, value);
      return typeof result === 'function' ? result() : result;
    },
  };
};

const makeHarness = () => {
  const idb = makeIdb();
  const local = new Map<string, any>();
  const audits: any[] = [];
  let clock = 100;
  const authority = createKernelMemoryAuthority({
    idb,
    kv: {
      get: async (key: string) => structuredClone(local.get(key)),
      set: async (key: string, value: any) => { local.set(key, structuredClone(value)); },
    },
    auditLog: { append: async (entry: any) => { audits.push(entry); } },
    now: () => clock++,
  });
  return { idb, local, audits, routes: authority.routes };
};

describe('native memory authority', () => {
  test('shares the exact rich scope and body policy', () => {
    expect(normalizeBody).toBe(richNormalizeBody);
    expect(normalizeWorkspace).toBe(richNormalizeWorkspace);
    expect(scopeId).toBe(richScopeId);
    expect(scopeId({ kind: 'project', workspace: 'https://EXAMPLE.com/path' }))
      .toBe('project:https://example.com');
    expect(normalizeBody('one  \n\n\n two\t')).toBe('one\n\n two');
    expect(() => normalizeBody('x'.repeat(24_001))).toThrow('memory body too large');
  });

  test('exposes only the seven direct routes and preserves write/export/delete behavior', async () => {
    const h = makeHarness();
    expect(Object.keys(h.routes).sort()).toEqual([
      'memory/delete', 'memory/deleteAll', 'memory/export',
      'memory/suggestions', 'memory/suggestions/approve',
      'memory/suggestions/dismiss', 'memory/write',
    ]);
    expect(await h.routes['memory/write']({
      scope: { kind: 'project', workspace: 'https://EXAMPLE.com/path' },
      body: 'alpha  \n\n\n beta',
    })).toEqual({ ok: true, op: 'create', id: 'project:https://example.com' });
    expect(h.idb.rows.get('project:https://example.com')).toMatchObject({
      kind: 'project', workspace: 'https://example.com', body: 'alpha\n\n beta',
    });
    expect(await h.routes['memory/export']()).toMatchObject({
      ok: true, payload: { version: 1, docs: [{ id: 'project:https://example.com' }] },
    });
    expect(await h.routes['memory/write']({
      scope: { kind: 'project', workspace: 'app:numeric' }, body: 7,
    })).toMatchObject({ ok: true });
    expect(h.idb.rows.get('project:app:numeric').body).toBe('7');
    expect(await h.routes['memory/delete']({
      scope: { kind: 'project', workspace: 'https://example.com' },
    })).toMatchObject({ ok: true, op: 'delete' });
    await h.routes['memory/write']({ scope: { kind: 'user' }, body: 'a' });
    await h.routes['memory/write']({
      scope: { kind: 'project', workspace: 'app:one' }, body: 'b',
    });
    expect(await h.routes['memory/deleteAll']())
      .toMatchObject({ ok: true, deleted: 3 });
    expect(h.idb.rows.size).toBe(0);
  });

  test('common kernel routes execute directly without a controller or offscreen hop', async () => {
    const h = makeHarness();
    expect(await h.routes['memory/write']({
      scope: { kind: 'user' }, body: 'direct',
    })).toMatchObject({ ok: true, op: 'create', id: 'user' });
    expect(await h.routes['memory/export']()).toMatchObject({
      ok: true, payload: { version: 1, docs: [{ id: 'user', body: 'direct' }] },
    });
    h.idb.failNext();
    expect(await h.routes['memory/write']({
      scope: { kind: 'user' }, body: 'uncertain',
    })).toEqual({
      ok: false,
      error: 'The memory operation outcome could not be confirmed.',
      outcomeKnown: false,
      retryable: false,
    });
  });

  test('approval consumes a suggestion exactly once and preserves its audit', async () => {
    const h = makeHarness();
    h.local.set('memory_suggestions.v1', { pending: [{
      id: 's-1', text: '  remember   this ', sessionId: 'chat-1', createdAt: 1,
    }] });
    expect(await h.routes['memory/suggestions/approve']({ id: 's-1' }))
      .toMatchObject({ ok: true });
    expect(h.idb.rows.get('user').body).toBe('# User memory\n\n## Notes\n- remember this\n');
    expect(h.local.get('memory_suggestions.v1')).toEqual({ pending: [] });
    expect(h.audits).toEqual([{
      type: 'memory_suggestion_approved', sessionId: 'chat-1', details: { id: 's-1' },
    }]);
    expect(await h.routes['memory/suggestions/approve']({ id: 's-1' }))
      .toEqual({ ok: false, error: 'not-found' });
  });

  test('post-dispatch storage loss stays unknown and non-retryable', async () => {
    const h = makeHarness();
    h.idb.failNext();
    const result = await h.routes['memory/write']({
      scope: { kind: 'user' }, body: 'uncertain',
    });
    expect(result).toEqual({
      ok: false,
      error: 'The memory operation outcome could not be confirmed.',
      outcomeKnown: false,
      retryable: false,
    });
  });
});
