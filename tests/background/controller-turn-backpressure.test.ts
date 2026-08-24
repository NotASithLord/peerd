import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { connectDirectController } from '../../extension/background/direct-controller-client.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/structured-clone-size.js';

const clone = <T>(value: T): T => structuredClone(value);

const makeSessions = () => {
  let record: any = {
    sessionId: 'session-backpressure', provider: 'provider-1', model: 'model-1', messages: [],
  };
  return {
    get: async (sessionId: string) => sessionId === record.sessionId ? clone(record) : undefined,
    appendMessage: async (sessionId: string, message: any) => {
      if (sessionId !== record.sessionId) throw new Error('session not found');
      record = { ...record, messages: [...record.messages, clone(message)] };
      return clone(record);
    },
    updateAssistantMessage: async (sessionId: string, messageId: string, patch: any) => {
      if (sessionId !== record.sessionId) throw new Error('session not found');
      const index = record.messages.findIndex((message: any) => message.id === messageId);
      if (index < 0) throw new Error('assistant message not found');
      const messages = [...record.messages];
      messages[index] = { ...messages[index], ...clone(patch) };
      record = { ...record, messages };
      return clone(record);
    },
    setTrimSummary: async () => clone(record),
  };
};

const descriptor = {
  name: 'read_fixture', description: 'Read a fixture.', schema: { type: 'object' },
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for controller progress');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const drain = async (iterable: AsyncIterable<any>) => {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const connectHarness = async () => {
  let sequence = 0;
  let client: Awaited<ReturnType<typeof connectDirectController>>;
  let bridge: ReturnType<typeof makeControllerTurnBridge>;
  const newId = () => `backpressure-id-${++sequence}`;
  bridge = makeControllerTurnBridge({ getClient: async () => client, newId });
  client = await connectDirectController({
    capabilities: ['turn.run'],
    supportedCapabilities: ['turn.run'],
    buildDigest: CONTROLLER_BUILD_DIGEST,
    authorizeCall: (_capability, payload) => bridge.authorize(payload),
    handleKernelCall: (operation, payload, context) =>
      bridge.handleKernelCall(operation, payload, context),
    loadController: async () => ({
      call: (capability: string, payload: unknown, options: any) => {
        expect(capability).toBe('turn.run');
        return runControllerTurn(payload, options);
      },
    }),
    newId,
  });
  return {
    bridge,
    close: () => {
      client.close();
      bridge.close();
    },
  };
};

const makeContext = ({
  signal,
  toolCount,
  toolDispatch,
}: {
  signal: AbortSignal;
  toolCount: number;
  toolDispatch: (call: any) => Promise<any>;
}) => ({
  sessionId: 'session-backpressure',
  userText: 'run the read wave',
  sessions: makeSessions(),
  tools: [descriptor],
  refreshTools: async () => [descriptor],
  classifyToolCall: () => ({ actionClass: 'read', confirm: false }),
  toolDispatch,
  getSystemPrompt: async () => 'PINNED-SYSTEM',
  appendAudit: async () => {},
  enrichTrimSummary: () => {},
  getSecret: async () => 'kernel-secret',
  safeFetch: async () => new Response('unused'),
  signal,
  reasoning: { enabled: false },
  oneShot: true,
  callModel: async function* () {
    for (let index = 0; index < toolCount; index += 1) {
      const id = `read-${index}`;
      yield { type: 'tool-use-start', id, name: descriptor.name };
      yield { type: 'tool-use-delta', id, partialJson: `{"index":${index}}` };
      yield { type: 'tool-use-stop', id };
    }
    yield { type: 'message-stop', stopReason: 'tool_use' };
  },
});

describe('production direct-controller tool backpressure', () => {
  test('admits a saturated read wave in FIFO 64-slot batches without loss or duplication', async () => {
    const harness = await connectHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const toolDispatch = (call: any) => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(call.id);
      releases.set(call.id, () => {
        releases.delete(call.id);
        active -= 1;
        resolve({ ok: true, content: call.id });
      });
    });
    const abort = new AbortController();
    const turn = drain(harness.bridge.runUserTurn(makeContext({
      signal: abort.signal, toolCount: 130, toolDispatch,
    })));
    try {
      await waitFor(() => started.length === 64);
      expect(started).toEqual(Array.from({ length: 64 }, (_, index) => `read-${index}`));
      for (let index = 0; index < 64; index += 1) releases.get(`read-${index}`)?.();

      await waitFor(() => started.length === 128);
      expect(started.slice(64)).toEqual(
        Array.from({ length: 64 }, (_, index) => `read-${index + 64}`),
      );
      for (let index = 64; index < 128; index += 1) releases.get(`read-${index}`)?.();

      await waitFor(() => started.length === 130);
      expect(started.slice(128)).toEqual(['read-128', 'read-129']);
      releases.get('read-128')?.();
      releases.get('read-129')?.();

      const events = await turn;
      expect(maxActive).toBe(64);
      expect(active).toBe(0);
      expect(new Set(started).size).toBe(130);
      expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(130);
    } finally {
      for (const release of releases.values()) release();
      harness.close();
    }
  });

  test('abort rejects the queued wave before kernel dispatch and never leaks a later start', async () => {
    const harness = await connectHarness();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const toolDispatch = (call: any) => new Promise((resolve) => {
      started.push(call.id);
      releases.set(call.id, () => {
        releases.delete(call.id);
        resolve({ ok: true, content: call.id });
      });
    });
    const abort = new AbortController();
    const turn = drain(harness.bridge.runUserTurn(makeContext({
      signal: abort.signal, toolCount: 130, toolDispatch,
    }))).then(
      (events) => ({ ok: true as const, events }),
      (error) => ({ ok: false as const, error }),
    );
    try {
      await waitFor(() => started.length === 64);
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toEqual(Array.from({ length: 64 }, (_, index) => `read-${index}`));
      const settlement = await turn;
      expect(settlement.ok).toBe(false);
      if (!settlement.ok) expect(settlement.error).toMatchObject({ outcomeKnown: false });

      for (const release of [...releases.values()]) release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toHaveLength(64);
    } finally {
      for (const release of releases.values()) release();
      harness.close();
    }
  });
});
