// Session store v2 — per-message records + lazy migration.
//
// Covers the storage change that kills per-token write amplification:
// messages live one-record-each in `session_messages`; the session record
// holds only an ordered `msgIndex`; a delta patch touches ONE message
// record, never the session blob; pre-v8 inline-message sessions migrate
// lazily on read.

import { describe, test, expect } from 'bun:test';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';

// A keyPath-aware in-memory IDB with the batched getMany the real wrapper
// exposes (session_messages keyed by `id`, sessions by `sessionId`).
const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  let getManyCalls = 0;
  return {
    _tbl: tbl,
    _getManyCalls: () => getManyCalls,
    get: async (store: string, key: string) => tbl(store).get(key),
    getMany: async (store: string, keys: string[]) => {
      getManyCalls++;
      return (keys ?? []).map((k) => tbl(store).get(k));
    },
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};

const makeStore = (idb: any) => {
  let i = 0;
  return createSessionStore({ idb, now: () => 1000, makeId: () => `s-${++i}` });
};

describe('session store v2 — per-message records', () => {
  test('create stores a v2 metadata record with no inline messages', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    const raw = idb._tbl('sessions').get(s.sessionId);
    expect(raw.messagesV2).toBe(true);
    expect(raw.msgIndex).toEqual([]);
    expect('messages' in raw).toBe(false); // the blob carries no message bodies
    expect(s.messages).toEqual([]);
    // The internal fields are not leaked into the public shape.
    expect('msgIndex' in s).toBe(false);
    expect('messagesV2' in s).toBe(false);
  });

  test('appendMessage writes a per-message record and pushes the id to msgIndex', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    await store.appendMessage(s.sessionId, { role: 'user', content: 'hi', id: 'm1', when: 1 } as any);
    const out = await store.appendMessage(s.sessionId, { role: 'assistant', content: 'yo', id: 'm2', when: 2 } as any);

    expect(out.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    const raw = idb._tbl('sessions').get(s.sessionId);
    expect(raw.msgIndex).toEqual(['m1', 'm2']);
    // Bodies live in the message store, keyed by message id.
    expect(idb._tbl('session_messages').get('m1').message.content).toBe('hi');
    expect(idb._tbl('session_messages').get('m2').sessionId).toBe(s.sessionId);
  });

  test('updateAssistantMessage patches ONLY the message record, never the session blob', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    await store.appendMessage(s.sessionId, { role: 'assistant', content: '', id: 'a1', when: 1, streaming: true } as any);

    const sessionBefore = JSON.stringify(idb._tbl('sessions').get(s.sessionId));
    await store.updateAssistantMessage(s.sessionId, 'a1', { content: 'partial' });
    await store.updateAssistantMessage(s.sessionId, 'a1', { content: 'final', streaming: false, stopReason: 'end_turn' });
    const sessionAfter = JSON.stringify(idb._tbl('sessions').get(s.sessionId));

    // The session record is byte-identical across the delta patches.
    expect(sessionAfter).toBe(sessionBefore);
    const read = await store.get(s.sessionId);
    const msg0 = read!.messages[0] as any;
    expect(msg0.content).toBe('final');
    expect(msg0.streaming).toBe(false);
    expect(msg0.stopReason).toBe('end_turn');
  });

  test('updateAssistantMessage on a stale id is a no-op', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    await store.updateAssistantMessage(s.sessionId, 'ghost', { content: 'x' });
    const read = await store.get(s.sessionId);
    expect(read!.messages).toEqual([]);
  });

  test('get assembles via the batched getMany when available', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    await store.appendMessage(s.sessionId, { role: 'user', content: 'a', id: 'm1', when: 1 } as any);
    const before = idb._getManyCalls();
    const read = await store.get(s.sessionId);
    expect(idb._getManyCalls()).toBe(before + 1);
    expect(read!.messages.map((m: any) => m.content)).toEqual(['a']);
  });

  test('assembly falls back to per-id get when getMany is absent', async () => {
    const idb = makeIdb();
    delete (idb as any).getMany; // simulate a minimal fake
    const store = makeStore(idb);
    const s = await store.create();
    await store.appendMessage(s.sessionId, { role: 'user', content: 'a', id: 'm1', when: 1 } as any);
    const read = await store.get(s.sessionId);
    expect(read!.messages.map((m: any) => m.content)).toEqual(['a']);
  });
});

