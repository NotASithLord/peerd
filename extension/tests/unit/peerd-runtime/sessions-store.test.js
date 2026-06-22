// @ts-check
// Session store tests — CRUD + immutability + assistant-message update.

import { describe, it, expect } from '../../framework.js';
import { createSessionStore } from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @typedef {import('/peerd-runtime/sessions/types.js').Session} Session */
/** @typedef {import('/peerd-provider/types.js').AssistantMessage} AssistantMessage */

// why: store.get()/archive() etc. return `Session | undefined`; in these
// tests the record is always present. Cast (don't `!`) to keep the prod
// type honest while reading fields. Identity at runtime.
/** @param {Session | undefined} s @returns {Session} */
const present = (s) => /** @type {Session} */ (s);

// why: messages is InternalMessage[] (user|assistant union); these tests
// read assistant-only fields (streaming/stopReason) after appending an
// assistant message. Narrow the union member at the read.
/** @param {import('/peerd-provider/types.js').InternalMessage} m @returns {AssistantMessage} */
const asst = (m) => /** @type {AssistantMessage} */ (m);

let counter = 0;
/** @param {Record<string, any>} [overrides] */
const fresh = (overrides = {}) => {
  counter += 1;
  const idb = makeMockIdb();
  return createSessionStore({
    idb,
    now: () => 1000,
    makeId: (() => {
      let i = 0;
      return () => `id-${counter}-${++i}`;
    })(),
    ...overrides,
  });
};

