import { describe, expect, test } from 'bun:test';
import { createControllerTurnComposeControl } from '../../extension/background/controller-turn-compose-control.js';

describe('controller turn compose control', () => {
  test('keeps the exact private grant through a pre-commit retry and retires it after settlement', async () => {
    let attempts = 0;
    let admittedPayload: any;
    let replayContext: any;
    const contexts: any[] = [];
    let control: ReturnType<typeof createControllerTurnComposeControl>;
    control = createControllerTurnComposeControl({
      prepareContext: async (input) => ({ sessionId: input.ctx.sessionId }),
      handleEffect: async (_operation, _payload, context) => {
        contexts.push(context.composeContext);
        return { ok: true, outcomeKnown: true, value: [] };
      },
      call: async (_capability, payload) => {
        admittedPayload = payload;
        const authority = control.authorize(payload);
        expect(authority).not.toBeNull();
        attempts += 1;
        if (attempts === 1) {
          // A startup/lifetime retry asks the host to authorize the same exact
          // payload again while the outer compose call is still active.
          expect(control.authorize(payload)).toEqual(authority);
        }
        replayContext = {
          capability: 'turn.compose', outerPayload: payload, authority,
        };
        return control.handleKernelCall('turn.compose.list-commands', {}, replayContext);
      },
    });

    await expect(control.compose({ text: 'hello', ctx: { sessionId: 's1' } } as any))
      .resolves.toMatchObject({ ok: true });
    expect(contexts).toEqual([{ sessionId: 's1' }]);
    expect(control.authorize(admittedPayload)).toBeNull();
    expect(control.handleKernelCall('turn.compose.list-commands', {}, replayContext))
      .toMatchObject({ ok: false, code: 'kernel-operation-denied' });
  });

  test('refuses unknown capabilities and mismatched outer payloads', async () => {
    let control: ReturnType<typeof createControllerTurnComposeControl>;
    control = createControllerTurnComposeControl({
      handleEffect: async () => ({ ok: true }),
      call: async (_capability, payload) => {
        const authority = control.authorize(payload);
        expect(control.handleKernelCall('turn.compose.list-commands', {}, {
          capability: 'turn.unknown', outerPayload: payload, authority,
        })).toMatchObject({ ok: false });
        expect(control.handleKernelCall('turn.compose.list-commands', {}, {
          capability: 'turn.compose', outerPayload: {
            ...payload as Record<string, unknown>,
          }, authority,
        })).toMatchObject({ ok: false });
        return { ok: true };
      },
    });
    await control.compose({ text: 'hello' });
  });

  test('Stop after private preparation prevents grant and controller dispatch', async () => {
    const abort = new AbortController();
    let calls = 0;
    const control = createControllerTurnComposeControl({
      prepareContext: async () => {
        abort.abort();
        return { signal: abort.signal };
      },
      handleEffect: async () => ({ ok: true }),
      call: async () => { calls += 1; return { ok: true }; },
    });
    await expect(control.compose({ text: 'hello' }, { signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  test('Stop races stalled private preparation and never grants or dispatches', async () => {
    const abort = new AbortController();
    let calls = 0;
    const stalled = new Promise(() => {});
    const control = createControllerTurnComposeControl({
      prepareContext: async () => stalled,
      handleEffect: async () => ({ ok: true }),
      call: async () => { calls += 1; return { ok: true }; },
    });
    const pending = control.compose({ text: 'hello' }, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});
