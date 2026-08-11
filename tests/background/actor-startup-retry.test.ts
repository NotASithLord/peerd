import { describe, expect, test } from 'bun:test';
import {
  isActorHostStartupFailure, runActorWithStartupRetry,
} from '../../extension/background/actor-startup-retry.js';
import { isKnownActorStartupFailure } from '../../extension/background/offscreen-actor-channel-client.js';

describe('actor startup retry', () => {
  test('two structured channel startup failures exhaust the retry', async () => {
    let calls = 0;
    const attempt = await runActorWithStartupRetry({
      run: async () => {
        calls += 1;
        return {
          ok: false, started: false, phase: 'startup', outcomeKnown: true,
          code: calls === 1 ? 'actor_channel_ready_timeout' : 'actor_channel_accept_timeout',
        };
      },
      isStartupFailure: isKnownActorStartupFailure,
    });
    expect(calls).toBe(2);
    expect(attempt.exhausted).toBe(true);
    expect(attempt.result.code).toBe('actor_channel_accept_timeout');
  });

  test('a started or outcome-unknown failure is never retried', async () => {
    let calls = 0;
    const attempt = await runActorWithStartupRetry({
      run: async () => {
        calls += 1;
        return { ok: false, started: true, phase: 'run', outcomeKnown: false };
      },
      isStartupFailure: isKnownActorStartupFailure,
    });
    expect(calls).toBe(1);
    expect(attempt.exhausted).toBe(false);
  });

  for (const code of ['actor_worker_crashed', 'actor_worker_message_error']) {
    test(`${code} after work starts is never retried`, async () => {
      let calls = 0;
      const attempt = await runActorWithStartupRetry({
        run: async () => {
          calls += 1;
          return { ok: false, started: true, phase: 'run', outcomeKnown: false, code };
        },
        isStartupFailure: isActorHostStartupFailure,
      });
      expect(calls).toBe(1);
      expect(attempt.exhausted).toBe(false);
    });
  }
});
