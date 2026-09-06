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
  const getAllCalls: string[] = [];
  const getCalls: Array<[string, string]> = [];
  return {
    _tbl: tbl,
    _getManyCalls: () => getManyCalls,
    _getAllCalls: () => [...getAllCalls],
    _getCalls: () => [...getCalls],
    get: async (store: string, key: string) => {
      getCalls.push([store, key]);
      return tbl(store).get(key);
    },
    getMany: async (store: string, keys: string[]) => {
      getManyCalls++;
      return (keys ?? []).map((k) => tbl(store).get(k));
    },
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    mutate: async (store: string, key: string, transform: (current: any) => any) => {
      const current = tbl(store).get(key);
      if (current === undefined) return undefined;
      const updated = transform(current);
      tbl(store).set(key, updated);
      return updated;
    },
    getAll: async (store: string) => {
      getAllCalls.push(store);
      return [...tbl(store).values()];
    },
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

  test('portable import preserves the chat and is idempotent without trusting message ids', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    // Occupy the imported row's deterministic base key from another chat.
    await idb.put('session_messages', {
      id: 'selfsync:remote-chat:0', sessionId: 'local-chat', seq: 0,
      message: { id: 'selfsync:remote-chat:0', role: 'user', content: 'local' },
    });
    const portable = {
      sessionId: 'remote-chat', createdAt: 42, provider: 'openai', model: 'gpt-test',
      title: 'A restored chat', customSystemPrompt: 'Keep this preference',
      // These authority/runtime fields must never survive this narrow path.
      permissionMode: 'act', trimSummary: { text: 'stale' }, parentSessionId: 'victim',
      messages: [
        { id: 'selfsync:remote-chat:0', role: 'user', content: 'hello', when: 1 },
        { id: 'attacker-picked-id', role: 'assistant', content: 'world', when: 2 },
      ],
    };

    const imported = await store.importPortable(portable as any);
    expect(imported).toMatchObject({
      sessionId: 'remote-chat', createdAt: 42, provider: 'openai', model: 'gpt-test',
      title: 'A restored chat', kind: 'chat', depth: 0,
    });
    expect(imported.messages.map((message: any) => message.content)).toEqual(['hello', 'world']);
    expect(imported.messages.map((message: any) => message.id)).toEqual([
      'selfsync:remote-chat:0:1', 'selfsync:remote-chat:1',
    ]);
    expect((imported as any).permissionMode).toBeUndefined();
    expect((imported as any).trimSummary).toBeUndefined();
    expect((imported as any).parentSessionId).toBeUndefined();
    expect(idb._tbl('session_messages').get('selfsync:remote-chat:0').message.content).toBe('local');

    const second = await store.importPortable({ ...portable, title: 'must not overwrite' } as any);
    expect(second.title).toBe('A restored chat');
    expect(idb._tbl('sessions').size).toBe(1);
    expect(idb._tbl('session_messages').size).toBe(3);
  });

  test('portable import summarizes the last accepted message', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    await store.importPortable({
      sessionId: 'portable-tail', createdAt: 1,
      messages: [{ role: 'user', content: 'kept', when: 100 }, null],
    } as any);
    expect(idb._tbl('sessions').get('portable-tail')).toMatchObject({
      messageCount: 1, lastMessageAt: 100,
    });
  });

  test('listMetadata never reads or returns message bodies', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const session = await store.create({ provider: 'openai', model: 'gpt-test' });
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Visible session title', id: 'title-message', when: 1,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'assistant', content: 'private transcript body', id: 'private-message', when: 2,
    } as any);
    // Legacy inline records must also stay body-free without being migrated.
    await idb.put('sessions', {
      sessionId: 'legacy', createdAt: 2, provider: 'anthropic', model: 'legacy',
      messages: [{ role: 'user', content: 'legacy private body' }],
    });

    const callsBefore = idb._getAllCalls().length;
    const rows = await store.listMetadata();
    const calls = idb._getAllCalls().slice(callsBefore);

    expect(calls).toEqual(['sessions']);
    expect(rows.map((row: any) => row.sessionId)).toEqual([session.sessionId, 'legacy']);
    expect(rows.every((row: any) => !Object.hasOwn(row, 'messages'))).toBe(true);
    expect(rows.every((row: any) => !Object.hasOwn(row, 'msgIndex'))).toBe(true);
    expect(rows.every((row: any) => !Object.hasOwn(row, 'messagesV2'))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('private transcript body');
    expect(JSON.stringify(rows)).not.toContain('legacy private body');
    expect(idb._tbl('sessions').get('legacy').messages).toHaveLength(1);
  });

  test('targeted actor-monitor reads avoid transcript assembly and stop at the latest real request', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const session = await store.create({ provider: 'openai', model: 'gpt-test' });
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Original request', id: 'request-1', when: 1,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'assistant', content: 'Private assistant body', id: 'assistant-1', when: 2,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Actor reply', synthetic: true, id: 'synthetic-1', when: 3,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Current request', id: 'request-2', when: 4,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'assistant', content: 'Later private answer', id: 'assistant-2', when: 5,
    } as any);
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Later actor reply', synthetic: true, id: 'synthetic-2', when: 6,
    } as any);
    // A delayed idempotent retry of an older request must not move the pointer
    // backward after a newer real user message has committed.
    await store.appendMessage(session.sessionId, {
      role: 'user', content: 'Original request', id: 'request-1', when: 1,
    } as any);

    const getManyBefore = idb._getManyCalls();
    const metadata = await store.getMetadata(session.sessionId);
    const callsBeforeLatest = idb._getCalls().length;
    const latest = await store.getLatestNonSyntheticUserMessage(session.sessionId);
    const latestCalls = idb._getCalls().slice(callsBeforeLatest);

    expect(metadata).toMatchObject({ sessionId: session.sessionId, provider: 'openai' });
    expect((metadata as any).messages).toBeUndefined();
    expect(latest).toMatchObject({ id: 'request-2', content: 'Current request' });
    expect(latestCalls).toEqual([
      ['sessions', session.sessionId],
      ['session_messages', 'request-2'],
    ]);
    expect(idb._getManyCalls()).toBe(getManyBefore);
  });

  // DESIGN-18 REGRESSION GUARD: create() rebuilds the record from a fixed field
  // whitelist; `backing` was once OMITTED, which silently made every API actor behave
  // as a tab web actor (the entire feature inert). This round-trip — the coverage the
  // unit suite lacked — asserts the actor self-description survives create()→get().
  test('an actor record round-trips actorType + backing + instanceId through create/get', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.stripe.com' });
    const got = await store.get(s.sessionId);
    expect(got!.kind).toBe('actor');
    expect(got!.actorType).toBe('web');
    expect(got!.backing).toBe('api');                 // the field that was dropped
    expect(got!.instanceId).toBe('https://api.stripe.com');
    // A tab-backed web actor (no backing passed) stays backing-absent (the default).
    const tab = await store.create({ kind: 'actor', actorType: 'web', instanceId: '42' });
    expect((await store.get(tab.sessionId))!.backing).toBeUndefined();
  });

  test('spawned exact-operation grants are bounded, durable, and create-once', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const child = await store.create({
      kind: 'spawned', parentSessionId: 'parent', spawnedTrusted: true,
      grantedOperations: ['turn.memory.read-scope', 'turn.memory.read-subtree'],
    });
    const restarted = await store.get(child.sessionId);
    expect(restarted!.grantedOperations).toEqual([
      'turn.memory.read-scope', 'turn.memory.read-subtree',
    ]);
    expect((restarted as any)!.grantedTools).toBeUndefined();
    await expect(store.update(child.sessionId, {
      grantedOperations: ['turn.actor.message'],
    })).rejects.toThrow('session-update-field-invalid');
    await expect(store.update(child.sessionId, {
      parentSessionId: 'attacker-parent',
    })).rejects.toThrow('session-update-field-invalid');
    expect((await store.get(child.sessionId))!.grantedOperations).toEqual([
      'turn.memory.read-scope', 'turn.memory.read-subtree',
    ]);
  });

  test('invalid, duplicate, and non-spawned exact grants fail before persistence', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    await expect(store.create({
      kind: 'spawned', grantedOperations: ['turn.unknown.effect'],
    })).rejects.toThrow('session-granted-operation-invalid');
    await expect(store.create({
      kind: 'spawned', grantedOperations: ['turn.memory.read-scope', 'turn.memory.read-scope'],
    })).rejects.toThrow('session-granted-operation-duplicate');
    await expect(store.create({
      kind: 'chat', grantedOperations: ['turn.memory.read-scope'],
    })).rejects.toThrow('session-granted-operations-kind-invalid');
    expect(idb._tbl('sessions').size).toBe(0);
  });

  // DESIGN-18: reconnect-on-miss. An API actor's routing binding is ephemeral, but its
  // memory is durable on the session — findActorSession re-finds it by (origin, chat) so
  // a post-restart re-address resumes accumulated memory instead of minting empty.
  test('findActorSession re-finds a live API actor by instanceId + parent, skipping archived', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const a = await store.create({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.x.com', parentSessionId: 'chat-1' });
    // wrong origin / wrong chat / wrong backing don't match
    await store.create({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.y.com', parentSessionId: 'chat-1' });
    await store.create({ kind: 'actor', actorType: 'web', backing: 'api', instanceId: 'https://api.x.com', parentSessionId: 'chat-2' });
    await store.create({ kind: 'actor', actorType: 'web', instanceId: '42', parentSessionId: 'chat-1' });   // tab backing

    expect(await store.findActorSession({ parentSessionId: 'chat-1', instanceId: 'https://api.x.com', actorType: 'web', backing: 'api' })).toBe(a.sessionId);
    expect(await store.findActorSession({ parentSessionId: 'chat-9', instanceId: 'https://api.x.com', backing: 'api' })).toBeNull();

    // an archived actor is NOT reconnected (the chat is gone)
    await store.archive(a.sessionId);
    expect(await store.findActorSession({ parentSessionId: 'chat-1', instanceId: 'https://api.x.com', backing: 'api' })).toBeNull();
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

  test('appendMessage is idempotent for a stable message id', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();
    const receipt = { role: 'user', content: 'Outcome unknown', id: 'actor-recovery:1', when: 1 } as any;

    await store.appendMessage(s.sessionId, receipt);
    const out = await store.appendMessage(s.sessionId, { ...receipt, when: 2 });

    expect(out.messages.map((m: any) => m.id)).toEqual(['actor-recovery:1']);
    expect(out.messages[0].when).toBe(1);
    expect(idb._tbl('sessions').get(s.sessionId).msgIndex).toEqual(['actor-recovery:1']);
  });

  test('append increments a verified summary instead of a corrupt index', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    await idb.put('sessions', {
      sessionId: 'corrupt-summary', createdAt: 1, messagesV2: true,
      msgIndex: ['owned', 'missing', 'foreign'], messageCount: 1, lastMessageAt: 2,
    });
    await idb.put('session_messages', {
      id: 'owned', sessionId: 'corrupt-summary', seq: 0,
      message: { id: 'owned', role: 'user', content: 'first', when: 2 },
    });
    await store.appendMessage('corrupt-summary', {
      id: 'next', role: 'assistant', content: 'next', when: 3,
    } as any);
    expect(idb._tbl('sessions').get('corrupt-summary').messageCount).toBe(2);
    expect((await store.get('corrupt-summary'))?.messages).toHaveLength(2);
  });

  test('concurrent appends to one session preserve both ordered message ids', async () => {
    const idb = makeIdb();
    const store = makeStore(idb);
    const s = await store.create();

    await Promise.all([
      store.appendMessage(s.sessionId, { role: 'user', content: 'one', id: 'm-concurrent-1', when: 1 } as any),
      store.appendMessage(s.sessionId, { role: 'assistant', content: 'two', id: 'm-concurrent-2', when: 2 } as any),
    ]);

    expect(idb._tbl('sessions').get(s.sessionId).msgIndex).toEqual(['m-concurrent-1', 'm-concurrent-2']);
    expect((await store.get(s.sessionId))!.messages.map((message: any) => message.id))
      .toEqual(['m-concurrent-1', 'm-concurrent-2']);
  });

  test('a metadata update cannot erase an append that is between its row and index commits', async () => {
    const base = makeIdb();
    let armed = false;
    let metadataReads = 0;
    let releaseWrite = () => {};
    let signalWriteStarted = () => {};
    const writeStarted = new Promise<void>((resolve) => { signalWriteStarted = resolve; });
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const idb = {
      ...base,
      get: async (store: string, key: string) => {
        if (armed && store === 'sessions') metadataReads += 1;
        return base.get(store, key);
      },
      mutate: async (store: string, key: string, transform: (current: any) => any) => {
        if (armed && store === 'sessions') {
          armed = false;
          signalWriteStarted();
          await writeReleased;
        }
        return base.mutate(store, key, transform);
      },
    };
    const store = makeStore(idb);
    const session = await store.create();
    armed = true;

    const append = store.appendMessage(session.sessionId, {
      role: 'user', content: 'kept', id: 'm-race', when: 1,
    } as any);
    const setCost = store.setCost(session.sessionId, { input: 1, output: 2, total: 3 } as any);
    await writeStarted;

    // The cost writer must not read the stale pre-append metadata snapshot.
    expect(metadataReads).toBe(1);
    releaseWrite();
    await Promise.all([append, setCost]);

    const raw = base._tbl('sessions').get(session.sessionId);
    expect(raw.msgIndex).toEqual(['m-race']);
    expect(raw.cost).toEqual({ input: 1, output: 2, total: 3 });
  });

  test('the post-append hook runs after the session index commit and cannot fail the append', async () => {
    const idb = makeIdb();
    const observations: any[] = [];
    let calls = 0;
    const store = createSessionStore({
      idb,
      now: () => 1000,
      makeId: () => 'session-hook',
      onMessageAppended: async (sessionId, message: any) => {
        calls += 1;
        observations.push([...idb._tbl('sessions').get(sessionId).msgIndex]);
        expect(idb._tbl('session_messages').get(message.id).message).toEqual(message);
        throw new Error('post-commit acknowledgement unavailable');
      },
    });
    const s = await store.create();
    const message = { role: 'user', content: '', id: 'tool-result-1', when: 1 } as any;

    await store.appendMessage(s.sessionId, message);
    await store.appendMessage(s.sessionId, message);

    expect(calls).toBe(2);
    expect(observations).toEqual([['tool-result-1'], ['tool-result-1']]);
    expect((await store.get(s.sessionId))!.messages.map((entry: any) => entry.id)).toEqual(['tool-result-1']);
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
