import { describe, expect, test } from 'bun:test';
import { makeControllerTurnBridge } from '../../extension/background/controller-turn-bridge.js';
import { connectDirectController } from '../../extension/background/direct-controller-client.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/structured-clone-size.js';
import { getToolPolicy } from '../../extension/peerd-runtime/tools/metadata/policy.js';
import { projectToolAuthority, toToolDescriptor } from '../../extension/peerd-runtime/tools/metadata/descriptor.js';
import {
  prepareToolCall as prepareRuntimeToolCall,
  settleToolCall as settleRuntimeToolCall,
} from '../../extension/peerd-runtime/tools/dispatcher.js';
import { CONTROLLER_AUTHORITY_MANIFEST } from '../../extension/shared/controller-authority-manifest.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

const clone = <T>(value: T): T => structuredClone(value);

const makeSessions = () => {
  let record: any = {
    sessionId: 'session-backpressure', provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [],
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
    snapshot: () => clone(record),
  };
};

// why: the final architecture has no generic dispatcher. Exercise saturation
// through a real controller-owned tool and its exact execution authority.
const descriptor = projectToolAuthority(toToolDescriptor(getToolPolicy('read_result')));

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000, detail = () => '') => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for controller progress${detail()}`);
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
  let modelCall: any = null;
  let client: Awaited<ReturnType<typeof connectDirectController>>;
  let bridge: ReturnType<typeof makeControllerTurnBridge>;
  const newId = () => `backpressure-id-${++sequence}`;
  bridge = makeControllerTurnBridge({
    getClient: async () => client,
    newId,
    providerEgress: makeScriptedProviderAuthority(() => modelCall) as any,
    toolManifest: CONTROLLER_AUTHORITY_MANIFEST,
    prepareToolCall: async (call: any, ctx: any, binding: any) => {
      const prepared: any = await prepareRuntimeToolCall(call, ctx, binding.descriptor);
      return prepared?.prepared === true ? {
        mode: 'execute', custody: prepared, args: prepared.args,
        projection: {
          sessionId: ctx.session?.sessionId,
          runtimeCapabilities: ctx.runtimeCapabilities,
        },
        manifestDigest: CONTROLLER_AUTHORITY_MANIFEST.digest,
      } : { mode: 'result', result: prepared };
    },
    settleToolCall: async ({ custody, result }: any) => settleRuntimeToolCall(custody, {
      result: result.value,
    }),
  });
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
    runUserTurn: (context: any) => {
      modelCall = context.callModel;
      return bridge.runUserTurn(context);
    },
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
  session: { sessionId: 'session-backpressure', kind: 'chat' },
  tools: [descriptor],
  refreshTools: async () => [descriptor],
  classifyToolCall: () => ({ actionClass: 'read', confirm: false }),
  audit: async () => {},
  hooks: [],
  permission: { mode: 'act', confirmActions: false },
  toolDispatch,
  // why: exercise the real read-only introspection authority instead of
  // forging a read classification for the side-effecting script tool.
  resultStore: {
    get: async (key: string) => {
      await toolDispatch({ id: key, name: 'read_result', args: { key } });
      return {
        key, ownerSessionId: 'session-backpressure', producer: 'script',
        text: key, fenced: false, originLabel: 'script',
      };
    },
  },
  actorIsolation: {
    status: 'available', host: 'background-page-worker', reason: null, retryable: false,
  },
  getSystemPrompt: async () => 'PINNED-SYSTEM',
  appendAudit: async () => {},
  enrichTrimSummary: () => {},
  getSecret: async () => 'kernel-secret',
  safeFetch: async () => new Response('unused'),
  signal,
  previousTurnAt: null,
  turnNow: 1_700_000_000_000,
  activeTabContext: null,
  protectedTabContext: null,
  recoveryBlock: '',
  reasoning: { enabled: false },
  oneShot: true,
  callModel: async function* () {
    for (let index = 0; index < toolCount; index += 1) {
      const id = `read-${index}`;
      yield { type: 'tool-use-start', id, name: descriptor.name };
      yield { type: 'tool-use-delta', id, partialJson: `{"key":"${id}"}` };
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
    const turn = drain(harness.runUserTurn(makeContext({
      signal: abort.signal, toolCount: 130, toolDispatch,
    })));
    try {
      await waitFor(() => started.length >= 64, 5_000, () => ` (started=${started.length})`);
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
    const turn = drain(harness.runUserTurn(makeContext({
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

  test('post-commit Stop crosses the channel and finalizes as aborted', async () => {
    const harness = await connectHarness();
    const sessions = makeSessions();
    const abort = new AbortController();
    let opened = () => {};
    const modelOpened = new Promise<void>((resolve) => { opened = resolve; });
    const context = {
      ...makeContext({ signal: abort.signal, toolCount: 0, toolDispatch: async () => ({ ok: true }) }),
      sessions,
      callModel: async function* (args: any) {
        opened();
        await new Promise((_, reject) => {
          const stop = () => reject(new DOMException('model aborted', 'AbortError'));
          if (args.signal.aborted) stop();
          else args.signal.addEventListener('abort', stop, { once: true });
        });
      },
    };
    try {
      const turn = drain(harness.runUserTurn(context));
      await modelOpened;
      abort.abort();
      const events = await turn;
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'stop', stopReason: 'aborted',
      }));
      expect(sessions.snapshot().messages.at(-1)).toMatchObject({
        role: 'assistant', streaming: false, stopReason: 'aborted',
      });
      const workerSource = await Bun.file(
        new URL('../../extension/offscreen/controller-worker.js', import.meta.url),
      ).text();
      expect(workerSource).toContain("'turn.tool.settle'");
    } finally {
      harness.close();
    }
  });

  test('Stop after tool dispatch persists unknown custody across the controller channel', async () => {
    const harness = await connectHarness();
    const sessions = makeSessions();
    const abort = new AbortController();
    let admitted = () => {};
    let release = () => {};
    const toolAdmitted = new Promise<void>((resolve) => { admitted = resolve; });
    const context = {
      ...makeContext({
        signal: abort.signal,
        toolCount: 1,
        toolDispatch: () => new Promise((resolve) => {
          release = () => resolve({ ok: true, content: 'RAW LATE EFFECT' });
          admitted();
        }),
      }),
      sessions,
    };
    try {
      const running = drain(harness.runUserTurn(context)).then(
        (events) => ({ ok: true as const, events, error: null }),
        (error) => ({ ok: false as const, events: [], error }),
      );
      await toolAdmitted;
      abort.abort();
      const settlement = await running;
      release();

      expect(settlement).toMatchObject({
        ok: false,
        error: { code: 'tool-outcome-unknown', outcomeKnown: false, retryable: false },
      });
      const assistant = sessions.snapshot().messages.at(-1);
      expect(assistant).toMatchObject({
        role: 'assistant', streaming: false,
        errorCode: 'tool-outcome-unknown', outcomeKnown: false, retryable: false,
        error: expect.stringContaining('outcome unknown'),
      });
      expect(assistant.stopReason).not.toBe('aborted');
      expect(JSON.stringify(sessions.snapshot())).not.toContain('RAW LATE EFFECT');
    } finally {
      release();
      harness.close();
    }
  });
});
