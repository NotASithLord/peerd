import { describe, expect, test } from 'bun:test';
import {
  DwebReseedRetiredError,
  runDwebReseedPublication,
} from '../../extension/offscreen/dweb-reseed-publication.js';

describe('dweb reseed publication transaction', () => {
  test('retires after publishing bytes and rolls back before announcement', async () => {
    let current = true;
    const events: string[] = [];
    const operation = runDwebReseedPublication({
      current: () => current,
      publish: async () => { events.push('publish'); current = false; return { hash: 'new' }; },
      announce: async () => { events.push('announce'); return { seq: 2 }; },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); },
    });
    expect(await operation.catch((error) => error)).toBeInstanceOf(DwebReseedRetiredError);
    expect(events).toEqual(['publish', 'rollback-bytes']);
  });

  test('retires after announcement and compensates metadata and bytes', async () => {
    let current = true;
    const events: string[] = [];
    const operation = runDwebReseedPublication({
      current: () => current,
      publish: async () => { events.push('publish'); return { hash: 'new' }; },
      announce: async () => { events.push('announce'); current = false; return { seq: 2 }; },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); },
    });
    expect(await operation.catch((error) => error)).toBeInstanceOf(DwebReseedRetiredError);
    expect(events).toEqual(['publish', 'announce', 'compensate']);
  });

  test('compensates a failed synchronous ownership commit', async () => {
    const events: string[] = [];
    const operation = runDwebReseedPublication({
      current: () => true,
      publish: async () => { events.push('publish'); return { hash: 'new' }; },
      announce: async () => { events.push('announce'); return { seq: 2 }; },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); throw new Error('commit-failed'); },
    });
    expect(await operation.catch((error) => error.message)).toBe('commit-failed');
    expect(events).toEqual(['publish', 'announce', 'commit', 'compensate']);
  });

  test('commits exactly once while the generation remains current', async () => {
    const events: string[] = [];
    expect(await runDwebReseedPublication({
      current: () => true,
      publish: async () => { events.push('publish'); return { hash: 'new' }; },
      announce: async () => { events.push('announce'); return { seq: 2 }; },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); },
    })).toEqual({ published: { hash: 'new' }, announced: { seq: 2 } });
    expect(events).toEqual(['publish', 'announce', 'commit']);
  });
});
