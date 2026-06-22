// @ts-check
// Agent loop tests — with mock callModel + mock idb.
//
// We test the loop's event stream shape, not its IO. Real Anthropic
// calls are tested manually via the side panel.

import { describe, it, expect } from '../../framework.js';
import { runUserTurn, createSessionStore } from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {import('/peerd-runtime/loop/agent-loop.js').LoopEvent} LoopEvent */
/** @typedef {Parameters<typeof runUserTurn>[0]} RunCtx */
/** @typedef {import('/peerd-provider/types.js').AssistantMessage} AssistantMessage */
/** @typedef {import('/peerd-provider/types.js').UserMessage} UserMessage */

// why: the test ctx is a deliberately-minimal stand-in for the real loop
// ctx — sessionId starts null and stub functions get reassigned per test.
// Cast to the runUserTurn parameter type (the production contract) at the
// boundary; the fixture remains a mutable `any` internally for ergonomics.
/** @param {Record<string, any>} ctx @returns {RunCtx} */
const asRunCtx = (ctx) => /** @type {RunCtx} */ (/** @type {unknown} */ (ctx));

/** @param {Record<string, any>} [overrides] */
const buildCtx = (overrides = {}) => {
  const idb = makeMockIdb();
  let i = 0;
  const sessions = createSessionStore({
    idb,
    now: () => 1000,
    makeId: () => `id-${++i}`,
  });
  /** @type {any[]} */
  const audited = [];
  /** @type {Record<string, any>} */
  const ctx = {
    sessions,                    // ← must be inside ctx (was only at outer scope)
    sessionId: null,             // filled in by test after create
    userText: 'hi',
    callModel: () => mockTextStream(['Hello', ', world!']),
    getSecret: async () => 'sk-test',
    safeFetch: async () => new Response('ok'),
    getSystemPrompt: async () => 'sys',
    appendAudit: async (/** @type {any} */ e) => { audited.push(e); },
    now: () => 1000,
    ...overrides,
  };
  return { sessions, audited, ctx };
};

/**
 * @param {string[]} deltas
 * @param {string} [stopReason]
 * @returns {AsyncGenerator<ProviderEvent>}
 */
async function* mockTextStream(deltas, stopReason = 'end_turn') {
  for (const t of deltas) yield { type: 'text-delta', text: t };
  yield { type: 'message-stop', stopReason };
}

/** @param {AsyncIterable<LoopEvent>} gen @returns {Promise<LoopEvent[]>} */
const drain = async (gen) => {
  /** @type {LoopEvent[]} */
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
};

// why: LoopEvent is a discriminated union; .filter()/.find() with a plain
// predicate don't narrow the element type, so reads of variant-specific
// fields (stopReason/error/toolUseId) need a cast at the read site.
/** @param {LoopEvent | undefined} e @returns {any} */
const asEv = (e) => e;
// why: session.messages is InternalMessage[] (user|assistant union); these
// tests read role-specific fields after a known append. Narrow at the read.
/** @param {import('/peerd-provider/types.js').InternalMessage | undefined} m @returns {any} */
const msg = (m) => m;
// why: sessions.get() returns `Session | undefined`; the record is always
// present in these tests. Cast (don't `!`) to keep the prod type honest.
/** @param {import('/peerd-runtime/sessions/types.js').Session | undefined} s @returns {import('/peerd-runtime/sessions/types.js').Session} */
const present = (s) => /** @type {import('/peerd-runtime/sessions/types.js').Session} */ (s);

