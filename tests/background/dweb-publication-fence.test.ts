import { describe, expect, test } from 'bun:test';
import { createDwebPublicationFence } from '../../extension/background/dweb-publication-fence.js';
import { runDwebReseedPublication } from '../../extension/offscreen/dweb-reseed-publication.js';

describe('dweb publication fence', () => {
  test('invalidates queued work and serializes stop after admitted work', async () => {
    const fence = createDwebPublicationFence();
    const events: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { started = resolve; });
    const first = fence.run(async () => {
      events.push('publish:start');
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('publish:end');
    });
    const stale = fence.run(async (isCurrent) => {
      events.push(isCurrent() ? 'stale:published' : 'stale:blocked');
    });
    fence.invalidate();
    const stop = fence.run(async () => { events.push('stop'); });
    await publicationStarted;
    release();
    await Promise.all([first, stale, stop]);
    expect(events).toEqual(['publish:start', 'publish:end', 'stale:blocked', 'stop']);
  });

  test('retires a hung reseed and admits its successor without reviving it', async () => {
    const fence = createDwebPublicationFence();
    let release!: () => void;
    let admittedCurrent!: () => boolean;
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { started = resolve; });
    const effects: string[] = [];
    const first = fence.runReseed(async (current) => {
      admittedCurrent = current;
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      if (current()) effects.push('stale-effect');
    }, { timeoutMs: 5 });
    await publicationStarted;
    expect(await first.catch((error) => error.message)).toBe('dweb-reseed-publication-timeout');
    expect(admittedCurrent()).toBe(false);
    await fence.runReseed(async (current) => {
      if (current()) effects.push('successor-effect');
    }, { timeoutMs: 20 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(effects).toEqual(['successor-effect']);
  });

  test('a queued reseed timeout cannot leapfrog an ordinary publication', async () => {
    const fence = createDwebPublicationFence();
    let release!: () => void;
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { started = resolve; });
    const events: string[] = [];
    const ordinary = fence.run(async () => {
      events.push('ordinary:start');
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('ordinary:end');
    });
    await publicationStarted;
    const reseed = fence.runReseed(async () => { events.push('reseed'); }, { timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['ordinary:start']);
    release();
    await Promise.all([ordinary, reseed]);
    expect(events).toEqual(['ordinary:start', 'ordinary:end', 'reseed']);
  });

  test('generation invalidation during byte publication rolls back before announce', async () => {
    const fence = createDwebPublicationFence();
    let release!: () => void;
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { started = resolve; });
    const events: string[] = [];
    const operation = fence.runReseed((current) => runDwebReseedPublication({
      current,
      publish: async () => {
        events.push('publish:start');
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        events.push('publish:end');
        return { hash: 'new' };
      },
      announce: async () => { events.push('announce'); return { seq: 2 }; },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); },
    }), { timeoutMs: 50 });
    await publicationStarted;
    fence.invalidate();
    release();
    expect(await operation.catch((error) => error.code)).toBe('dweb-generation-retired');
    expect(events).toEqual(['publish:start', 'publish:end', 'rollback-bytes']);
  });

  test('generation invalidation during announcement compensates before release', async () => {
    const fence = createDwebPublicationFence();
    let release!: () => void;
    let started!: () => void;
    const announcementStarted = new Promise<void>((resolve) => { started = resolve; });
    const events: string[] = [];
    const operation = fence.runReseed((current) => runDwebReseedPublication({
      current,
      publish: async () => { events.push('publish'); return { hash: 'new' }; },
      announce: async () => {
        events.push('announce:start');
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        events.push('announce:end');
        return { seq: 2 };
      },
      rollbackBytes: () => { events.push('rollback-bytes'); },
      compensate: () => { events.push('compensate'); },
      commit: () => { events.push('commit'); },
    }), { timeoutMs: 50 });
    await announcementStarted;
    fence.invalidate();
    release();
    expect(await operation.catch((error) => error.code)).toBe('dweb-generation-retired');
    expect(events).toEqual(['publish', 'announce:start', 'announce:end', 'compensate']);
  });
});
