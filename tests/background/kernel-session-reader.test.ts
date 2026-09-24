import { describe, expect, test } from 'bun:test';
import { createKernelSessionReader } from '../../extension/background/kernel-session-reader.js';

describe('native kernel session reader', () => {
  test('reads both record shapes and projects summaries without scanning message bodies', async () => {
    const stores: Record<string, any[]> = {
      sessions: [
        { sessionId: 'old', createdAt: 1, messages: [{ id: 'o', when: 2 }] },
        { sessionId: 'new', createdAt: 3, messagesV2: true,
          msgIndex: ['m2', 'missing', 'm1'], latestNonSyntheticUserMessageId: 'm2' },
      ],
      session_messages: [
        { id: 'm1', sessionId: 'new', message: { id: 'm1', when: 4 } },
        { id: 'm2', sessionId: 'new', message: {
          id: 'm2', when: 5, role: 'user', content: 'Build it',
        } },
      ],
    };
    const reads: string[] = [];
    const writes: string[] = [];
    const reader = createKernelSessionReader({
      get: async (store: string, key: string) => {
        reads.push(`get:${store}:${key}`);
        return stores[store]?.find((row) => row.sessionId === key || row.id === key);
      },
      getAll: async (store: string) => {
        reads.push(`getAll:${store}`);
        return [...(stores[store] ?? [])];
      },
      getMany: async (store: string, keys: string[]) => {
        reads.push(`getMany:${store}:${keys.join(',')}`);
        return keys.map((key) => stores[store]?.find((row) => row.id === key));
      },
      patch: async (store: string, key: string, fields: Record<string, unknown>) => {
        writes.push(`patch:${store}:${key}`);
        const row = stores[store]?.find((candidate) => candidate.sessionId === key);
        if (!row) return undefined;
        Object.assign(row, fields);
        return row;
      },
    });

    expect((await reader.get('new')).messages.map((message: any) => message.id))
      .toEqual(['m2', 'm1']);
    expect((await reader.listMetadata()).map((session: any) => session.sessionId))
      .toEqual(['new', 'old']);
    expect(await reader.getMetadata('new')).toEqual({
      sessionId: 'new', createdAt: 3, kind: 'chat', depth: 0,
    });
    reads.length = 0;
    expect(await reader.listSummaries()).toEqual([
      {
        kind: 'chat', sessionId: 'new', title: null, createdAt: 3,
        lastMessageAt: 4, messageCount: 2, archivedAt: undefined,
        provider: undefined, model: undefined, hasCustomSystemPrompt: false,
        toolManifest: undefined,
      },
      {
        kind: 'chat', sessionId: 'old', title: null, createdAt: 1,
        lastMessageAt: 2, messageCount: 1, archivedAt: undefined,
        provider: undefined, model: undefined, hasCustomSystemPrompt: false,
        toolManifest: undefined,
      },
    ]);
    expect(reads).toEqual(['getAll:sessions', 'getMany:session_messages:m2,missing,m1']);
    await expect(reader.updateMetadata('old', { model: 'next' }))
      .resolves.toMatchObject({ sessionId: 'old', model: 'next' });
    expect(writes).toEqual(['patch:sessions:old']);
  });

  test('uses durable summary metadata without reading message rows', async () => {
    let messageReads = 0;
    const reader = createKernelSessionReader({
      get: async () => undefined,
      getAll: async (store: string) => store === 'sessions'
        ? Array.from({ length: 100 }, (_, index) => ({
          sessionId: `chat-${index}`, createdAt: index, messagesV2: true,
          msgIndex: [`message-${index}`], messageCount: 1, lastMessageAt: index + 1,
        })) : [],
      getMany: async () => { messageReads += 1; return []; },
    });
    expect(await reader.listSummaries()).toHaveLength(100);
    expect(messageReads).toBe(0);
  });

  test('drops hidden sessions before reading their message rows', async () => {
    let messageReads = 0;
    const reader = createKernelSessionReader({
      get: async () => undefined,
      getAll: async (store: string) => store === 'sessions'
        ? Array.from({ length: 200 }, (_, index) => ({
          sessionId: `actor-${index}`, kind: 'actor', messagesV2: true,
          msgIndex: [`message-${index}`], createdAt: index,
        })) : [],
      getMany: async () => { messageReads += 1; return []; },
    });
    expect(await reader.listSummaries()).toEqual([]);
    expect(messageReads).toBe(0);
  });

  test('backfills verified legacy summaries once', async () => {
    const records = [{
      sessionId: 'chat', createdAt: 1, messagesV2: true,
      msgIndex: ['owned', 'missing', 'foreign'],
    }];
    const rows: Record<string, any> = {
      owned: { id: 'owned', sessionId: 'chat', message: { when: 2 } },
      foreign: { id: 'foreign', sessionId: 'other', message: { when: 3 } },
    };
    let messageReads = 0;
    const reader = createKernelSessionReader({
      get: async () => undefined,
      getAll: async (store: string) => store === 'sessions' ? records : [],
      getMany: async (_store: string, keys: string[]) => {
        messageReads += 1;
        return keys.map((key) => rows[key]);
      },
      mutate: async (_store: string, _key: string, transform: (current: any) => any) => {
        records[0] = transform(records[0]);
        return records[0];
      },
    });
    await expect(reader.listSummaries()).resolves.toMatchObject([{
      messageCount: 1, lastMessageAt: 2,
    }]);
    await expect(reader.listSummaries()).resolves.toMatchObject([{
      messageCount: 1, lastMessageAt: 2,
    }]);
    expect(messageReads).toBe(1);
  });

  test('counts only durable real user messages as prior onboarding history', async () => {
    const sessions: any[] = [];
    const messages: any[] = [];
    const reader = createKernelSessionReader({
      get: async (store: string, key: string) => (store === 'session_messages'
        ? messages.find((row) => row.id === key)
        : sessions.find((row) => row.sessionId === key)),
      getAll: async (store: string) => store === 'sessions' ? sessions : messages,
    });
    sessions.push({ sessionId: 'empty', messagesV2: true, msgIndex: [] });
    expect(await reader.hasChat()).toBe(false);
    sessions.push({
      sessionId: 'actor', kind: 'actor', messages: [{ role: 'user', content: 'daemon' }],
    });
    sessions.push({
      sessionId: 'synthetic', messages: [{ role: 'user', content: 'seed', synthetic: true }],
    });
    expect(await reader.hasChat()).toBe(false);
    sessions.push({
      sessionId: 'v2', messagesV2: true, latestNonSyntheticUserMessageId: 'real',
    });
    messages.push({
      id: 'real', sessionId: 'v2', message: { role: 'user', content: 'hello' },
    });
    expect(await reader.hasChat()).toBe(true);
    messages[0].message.content = '   ';
    sessions.push({ sessionId: 'legacy', messages: [{ role: 'user', content: 'legacy' }] });
    expect(await reader.hasChat()).toBe(true);
  });
});
