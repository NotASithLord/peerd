// message_actor is a thin adapter over the SW-injected ctx.messageActor
// orchestrator. Its value is in what it FORWARDS: the request it builds is the
// contract the actor mailbox / sender-gate keys on, so a dropped field or a
// loosened coercion is a real (silent) behavior change. These pin the request
// object execute() hands to ctx.messageActor.
//
// Case 6 — strict boolean coercions. Case 7 — pass-through of args + ctx fields.

import { describe, test, expect } from 'bun:test';
import { messageActorTool } from '../../../extension/peerd-runtime/tools/defs/message-actor.js';

// Records the request object execute() passes to ctx.messageActor so the built
// request is assertable. Typed `any` (like tests/.../fetch-url.test.ts) — the
// mock only needs the slots message_actor actually reads.
const recordingCtx = (over: any = {}) => {
  const seen: { req?: any } = {};
  const ctx: any = {
    session: { sessionId: 't' },
    messageActor: async (req: any) => { seen.req = req; return { ok: true, content: 'ok' }; },
    ...over,
  };
  return { ctx, seen };
};

describe('message_actor — case 6: strict boolean coercions', () => {
  test('oneShot is forwarded as a strict boolean (only literal true → true)', async () => {
    const truthy = recordingCtx();
    await messageActorTool.execute({ to: 'web', message: 'hi', oneShot: 'yes' }, truthy.ctx);
    expect(truthy.seen.req.oneShot).toBe(false); // 'yes' !== true

    const real = recordingCtx();
    await messageActorTool.execute({ to: 'web', message: 'hi', oneShot: true }, real.ctx);
    expect(real.seen.req.oneShot).toBe(true);

    const omitted = recordingCtx();
    await messageActorTool.execute({ to: 'web', message: 'hi' }, omitted.ctx);
    expect(omitted.seen.req.oneShot).toBe(false); // undefined !== true
  });

  test('inbound mirrors ctx.inbound === true (a truthy non-true is still false)', async () => {
    const yes = recordingCtx({ inbound: true });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, yes.ctx);
    expect(yes.seen.req.inbound).toBe(true);

    const no = recordingCtx({ inbound: 'synthetic' });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, no.ctx);
    expect(no.seen.req.inbound).toBe(false); // 'synthetic' !== true

    const missing = recordingCtx(); // no inbound slot
    await messageActorTool.execute({ to: 'web', message: 'hi' }, missing.ctx);
    expect(missing.seen.req.inbound).toBe(false);
  });

  test('awaitReply: a spawned actor ALWAYS awaits; the orchestrator opts in with await:true', async () => {
    // A spawned (ephemeral) actor awaits its reply no matter what (PR #134).
    const sub = recordingCtx({ session: { sessionId: 's', kind: 'spawned' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, sub.ctx);
    expect(sub.seen.req.awaitReply).toBe(true);

    // The orchestrator ('main') defaults to the async wake — reply on a later turn.
    const main = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, main.ctx);
    expect(main.seen.req.awaitReply).toBe(false); // default: fire-and-continue

    // …but the orchestrator can OPT IN to an in-band await for a primary task.
    const awaited = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi', await: true }, awaited.ctx);
    expect(awaited.seen.req.awaitReply).toBe(true);

    // Strict boolean: a truthy non-true does NOT flip the default async path.
    const loose = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi', await: 'yes' }, loose.ctx);
    expect(loose.seen.req.awaitReply).toBe(false); // 'yes' !== true
  });

  test('degradeToAsync is set ONLY for the orchestrator opt-in, never an ephemeral child', async () => {
    // The wall-clock cap degrades to a later-turn wake — valid only for a sender
    // that HAS a later turn. An ephemeral child (kind:'spawned') has none, so it
    // must never degrade even though it awaits, or its reply would be dropped.
    const orch = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi', await: true }, orch.ctx);
    expect(orch.seen.req.degradeToAsync).toBe(true);
    expect(typeof orch.seen.req.awaitCapMs).toBe('number');
    expect(orch.seen.req.awaitCapMs).toBeGreaterThan(0);

    // A spawned child awaits (awaitReply true) but must NOT degrade.
    const child = recordingCtx({ session: { sessionId: 's', kind: 'spawned' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, child.ctx);
    expect(child.seen.req.awaitReply).toBe(true);
    expect(child.seen.req.degradeToAsync).toBe(false);

    // The orchestrator's DEFAULT (async, no opt-in) does not degrade either.
    const asyncMain = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, asyncMain.ctx);
    expect(asyncMain.seen.req.degradeToAsync).toBe(false);
  });
});

describe('message_actor — case 7: pass-through of args + ctx fields', () => {
  test('preserves the typed pre-effect refusal and safe recovery content', async () => {
    const refusal = {
      ok: false as const,
      error: 'actor_sensitive_tab_requires_site',
      content: 'No actor work was started.',
      structured: { performed: false, outcomeKnown: true },
      outcomeKind: 'pre-effect-failure' as const,
    };
    const { ctx } = recordingCtx({ messageActor: async () => refusal });
    expect(await messageActorTool.execute({ to: '42', message: 'read it' }, ctx))
      .toEqual(refusal);
  });

  test('forwards to/message from args and session/toolUseId/abortSignal from ctx', async () => {
    const abortSignal = { aborted: false, addEventListener() {} };
    const { ctx, seen } = recordingCtx({
      session: { sessionId: 'sess-1', kind: 'spawned' },
      toolUseId: 'tu-1',
      abortSignal,
    });

    await messageActorTool.execute({ to: 'api.github.com', message: 'get the latest release' }, ctx);

    expect(seen.req.to).toBe('api.github.com');
    expect(seen.req.message).toBe('get the latest release');
    expect(seen.req.senderSessionId).toBe('sess-1');
    expect(seen.req.toolUseId).toBe('tu-1');
    // the child's own abort signal is threaded through by reference, not copied
    expect(seen.req.awaitSignal).toBe(abortSignal);
  });

  test('senderSessionId is undefined when ctx has no session', async () => {
    const { ctx, seen } = recordingCtx({ session: undefined });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, ctx);
    expect(seen.req.senderSessionId).toBeUndefined();
  });
});
