import { describe, expect, test } from 'bun:test';
import { runPublishTransaction } from '../../extension/shared/publish-transaction.js';

describe('publish transaction', () => {
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