describe('agent loop — runUserTurn', () => {
  it('emits state → delta+ → stop on the happy path', async () => {
    const { sessions, audited, ctx } = buildCtx();
    const session = await sessions.create();
    ctx.sessionId = session.sessionId;

    const events = await drain(runUserTurn(asRunCtx(ctx)));

    const types = events.map((e) => e.type);
    // user-message state, assistant-stub state, deltas, finalized-
    // assistant state (emitted before stop so tool cards render before
    // dispatch), stop.
    expect(types).toEqual(['state', 'state', 'delta', 'delta', 'state', 'stop']);

    const stored = present(await sessions.get(session.sessionId));
    expect(stored.messages.length).toBe(2);
    expect(stored.messages[0].role).toBe('user');
    expect(stored.messages[0].content).toBe('hi');
    expect(stored.messages[1].role).toBe('assistant');
    expect(stored.messages[1].content).toBe('Hello, world!');
    expect(msg(stored.messages[1]).streaming).toBe(false);
    expect(msg(stored.messages[1]).stopReason).toBe('end_turn');

    // First user message triggers session_started audit.
    expect(audited.length).toBe(1);
    expect(audited[0].type).toBe('session_started');
    expect(audited[0].sessionId).toBe(session.sessionId);
  });

  it('auto-continues a thinking-only max_tokens truncation via a hidden user nudge', async () => {
    // The field 'silent timeout': adaptive thinking burns the whole
    // output ceiling, the step ends at max_tokens with NO text and NO
    // tool_use, and the turn used to die silently. The loop must append
    // a synthetic user continuation and call the model again.
    const { sessions, ctx } = buildCtx();
    const created = await sessions.create({});
    let calls = 0;
    ctx.sessionId = created.sessionId;
    ctx.callModel = () => {
      calls += 1;
      if (calls === 1) {
        return (async function* () {
          yield { type: 'reasoning-delta', text: 'thinking very hard…' };
          yield { type: 'message-stop', stopReason: 'max_tokens' };
        })();
      }
      return mockTextStream(['recovered.']);
    };
    /** @type {LoopEvent[]} */
    const events = [];
    for await (const ev of runUserTurn(asRunCtx(ctx))) events.push(ev);

    expect(calls).toBe(2);
    const session = present(await sessions.get(created.sessionId));
    const msgs = session.messages;
    // user, assistant(truncated thinking-only), synthetic user, assistant(text)
    expect(msgs.length).toBe(4);
    expect(msgs[1].role).toBe('assistant');
    expect(msg(msgs[1]).stopReason).toBe('max_tokens');
    expect((msgs[1].content || '').trim()).toBe('');
    expect(msgs[2].role).toBe('user');
    expect(msg(msgs[2]).synthetic).toBe(true);
    expect(msg(msgs[2]).content.includes('output token limit')).toBe(true);
    expect(msgs[3].content).toBe('recovered.');
    expect(msg(msgs[3]).stopReason).toBe('end_turn');
  });

  it('gives up after bounded truncation continues (no infinite provider loop)', async () => {
    const { sessions, ctx } = buildCtx();
    const created = await sessions.create({});
    let calls = 0;
    ctx.sessionId = created.sessionId;
    ctx.callModel = () => {
      calls += 1;
      return (async function* () {
        yield { type: 'reasoning-delta', text: 'still thinking…' };
        yield { type: 'message-stop', stopReason: 'max_tokens' };
      })();
    };
    /** @type {LoopEvent[]} */
    const events = [];
    for await (const ev of runUserTurn(asRunCtx(ctx))) events.push(ev);
    // initial + 2 continues, then stop — never more.
    expect(calls).toBe(3);
    const stops = events.filter((e) => e.type === 'stop');
    expect(asEv(stops[stops.length - 1]).stopReason).toBe('max_tokens');
  });

  it('does NOT emit session_started on the second turn', async () => {
    const { sessions, audited, ctx } = buildCtx();
    const session = await sessions.create();
    ctx.sessionId = session.sessionId;
    await drain(runUserTurn(asRunCtx(ctx)));
    audited.length = 0;
    await drain(runUserTurn(asRunCtx({ ...ctx, userText: 'again' })));
    expect(audited.length).toBe(0);
  });

  it('marks the assistant message failed on provider error event', async () => {
    const { sessions, ctx } = buildCtx({
      callModel: () => (async function* () {
        yield { type: 'text-delta', text: 'oops' };
        yield { type: 'error', error: 'server-side fail' };
      })(),
    });
    const session = await sessions.create();
    ctx.sessionId = session.sessionId;

    const events = await drain(runUserTurn(asRunCtx(ctx)));
    expect(events.some((e) => e.type === 'error' && asEv(e).error === 'server-side fail')).toBe(true);
    expect(events[events.length - 1].type).toBe('stop');

    const stored = present(await sessions.get(session.sessionId));
    expect(msg(stored.messages[1]).error).toBe('server-side fail');
    expect(msg(stored.messages[1]).streaming).toBe(false);
    expect(stored.messages[1].content).toBe('oops');
  });

  it('catches thrown exceptions and surfaces as error event', async () => {
    const { sessions, ctx } = buildCtx({
      callModel: () => (async function* () {
        throw new Error('http 500');
      })(),
    });
    const session = await sessions.create();
    ctx.sessionId = session.sessionId;

    const events = await drain(runUserTurn(asRunCtx(ctx)));
    const errEv = events.find((e) => e.type === 'error');
    expect(asEv(errEv)?.error).toBe('http 500');

    const stored = present(await sessions.get(session.sessionId));
    expect(msg(stored.messages[1]).error).toBe('http 500');
    expect(msg(stored.messages[1]).streaming).toBe(false);
  });

  it('throws RuntimeContextIncompleteError when a dep is missing', async () => {
    await expect(async () => {
      const gen = runUserTurn(asRunCtx({ /* missing everything */ }));
      // The throw happens synchronously inside the generator on first
      // next(); awaiting it surfaces the error.
      await gen.next();
    }).toThrow((e) => e.name === 'RuntimeContextIncompleteError');
  });

  it('throws when tools are provided but toolDispatch is not', async () => {
    const { sessions, ctx } = buildCtx();
    const session = await sessions.create();
    ctx.sessionId = session.sessionId;
    ctx.tools = [{ name: 'x', description: 'x', schema: {} }];
    // toolDispatch missing.
    await expect(async () => {
      const gen = runUserTurn(asRunCtx(ctx));
      await gen.next();
    }).toThrow((e) => e.name === 'RuntimeContextIncompleteError');
  });

  describe('inner tool loop', () => {
    // Tool-using mock model: yields tool_use blocks, expects results
    // back in the next call, then yields plain text.
    const buildToolUsingCallModel = () => {
      let call = 0;
      return () => (async function* () {
        call += 1;
        if (call === 1) {
          yield { type: 'text-delta', text: 'Checking storage' };
          yield { type: 'tool-use-start', id: 't_X', name: 'inspect_storage' };
          yield { type: 'tool-use-delta', id: 't_X', partialJson: '{"prefix":' };
          yield { type: 'tool-use-delta', id: 't_X', partialJson: ' "vault"}' };
          yield { type: 'tool-use-stop', id: 't_X' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text-delta', text: 'Done — vault data is base64 blobs.' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        }
      })();
    };

    it('streams tool_use → dispatches → feeds result back → final text', async () => {
      const { sessions, ctx } = buildCtx({
        callModel: buildToolUsingCallModel(),
      });
      /** @type {any[]} */
      const dispatched = [];
      ctx.tools = [{ name: 'inspect_storage', description: 'kv', schema: {} }];
      ctx.toolDispatch = async (/** @type {any} */ call) => {
        dispatched.push(call);
        return {
          ok: true,
          content: JSON.stringify({ 'vault.v1': { wrappedDK: 'abc…xyz (84 chars, base64)' } }),
          meta: { toolName: call.name, primitive: 'webvm', gates: [], durationMs: 7 },
        };
      };
      const session = await sessions.create();
      ctx.sessionId = session.sessionId;

      const events = await drain(runUserTurn(asRunCtx(ctx)));

      // The dispatch happened with the parsed input.
      expect(dispatched.length).toBe(1);
      expect(dispatched[0].name).toBe('inspect_storage');
      expect(dispatched[0].args).toEqual({ prefix: 'vault' });

      // The event stream includes tool-use and tool-result events.
      const types = events.map((e) => e.type);
      expect(types.includes('tool-use')).toBe(true);
      expect(types.includes('tool-result')).toBe(true);
      // Final stop with end_turn (not tool_use).
      const stops = events.filter((e) => e.type === 'stop');
      expect(asEv(stops[stops.length - 1]).stopReason).toBe('end_turn');

      // The session's persisted messages reflect the round-trip:
      // user -> assistant(text+tool_use) -> user(tool_result) -> assistant(text)
      const stored = present(await sessions.get(session.sessionId));
      expect(stored.messages.length).toBe(4);
      expect(stored.messages[0].role).toBe('user');
      expect(stored.messages[1].role).toBe('assistant');
      expect(Array.isArray(msg(stored.messages[1]).toolUses)).toBe(true);
      expect(msg(stored.messages[1]).toolUses[0].input).toEqual({ prefix: 'vault' });
      expect(stored.messages[2].role).toBe('user');
      expect(Array.isArray(msg(stored.messages[2]).toolResults)).toBe(true);
      expect(msg(stored.messages[2]).toolResults[0].tool_use_id).toBe('t_X');
      expect(stored.messages[3].role).toBe('assistant');
      expect(stored.messages[3].content).toContain('Done');
    });

    it('marks tool_result with is_error=true when dispatch returns ok:false', async () => {
      const { sessions, ctx } = buildCtx({
        callModel: buildToolUsingCallModel(),
      });
      ctx.tools = [{ name: 'inspect_storage', description: '', schema: {} }];
      ctx.toolDispatch = async () => ({
        ok: false,
        error: 'gate_blocked:origin:denylist hit',
        meta: { toolName: 'x', primitive: 'tab', gates: [], durationMs: 0 },
      });
      const session = await sessions.create();
      ctx.sessionId = session.sessionId;

      await drain(runUserTurn(asRunCtx(ctx)));

      const stored = present(await sessions.get(session.sessionId));
      const resultMsg = msg(stored.messages.find((m) =>
        m.role === 'user' && Array.isArray(msg(m).toolResults)));
      expect(resultMsg).toBeTruthy();
      expect(resultMsg.toolResults[0].is_error).toBe(true);
      expect(resultMsg.toolResults[0].content.includes('denylist')).toBe(true);
    });

    it('aborts in the stream-end → dispatch gap WITHOUT running the pending tools', async () => {
      // The hard spend-limit halt (and Stop / steer) abort() the controller as
      // the stream ends: adapters emit `usage` — where the limit check rides —
      // one event BEFORE `message-stop`, so the for-await ends normally and the
      // mid-stream AbortError branch never fires. The loop must re-check abort
      // before dispatch, or it runs every already-emitted tool_use anyway.
      const controller = new AbortController();
      const callModel = () => (async function* () {
        yield { type: 'text-delta', text: 'working' };
        yield { type: 'tool-use-start', id: 't_A', name: 'inspect_storage' };
        yield { type: 'tool-use-delta', id: 't_A', partialJson: '{}' };
        yield { type: 'tool-use-stop', id: 't_A' };
        controller.abort();                 // limit / Stop lands here, pre message-stop
        yield { type: 'message-stop', stopReason: 'tool_use' };
      })();
      const { sessions, ctx } = buildCtx({ callModel, signal: controller.signal });
      /** @type {any[]} */
      const dispatched = [];
      ctx.tools = [{ name: 'inspect_storage', description: '', schema: {} }];
      ctx.toolDispatch = async (/** @type {any} */ call) => {
        dispatched.push(call);
        return { ok: true, content: 'should not run',
          meta: { toolName: call.name, primitive: 'inspect', gates: [], durationMs: 0 } };
      };
      const session = await sessions.create();
      ctx.sessionId = session.sessionId;

      const events = await drain(runUserTurn(asRunCtx(ctx)));

      // The pending tool_use never ran — no side effect, no tool-result event.
      expect(dispatched.length).toBe(0);
      expect(events.some((e) => e.type === 'tool-result')).toBe(false);

      const stored = present(await sessions.get(session.sessionId));
      // No tool_result message was appended (user -> assistant only).
      expect(stored.messages.some((m) =>
        m.role === 'user' && Array.isArray(msg(m).toolResults))).toBe(false);
      // The turn is marked aborted — so detectInterruptedTurn treats it as a
      // deliberate stop, NOT a resumable tools-pending interruption.
      const assistant = msg(stored.messages.find((m) => m.role === 'assistant'));
      expect(assistant.stopReason).toBe('aborted');
      expect(Array.isArray(assistant.toolUses)).toBe(true); // the tool_use is still recorded
      // The final stop reports aborted.
      const stops = events.filter((e) => e.type === 'stop');
      expect(asEv(stops[stops.length - 1]).stopReason).toBe('aborted');
    });

    it('runs consecutive READ-class calls concurrently when a classifier is injected', async () => {
      // Two reads in one turn + ctx.classifyToolCall → both dispatches must
      // be in flight together, results persist in EMITTED order even though
      // completion order is reversed.
      const { sessions, ctx } = buildCtx({
        callModel: (() => {
          let step = 0;
          return () => {
            step += 1;
            if (step === 1) {
              return (async function* () {
                yield { type: 'tool-use-start', id: 't_a', name: 'read_a' };
                yield { type: 'tool-use-delta', id: 't_a', partialJson: '{}' };
                yield { type: 'tool-use-stop', id: 't_a' };
                yield { type: 'tool-use-start', id: 't_b', name: 'read_b' };
                yield { type: 'tool-use-delta', id: 't_b', partialJson: '{}' };
                yield { type: 'tool-use-stop', id: 't_b' };
                yield { type: 'message-stop', stopReason: 'tool_use' };
              })();
            }
            return (async function* () {
              yield { type: 'text-delta', text: 'ok' };
              yield { type: 'message-stop', stopReason: 'end_turn' };
            })();
          };
        })(),
      });
      ctx.tools = [
        { name: 'read_a', description: '', schema: {} },
        { name: 'read_b', description: '', schema: {} },
      ];
      ctx.classifyToolCall = () => ({ allowed: true, confirm: false, actionClass: 'read', reason: 'read-only action' });
      /** @param {number} ms */
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      /** @type {string[]} */
      const started = [];
      ctx.toolDispatch = async (/** @type {any} */ call) => {
        started.push(call.name);
        if (call.name === 'read_a') {
          // a completes only after b STARTED — proves overlap. Deadline
          // guard turns a serialization regression into a clean failure
          // instead of a hung test.
          await Promise.race([
            (async () => { while (started.length < 2) await sleep(5); })(),
            sleep(1500).then(() => { throw new Error('serialized: read_b never started'); }),
          ]);
        }
        return { ok: true, content: `${call.name}-result`, meta: {} };
      };
      const session = await sessions.create();
      ctx.sessionId = session.sessionId;

      const events = await drain(runUserTurn(asRunCtx(ctx)));
      expect(started).toEqual(['read_a', 'read_b']);

      // Live results land in completion order (b finished first)...
      const resultIds = events.filter((e) => e.type === 'tool-result').map((e) => asEv(e).toolUseId);
      expect(resultIds).toEqual(['t_b', 't_a']);

      // ...but the persisted history keeps the model's emitted order.
      const stored = present(await sessions.get(session.sessionId));
      const resultMsg = msg(stored.messages.find((m) =>
        m.role === 'user' && Array.isArray(msg(m).toolResults)));
      expect(resultMsg.toolResults.map((/** @type {any} */ b) => b.tool_use_id)).toEqual(['t_a', 't_b']);
    });

    it('handles parallel tool_use blocks in a single turn', async () => {
      // Model yields two tool_use blocks before message_stop. Both
      // should dispatch, both results land in one user message.
      const { sessions, ctx } = buildCtx({
        callModel: () => (async function* () {
          yield { type: 'tool-use-start', id: 't1', name: 'a' };
          yield { type: 'tool-use-delta', id: 't1', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 't1' };
          yield { type: 'tool-use-start', id: 't2', name: 'b' };
          yield { type: 'tool-use-delta', id: 't2', partialJson: '{}' };
          yield { type: 'tool-use-stop', id: 't2' };
          yield { type: 'message-stop', stopReason: 'tool_use' };
        })(),
      });
      /** @type {string[]} */
      const calls = [];
      ctx.tools = [
        { name: 'a', description: '', schema: {} },
        { name: 'b', description: '', schema: {} },
      ];
      const secondCall = false;
      ctx.toolDispatch = async (/** @type {any} */ call) => {
        calls.push(call.name);
        return { ok: true, content: `${call.name}-result`, meta: {} };
      };
      // After tool results, the model returns plain text.
      const realCallModel = ctx.callModel;
      let stepCount = 0;
      ctx.callModel = () => {
        stepCount += 1;
        if (stepCount === 1) return realCallModel();
        return (async function* () {
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        })();
      };
      const session = await sessions.create();
      ctx.sessionId = session.sessionId;

      await drain(runUserTurn(asRunCtx(ctx)));
      expect(calls).toEqual(['a', 'b']);

      const stored = present(await sessions.get(session.sessionId));
      const resultMsg = msg(stored.messages.find((m) =>
        m.role === 'user' && Array.isArray(msg(m).toolResults)));
      expect(resultMsg.toolResults.length).toBe(2);
    });
  });
});
