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

  test('awaitReply is true ONLY for a subagent session (PR #134 reply mode)', async () => {
    const sub = recordingCtx({ session: { sessionId: 's', kind: 'subagent' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, sub.ctx);
    expect(sub.seen.req.awaitReply).toBe(true);

    const main = recordingCtx({ session: { sessionId: 's', kind: 'main' } });
    await messageActorTool.execute({ to: 'web', message: 'hi' }, main.ctx);
    expect(main.seen.req.awaitReply).toBe(false); // 'main' !== 'subagent'
  });
});

describe('message_actor — case 7: pass-through of args + ctx fields', () => {
  test('forwards to/message from args and session/toolUseId/abortSignal from ctx', async () => {
    const abortSignal = { aborted: false, addEventListener() {} };
    const { ctx, seen } = recordingCtx({
      session: { sessionId: 'sess-1', kind: 'subagent' },
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
