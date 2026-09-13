import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { createControllerTurnRuntime } from '../../extension/offscreen/controller-turn-runtime.js';
import { createSessionTurnStore } from '../../extension/shared/session-turn-store.js';
import { createControllerKernelQuota } from '../../extension/shared/controller-kernel-quota.js';
import { controllerPayloadBytes } from '../../extension/shared/structured-clone-size.js';
import { createSessionTranscriptPages, TRANSCRIPT_CHUNK_CHARS, TRANSCRIPT_PAGE_LIMIT } from '../../extension/shared/session-transcript.js';
import { planTrim } from '../../extension/peerd-runtime/loop/trim.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const SESSION_ID = 'persisted-large-transcript';
const MODEL = 'claude-sonnet-4-6';
const message = (index: number, content = 'a'.repeat(8000)): any => ({
  id: `history-${index}`, when: index, role: index % 2 ? 'assistant' : 'user', content,
  ...(index % 2 ? { streaming: false, stopReason: 'end_turn' } : {}),
});

const makeStore = async (messages: any[], rolling = false) => {
  const tables = new Map<string, Map<string, any>>([
    ['sessions', new Map()], ['session_messages', new Map()],
  ]);
  const reads: number[] = [];
  const idb = {
    get: async (store: string, id: string) => structuredClone(tables.get(store)?.get(id)),
    getMany: async (store: string, ids: string[]) => {
      reads.push(ids.length);
      return ids.map((id) => structuredClone(tables.get(store)?.get(id)));
    },
    put: async (store: string, value: any) => {
      tables.get(store)!.set(value.id ?? value.sessionId, structuredClone(value));
    },
  };
  await idb.put('sessions', {
    sessionId: SESSION_ID, createdAt: 0, provider: 'anthropic', model: MODEL,
    messagesV2: true, msgIndex: messages.map((row) => row.id),
    ...(rolling ? { trimSummary: planTrim(messages, { contextWindow: 128000 }).summaryState } : {}),
  });
  for (const [seq, row] of messages.entries()) await idb.put('session_messages', {
    id: row.id, sessionId: SESSION_ID, seq, message: row,
  });
  return {
    idb, reads,
    sessions: createSessionTurnStore({ idb, notFound: (id) => new Error(`missing:${id}`) }),
  };
};

const joinedTurn = async (store: Awaited<ReturnType<typeof makeStore>>, {
  userText = 'Continue.',
  duringRead = async () => {},
  attachments,
}: { userText?: string; duringRead?: () => Promise<void>; attachments?: any[] } = {}) => {
  const runtime = createControllerTurnRuntime();
  const requests: any[] = [];
  const media: string[] = [];
  const replies: { operation: string; bytes: number; payload: any; reply: any }[] = [];
  const enrichments: any[] = [];
  let bridge!: ReturnType<typeof makeControllerTurnBridge>;
  let sequence = 0;
  let readHook = false;
  bridge = makeControllerTurnBridge({
    newId: () => `transcript-run-${++sequence}`,
    providerEgress: makeScriptedProviderAuthority(() => async function* () {
      yield { type: 'text-delta', text: 'Complete.' };
      yield { type: 'message-stop', stopReason: 'end_turn' };
    }, (request, grant) => {
      requests.push(request);
      for (const block of request.nativeBody.messages.flatMap((row: any) =>
        Array.isArray(row.content) ? row.content : [])) {
        if (typeof block?.source?.data === 'string') media.push(grant.redeemOpaque(block.source.data));
      }
    }) as any,
    getClient: async () => ({
      call: async (capability: string, payload: any, options: any) => {
        const authority = bridge.authorize(payload);
        const quota = createControllerKernelQuota(capability, payload);
        return runtime.runControllerTurn(payload, {
          signal: options.signal, authority,
          kernelCall: async (operation: string, request: any) => {
            const admitted = quota.admit(operation, request);
            if (!admitted.ok) return admitted;
            if (operation === 'turn.session.read' && !readHook) {
              readHook = true;
              await duringRead();
              const foreign = await bridge.handleKernelCall(operation, {
                ...request, value: { ...request.value, sessionId: 'foreign-session' },
              }, { capability, authority, signal: options.signal, deadlineAt: Date.now() + 60000 });
              expect(foreign).toMatchObject({ ok: false, outcomeKnown: true });
              const overlapping = await bridge.handleKernelCall('turn.session.get', {
                runId: request.runId, value: { sessionId: SESSION_ID },
              }, { capability, authority, signal: options.signal, deadlineAt: Date.now() + 60000 });
              expect(overlapping).toMatchObject({ ok: false, outcomeKnown: true });
            }
            const reply = await bridge.handleKernelCall(operation, request, {
              capability, authority, signal: options.signal, deadlineAt: Date.now() + 60000,
            });
            replies.push({ operation, bytes: controllerPayloadBytes(reply), payload: request, reply });
            const observed = quota.observe(operation, request, reply);
            expect(observed).toMatchObject({ ok: true });
            return observed.ok ? reply : observed;
          },
        });
      },
    }),
  });
  const events: any[] = [];
  try {
    for await (const event of bridge.runUserTurn({
      sessionId: SESSION_ID, userText, sessions: store.sessions,
      ...(attachments ? { attachments } : {}),
      tools: [], allowedOperations: [], maxSteps: 1,
      refreshTools: async () => ({ tools: [], operations: [] }),
      getSystemPrompt: async () => 'Assistant', appendAudit: async () => {},
      enrichTrimSummary: (request: any) => { enrichments.push(request); },
      signal: new AbortController().signal,
      previousTurnAt: null, turnNow: 1, activeTabContext: null, protectedTabContext: null,
      contextWindowOverrides: { [MODEL]: 128000 },
    })) events.push(event);
  } finally { await bridge.close(); }
  return { events, requests, replies, enrichments, media };
};

