import { describe, expect, test } from 'bun:test';
import {
  makeDispatcher,
  normalizeMessageFailureReply,
} from '../../extension/shared/background-dispatcher.js';

const sender = {
  id: 'peerd-bun-test',
  url: 'chrome-extension://peerd-bun-test/home/home.html',
};

const dispatch = (handler: ReturnType<typeof makeDispatcher>, type: string) =>
  new Promise<any>((resolve) => {
    expect(handler({ type }, sender, resolve)).toBe(true);
  });

describe('background message outcome custody', () => {
  test('resolved unknown effects retain custody without exposing transport text', async () => {
    const handler = makeDispatcher({
      effect: async () => ({
        ok: false,
        error: 'private-port-timeout:epoch=secret',
        code: 'host-timeout',
        outcomeKnown: false,
        outcomeKind: 'transport-lost',
      }),
    });
    const reply = await dispatch(handler, 'effect');
    expect(reply).toMatchObject({
      ok: false,
      code: 'host-timeout',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
      retryable: false,
    });
    expect(reply.error).toContain('could not confirm');
    expect(reply.error).not.toContain('private-port');
  });

  test('thrown unknown effects retain custody while known-safe failures stay known', async () => {
    const unknown = makeDispatcher({
      effect: async () => {
        throw Object.assign(new Error('raw host generation detail'), {
          code: 'effect-lost', outcomeKnown: false, outcomeKind: 'transport-lost',
        });
      },
    });
    await expect(dispatch(unknown, 'effect')).resolves.toMatchObject({
      ok: false,
      code: 'effect-lost',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
      retryable: false,
    });

    const known = makeDispatcher({
      validate: async () => { throw new TypeError('name-required'); },
    });
    await expect(dispatch(known, 'validate')).resolves.toEqual({
      ok: false, error: 'name-required',
    });
  });

  test('normalizer leaves known refusals unchanged', () => {
    const reply = { ok: false, error: 'vault-locked' };
    expect(normalizeMessageFailureReply(reply)).toBe(reply);
  });
});