describe('session store v2 — lazy migration of pre-v8 inline records', () => {
  test('get() externalizes inline messages and rewrites the record in v2 shape', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    // Hand-write a legacy session: inline messages, no msgIndex/messagesV2.
    idb._tbl('sessions').set('legacy-1', {
      sessionId: 'legacy-1', createdAt: 1, provider: 'anthropic', model: 'm',
      messages: [
        { role: 'user', content: 'one', id: 'L1', when: 1 },
        { role: 'assistant', content: 'two', id: 'L2', when: 2 },
      ],
    });

    const read = await store.get('legacy-1');
    expect(read!.messages.map((m: any) => m.content)).toEqual(['one', 'two']);
    // Record rewritten: msgIndex set, inline messages dropped, bodies moved.
    const raw = idb._tbl('sessions').get('legacy-1');
    expect(raw.messagesV2).toBe(true);
    expect(raw.msgIndex).toEqual(['L1', 'L2']);
    expect('messages' in raw).toBe(false);
    expect(idb._tbl('session_messages').get('L1').message.content).toBe('one');
    // Legacy kind/depth still default on read.
    expect(read!.kind).toBe('chat');
    expect(read!.depth).toBe(0);
  });

  test('migration is idempotent — a second get() does not duplicate records', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    idb._tbl('sessions').set('legacy-2', {
      sessionId: 'legacy-2', createdAt: 1, provider: 'anthropic', model: 'm',
      messages: [{ role: 'user', content: 'x', id: 'L1', when: 1 }],
    });
    await store.get('legacy-2');
    await store.get('legacy-2');
    expect(idb._tbl('session_messages').size).toBe(1);
    expect(idb._tbl('sessions').get('legacy-2').msgIndex).toEqual(['L1']);
  });

  test('appendMessage onto a legacy record migrates it first', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    idb._tbl('sessions').set('legacy-3', {
      sessionId: 'legacy-3', createdAt: 1, provider: 'anthropic', model: 'm', title: 'kept',
      messages: [{ role: 'user', content: 'first', id: 'L1', when: 1 }],
    });
    const out = await store.appendMessage('legacy-3', { role: 'assistant', content: 'second', id: 'L2', when: 2 } as any);
    expect(out.messages.map((m: any) => m.id)).toEqual(['L1', 'L2']);
    expect(out.title).toBe('kept');
    expect(idb._tbl('sessions').get('legacy-3').msgIndex).toEqual(['L1', 'L2']);
  });
});

describe('session store v2 — list assembles both shapes (read-only)', () => {
  test('list reassembles v2 records and leaves legacy ones unmigrated', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    // a v2 session
    const a = await store.create();
    await store.appendMessage(a.sessionId, { role: 'user', content: 'hello there', id: 'm1', when: 5 } as any);
    // a legacy inline session
    idb._tbl('sessions').set('legacy-x', {
      sessionId: 'legacy-x', createdAt: 3, provider: 'anthropic', model: 'm',
      messages: [{ role: 'user', content: 'old', id: 'LX', when: 3 }],
    });

    const listed = await store.list();
    const byId = new Map(listed.map((s: any) => [s.sessionId, s]));
    expect(byId.get(a.sessionId)!.messages.map((m: any) => m.content)).toEqual(['hello there']);
    expect(byId.get('legacy-x')!.messages.map((m: any) => m.content)).toEqual(['old']);
    // list() must not have migrated the legacy record (read-only).
    expect('messages' in idb._tbl('sessions').get('legacy-x')).toBe(true);
  });
});