describe('durable transcript through the real controller quota', () => {
  test('history above 4 MiB reaches inference and preserves rolling indexes, UI, and all durable messages', async () => {
    const history = Array.from({ length: 700 }, (_, index) => message(index));
    const store = await makeStore(history, true);
    expect(JSON.stringify(await store.sessions.get(SESSION_ID)).length).toBeGreaterThan(4 * 1024 * 1024);
    const result = await joinedTurn(store);
    expect(result.requests).toHaveLength(1);
    expect(result.replies.some((row) => row.operation === 'turn.session.read')).toBe(true);
    expect(result.replies.filter((row) => row.operation === 'turn.session.append')
      .every((row) => row.bytes < 2000)).toBe(true);
    expect(result.replies.filter((row) => row.operation === 'turn.event')
      .every((row) => row.payload.value.eventJson.length < 2000)).toBe(true);
    const durable = (await store.sessions.get(SESSION_ID))!;
    expect(durable.messages.slice(0, 700)).toEqual(history);
    expect(durable.messages).toHaveLength(702);
    const expected = planTrim(durable.messages.slice(0, -1), { contextWindow: 128000 });
    expect(durable.trimSummary).toMatchObject({
      covered: expected.summaryState!.covered,
      coveredLastId: expected.summaryState!.coveredLastId,
    });
    expect(result.events.filter((row) => row.type === 'state').at(-1).session).toEqual(durable);
    expect(result.events.some((row) => row.type === 'error')).toBe(false);
  });

  test('one historical message above the frame cap is paged intact before trimming', async () => {
    const history = Array.from({ length: 30 }, (_, index) => message(index));
    history[0].content = '🌊'.repeat(1_100_000);
    const store = await makeStore(history);
    const result = await joinedTurn(store);
    expect(result.requests).toHaveLength(1);
    expect((await store.sessions.get(SESSION_ID))!.messages[0].content).toBe(history[0].content);
    expect(result.enrichments).toHaveLength(1);
    expect(result.enrichments[0].newlyDropped[0].content).toBe(history[0].content);
    expect(result.replies.every((row) => row.bytes < 4 * 1024 * 1024)).toBe(true);
  });

  test('an append crossing 4 MiB acknowledges only its suffix and includes concurrent appends', async () => {
    const history = Array.from({ length: 60 }, (_, index) => message(index, 'x'.repeat(65000)));
    const store = await makeStore(history);
    const concurrent = message(60, 'arrived during snapshot transfer');
    const result = await joinedTurn(store, {
      userText: 'new text '.repeat(40000),
      duringRead: async () => { await store.sessions.appendMessage(SESSION_ID, concurrent); },
    });
    const durable = (await store.sessions.get(SESSION_ID))!;
    expect(JSON.stringify(durable).length).toBeGreaterThan(4 * 1024 * 1024);
    expect(durable.messages[60]).toEqual(concurrent);
    expect(durable.messages).toHaveLength(63);
    expect(result.requests).toHaveLength(1);
    expect(result.replies.filter((row) => row.operation === 'turn.session.append')
      .every((row) => row.bytes < 1024 * 1024)).toBe(true);
    expect(result.events.filter((row) => row.type === 'state')[0].session.messages).toHaveLength(62);
  });

  test('an oversized recent model message fails at model admission without losing stored history', async () => {
    const content = 'x'.repeat(5 * 1024 * 1024);
    const store = await makeStore([message(0, content)]);
    const result = await joinedTurn(store);
    expect(result.requests).toHaveLength(0);
    expect(result.events.some((row) => row.type === 'error'
      && row.error.includes('kernel-operation-payload-too-large'))).toBe(true);
    expect((await store.sessions.get(SESSION_ID))!.messages[0].content).toBe(content);
  });

  test('paged transcripts and compact state keep media opaque while the model receives live pixels', async () => {
    const history = Array.from({ length: 700 }, (_, index) => message(index));
    const image = { name: 'image.png', mediaType: 'image/png', kind: 'image', size: 3 };
    history[698].attachments = [{ ...image, data: 'historical-binary-pixels' }];
    const store = await makeStore(history, true);
    const result = await joinedTurn(store, {
      attachments: [{ ...image, data: 'live-binary-pixels' }],
    });
    expect(result.requests).toHaveLength(1);
    expect(result.media).toContain('live-binary-pixels');
    const channel = JSON.stringify(result.replies);
    expect(channel).not.toContain('live-binary-pixels');
    expect(channel).not.toContain('historical-binary-pixels');
    const durable = (await store.sessions.get(SESSION_ID))!;
    expect((durable.messages[698] as any).attachments[0].data).toBe('historical-binary-pixels');
    expect((durable.messages[700] as any).attachments[0].data).toBeUndefined();
  });
});

