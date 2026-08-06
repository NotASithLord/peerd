import { describe, expect, test } from 'bun:test';
import { createDwebPublicationFence } from '../../extension/background/dweb-publication-fence.js';

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
});
