import { describe, expect, test } from 'bun:test';
import {
  publishFailureError, runPublishTransaction,
} from '../../extension/shared/publish-transaction.js';

describe('publish transaction', () => {
  test('preserves an unknown host effect while staged bytes unwind', () => {
    const failure = publishFailureError({
      ok: false, error: 'durable residue', code: 'rollback-incomplete',
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    }, 'publish failed');
    expect(failure).toMatchObject({
      message: 'durable residue', code: 'rollback-incomplete',
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
  });

  test('a failed byte rollback remains an explicit unknown performed effect', async () => {
    const failure = await runPublishTransaction({
      publish: async () => ({ hash: 'new' }),
      announce: async () => { throw publishFailureError({
        ok: false, error: 'refused', performed: false, outcomeKnown: true,
        outcomeKind: 'pre-effect-failure', retryable: false,
      }, 'announce failed'); },
      rollback: async () => { throw new Error('unserve failed'); },
    }).then(() => null, (cause) => cause);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      code: 'publish-rollback-incomplete', performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
  });

  test('a lost announcement response retains staged bytes for a possible commit', async () => {
    let rolledBack = false;
    const failure = await runPublishTransaction({
      publish: async () => ({ hash: 'new' }),
      announce: async () => { throw publishFailureError({
        ok: false, error: 'response lost', performed: true, outcomeKnown: false,
        outcomeKind: 'transport-lost', retryable: false,
      }, 'announce failed'); },
      rollback: async () => { rolledBack = true; },
    }).then(() => null, (cause) => cause);
    expect(rolledBack).toBe(false);
    expect(failure).toMatchObject({
      performed: true, outcomeKnown: false,
      outcomeKind: 'transport-lost', retryable: false,
    });
  });

  test('revokes a first share when its metadata announcement fails', async () => {
    const served = new Set<string>();
    await expect(runPublishTransaction({
      publish: async () => { served.add('new'); return { hash: 'new' }; },
      announce: async () => { throw new Error('metadata failed'); },
      rollback: ({ hash }) => { served.delete(hash); },
    })).rejects.toThrow('metadata failed');
    expect([...served]).toEqual([]);
  });

  test('revokes only the new bytes when a reshare announcement fails', async () => {
    const served = new Set(['old']);
    await expect(runPublishTransaction({
      publish: async () => { served.add('new'); return { hash: 'new' }; },
      announce: async () => { throw new Error('metadata failed'); },
      rollback: ({ hash }) => { served.delete(hash); },
      supersede: () => { served.delete('old'); },
    })).rejects.toThrow('metadata failed');
    expect([...served]).toEqual(['old']);
  });

  test('revokes the superseded version only after the new announcement succeeds', async () => {
    const events: string[] = [];
    const served = new Set(['old']);
    await runPublishTransaction({
      publish: async () => { events.push('publish'); served.add('new'); return { hash: 'new' }; },
      announce: async () => { events.push('announce'); return { ok: true }; },
      rollback: ({ hash }) => { served.delete(hash); },
      supersede: () => { events.push('supersede'); served.delete('old'); },
    });
    expect(events).toEqual(['publish', 'announce', 'supersede']);
    expect([...served]).toEqual(['new']);
  });

  test('keeps committed bytes when superseded-version cleanup fails', async () => {
    const served = new Set(['old']);
    await expect(runPublishTransaction({
      publish: async () => { served.add('new'); return { hash: 'new' }; },
      announce: async () => ({ ok: true }),
      rollback: ({ hash }) => { served.delete(hash); },
      supersede: () => { throw new Error('cleanup failed'); },
    })).rejects.toThrow('cleanup failed');
    expect([...served]).toEqual(['old', 'new']);
  });
});