test('append projection reads only the suffix, preserves duplicate evidence, and rejects a stale anchor before writing', async () => {
  const store = await makeStore(Array.from({ length: 100 }, (_, index) => message(index)));
  store.reads.length = 0;
  const next = message(100);
  const cursor = { length: 100, lastMessageId: 'history-99' };
  const appended = await store.sessions.appendMessageSince(SESSION_ID, next, cursor);
  expect(appended.session.messages).toEqual([next]);
  expect(appended.persisted).toEqual(next);
  expect(store.reads).toEqual([1]);
  const duplicate = await store.sessions.appendMessageSince(SESSION_ID, { ...next, content: 'forged' }, cursor);
  expect(duplicate.persisted.content).toBe(next.content);
  await expect(store.sessions.appendMessageSince(SESSION_ID, message(101), {
    length: 101, lastMessageId: 'replaced-anchor',
  })).rejects.toThrow('session-transcript-changed');
  expect((await store.sessions.get(SESSION_ID))!.messages).toHaveLength(101);
});

test('transcript pages refuse overlap, stale cursors, skipped pages, and excess work', () => {
  const pages = createSessionTranscriptPages();
  const first = pages.start({ messages: [message(0, 'x'.repeat(TRANSCRIPT_CHUNK_CHARS))] }, 0);
  expect(first.done).toBe(false);
  expect(() => pages.start({}, 0)).toThrow('read-in-progress');
  expect(() => pages.read(first.cursor, 2)).toThrow('cursor-invalid');
  expect(pages.read(first.cursor, 1).done).toBe(true);
  expect(() => pages.read(first.cursor, 1)).toThrow('cursor-invalid');
  for (let index = 2; index < TRANSCRIPT_PAGE_LIMIT; index += 1) pages.start({}, 0);
  expect(() => pages.start({}, 0)).toThrow('budget-exhausted');
  pages.close();
  expect(pages.pending).toBe(false);
});