describe('session store', () => {
  it('creates a session with sensible defaults', async () => {
    const s = fresh();
    const session = await s.create();
    expect(session.sessionId.startsWith('id-')).toBe(true);
    expect(session.provider).toBe('anthropic');
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBe(1000);
    // Subagent fields default to a top-level chat (docs/SUBAGENTS.md).
    expect(session.kind).toBe('chat');
    expect(session.depth).toBe(0);
    expect(session.parentSessionId).toBe(undefined);
    expect(session.task).toBe(undefined);
  });

  describe('subagent parentage', () => {
    it('persists kind/parentSessionId/task/depth when creating a subagent', async () => {
      const s = fresh();
      const child = await s.create({
        kind: 'subagent', parentSessionId: 'parent-1', task: 'do a thing', depth: 2,
      });
      expect(child.kind).toBe('subagent');
      expect(child.parentSessionId).toBe('parent-1');
      expect(child.task).toBe('do a thing');
      expect(child.depth).toBe(2);
      const reread = present(await s.get(child.sessionId));
      expect(reread.kind).toBe('subagent');
      expect(reread.parentSessionId).toBe('parent-1');
      expect(reread.depth).toBe(2);
    });

    it('defaults kind/depth on read for pre-subagent records', async () => {
      // Simulate a session written before subagents landed: no kind/depth.
      const idb = makeMockIdb();
      const s = createSessionStore({ idb, now: () => 1000, makeId: () => 'legacy-1' });
      await idb.put('sessions', {
        sessionId: 'legacy-1', createdAt: 1000,
        provider: 'anthropic', model: 'm', messages: [],
      });
      const read = present(await s.get('legacy-1'));
      expect(read.kind).toBe('chat');
      expect(read.depth).toBe(0);
      // list() backfills too.
      const [listed] = await s.list();
      expect(listed.kind).toBe('chat');
      expect(listed.depth).toBe(0);
    });
  });

  describe('customSystemPrompt (/system)', () => {
    it('create persists a non-empty block; absent otherwise', async () => {
      const s = fresh();
      const withBlock = await s.create({ customSystemPrompt: 'be terse' });
      expect(withBlock.customSystemPrompt).toBe('be terse');
      const reread = present(await s.get(withBlock.sessionId));
      expect(reread.customSystemPrompt).toBe('be terse');

      const without = await s.create();
      expect('customSystemPrompt' in without).toBe(false);
    });

    it('setCustomSystemPrompt sets and CLEARS by removing the key', async () => {
      const s = fresh();
      const session = await s.create();
      const set = /** @type {Session} */ (await s.setCustomSystemPrompt(session.sessionId, 'answer in French'));
      expect(set.customSystemPrompt).toBe('answer in French');

      const cleared = await s.setCustomSystemPrompt(session.sessionId, null);
      // why absent (not ''): every consumer — prompt render, UI badge,
      // subagent non-inheritance — shares one "unset" shape.
      expect('customSystemPrompt' in cleared).toBe(false);
      const reread = present(await s.get(session.sessionId));
      expect('customSystemPrompt' in reread).toBe(false);
    });

    it('clearing keeps the rest of the record intact', async () => {
      const s = fresh();
      const session = await s.create({ customSystemPrompt: 'x' });
      await s.appendMessage(session.sessionId, {
        role: 'user', content: 'hello', id: 'm1', when: 0,
      });
      const cleared = await s.setCustomSystemPrompt(session.sessionId, '');
      expect(cleared.messages.length).toBe(1);
      expect(cleared.title).toBe('hello');
    });
  });

  it('persists sessions in the store and lists newest first', async () => {
    let t = 0;
    const idb = makeMockIdb();
    let i = 0;
    const s = createSessionStore({ idb, now: () => ++t, makeId: () => `s-${++i}` });
    await s.create();
    await s.create();
    const list = await s.list();
    expect(list.length).toBe(2);
    expect(list[0].createdAt > list[1].createdAt).toBe(true);
  });

  it('appendMessage returns the updated session and persists it', async () => {
    const s = fresh();
    const session = await s.create();
    const updated = await s.appendMessage(session.sessionId, {
      role: 'user', content: 'hi', id: 'm1', when: 0,
    });
    expect(updated.messages.length).toBe(1);
    expect(updated.messages[0].content).toBe('hi');
    // Read back to confirm persistence.
    const reread = present(await s.get(session.sessionId));
    expect(reread.messages.length).toBe(1);
  });

  it('updateAssistantMessage patches by id in place', async () => {
    const s = fresh();
    const session = await s.create();
    await s.appendMessage(session.sessionId, {
      role: 'user', content: 'hi', id: 'm1', when: 0,
    });
    await s.appendMessage(session.sessionId, {
      role: 'assistant', content: '', id: 'a1', when: 0, streaming: true,
    });
    await s.updateAssistantMessage(session.sessionId, 'a1', { content: 'partial' });
    let read = present(await s.get(session.sessionId));
    expect(read.messages[1].content).toBe('partial');
    expect(asst(read.messages[1]).streaming).toBe(true);

    await s.updateAssistantMessage(session.sessionId, 'a1', {
      content: 'final', streaming: false, stopReason: 'end_turn',
    });
    read = present(await s.get(session.sessionId));
    expect(read.messages[1].content).toBe('final');
    expect(asst(read.messages[1]).streaming).toBe(false);
    expect(asst(read.messages[1]).stopReason).toBe('end_turn');
  });

  it('archive marks archivedAt without losing messages', async () => {
    const s = fresh({ now: (() => { let t = 0; return () => ++t; })() });
    const session = await s.create();
    await s.appendMessage(session.sessionId, {
      role: 'user', content: 'hi', id: 'm1', when: 0,
    });
    const archived = await s.archive(session.sessionId);
    expect(archived.archivedAt).toBeGreaterThan(0);
    expect(archived.messages.length).toBe(1);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    const s = fresh();
    await expect(() => s.appendMessage('does-not-exist', {
      role: 'user', content: 'x', id: 'm', when: 0,
    })).toThrow((e) => e.name === 'SessionNotFoundError');
  });

  describe('title auto-derivation', () => {
    it('sets the title from the first user message', async () => {
      const s = fresh();
      const session = await s.create();
      const updated = await s.appendMessage(session.sessionId, {
        role: 'user', content: 'What is the capital of France?', id: 'm', when: 0,
      });
      expect(updated.title).toBe('What is the capital of France?');
    });

    it('does NOT overwrite an existing title', async () => {
      const s = fresh();
      const session = await s.create();
      await s.appendMessage(session.sessionId, {
        role: 'user', content: 'first', id: 'm1', when: 0,
      });
      const after = await s.appendMessage(session.sessionId, {
        role: 'user', content: 'second', id: 'm2', when: 0,
      });
      expect(after.title).toBe('first');
    });

    it('truncates long messages to 60 chars', async () => {
      const s = fresh();
      const session = await s.create();
      const long = 'a'.repeat(120);
      const updated = await s.appendMessage(session.sessionId, {
        role: 'user', content: long, id: 'm', when: 0,
      });
      expect(updated.title?.length).toBe(60);
    });

    it('collapses whitespace so a multi-line first message stays single-line', async () => {
      const s = fresh();
      const session = await s.create();
      const updated = await s.appendMessage(session.sessionId, {
        role: 'user', content: 'line one\n\n\tline two   line three', id: 'm', when: 0,
      });
      expect(updated.title).toBe('line one line two line three');
    });

    it('does not set a title from an assistant message', async () => {
      const s = fresh();
      const session = await s.create();
      const updated = await s.appendMessage(session.sessionId, {
        role: 'assistant', content: 'hello', id: 'a', when: 0,
      });
      expect(updated.title).toBe(undefined);
    });
  });
});
