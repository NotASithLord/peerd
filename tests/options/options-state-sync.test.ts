import { describe, expect, test } from 'bun:test';
import { makeReconciledUiSender } from '../../extension/shared/ui-runtime-client.js';

const makeHarness = (reply: any) => {
  const events: string[] = [];
  const send = makeReconciledUiSender({
    send: async (message) => {
      events.push(message.type.startsWith('transfer/') ? 'transfer' : 'runtime');
      return reply;
    },
    fold: () => { events.push('fold'); },
    reconcile: async () => { events.push('refresh'); },
    afterReply: (message, result) => message.type === 'transfer/import'
      && (result?.ok || result?.partial),
  });
  return { send, events };
};

describe('Options state synchronization', () => {
  test('refreshes state before a successful import resolves', async () => {
    const { send, events } = makeHarness({ ok: true, imported: { settings: 1 } });
    await send({ type: 'transfer/import' });
    expect(events).toEqual(['transfer', 'fold', 'refresh']);
  });

  test('refreshes after a partial import but not an unchanged failure', async () => {
    const partial = makeHarness({ ok: false, partial: { settings: 1 } });
    await partial.send({ type: 'transfer/import' });
    expect(partial.events).toEqual(['transfer', 'fold', 'refresh']);

    const failed = makeHarness({ ok: false, error: 'wrong-passphrase' });
    await failed.send({ type: 'transfer/import' });
    expect(failed.events).toEqual(['transfer', 'fold']);
  });

  test('reconciles resolved and rejected unknown effects without replaying them', async () => {
    const resolved = makeHarness({ ok: false, outcomeKnown: false });
    await resolved.send({ type: 'settings/update', patch: { voiceEnabled: true } });
    expect(resolved.events).toEqual(['runtime', 'fold', 'refresh']);

    const events: string[] = [];
    const unknown = Object.assign(new Error('private transport H-1'), {
      outcomeKnown: false, retryable: false,
    });
    const send = makeReconciledUiSender({
      send: async () => { events.push('runtime'); throw unknown; },
      fold: () => { events.push('fold'); },
      reconcile: async () => { events.push('refresh'); },
      afterReply: () => false,
    });
    await expect(send({ type: 'settings/update', patch: { voiceEnabled: true } }))
      .rejects.toBe(unknown);
    expect(events).toEqual(['runtime', 'refresh']);
  });
});
