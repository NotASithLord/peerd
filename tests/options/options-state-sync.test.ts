import { describe, expect, test } from 'bun:test';
import { makeOptionsSender } from '../../extension/options/options-state-sync.js';

const makeHarness = (reply: any) => {
  const events: string[] = [];
  const send = makeOptionsSender({
    sendRuntime: async () => { events.push('runtime'); return reply; },
    sendTransfer: async () => { events.push('transfer'); return reply; },
    foldReply: () => { events.push('fold'); },
    fetchState: async () => { events.push('refresh'); },
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
});
