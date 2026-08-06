import { describe, expect, test } from 'bun:test';
import { rollbackSharePublication } from '../../extension/offscreen/share-publication.js';

const previous = {
  name: 'App', description: '', seq: 4,
  head: { version_id: 'old', content_addr: 'peerd://old', size: 12 },
};

describe('share publication rollback', () => {
  test('same-hash rollback restores the prior card without releasing its bytes', async () => {
    const published: any[] = [];
    const released: any[] = [];
    const result = await rollbackSharePublication({
      base: {
        did: 'did:key:zLocal',
        publishMeta: async (value: any) => { published.push(value); },
        unpublishMeta: async () => { throw new Error('must not tombstone'); },
      },
      state: {
        slug: 'app', ownerId: 'app:a:share', newHash: 'old',
        ownershipAdded: true, previous,
      },
      failedSeq: 5,
      release: (...args: any[]) => { released.push(args); },
    });
    expect(result).toEqual({ restored: true });
    expect(published[0]).toMatchObject({ slug: 'app', head: previous.head });
    expect(released).toEqual([]);
  });

  test('first-share rollback tombstones only its card and releases its ownership', async () => {
    const unpublished: any[] = [];
    const released: any[] = [];
    const result = await rollbackSharePublication({
      base: {
        did: 'did:key:zLocal',
        publishMeta: async () => { throw new Error('nothing to restore'); },
        unpublishMeta: async (value: any) => { unpublished.push(value); },
      },
      state: {
        slug: 'app', ownerId: 'app:a:share', newHash: 'new',
        ownershipAdded: true, previous: null,
      },
      release: (...args: any[]) => { released.push(args); },
    });
    expect(result).toEqual({ restored: false });
    expect(unpublished).toEqual([{ slug: 'app', publisher: 'did:key:zLocal' }]);
    expect(released).toEqual([['app:a:share', 'new']]);
  });

  test('metadata restoration can be retried before new bytes are released', async () => {
    let restores = 0;
    let releases = 0;
    const options = {
      base: {
        did: 'did:key:zLocal',
        publishMeta: async () => { if (++restores === 1) throw new Error('restore failed'); },
        unpublishMeta: async () => {},
      },
      state: {
        slug: 'app', ownerId: 'app:a:share', newHash: 'new',
        ownershipAdded: true, previous,
      },
      release: () => { releases += 1; },
    };
    await expect(rollbackSharePublication(options)).rejects.toThrow('restore failed');
    expect(releases).toBe(0);
    expect(await rollbackSharePublication(options)).toEqual({ restored: true });
    expect(releases).toBe(1);
  });

  test('first-share unpublish and final release failures remain retryable', async () => {
    let unpublishes = 0;
    let releases = 0;
    const state = {
      slug: 'app', ownerId: 'app:a:share', newHash: 'new',
      ownershipAdded: true, previous: null,
    };
    const base = {
      did: 'did:key:zLocal',
      publishMeta: async () => {},
      unpublishMeta: async () => { if (++unpublishes === 1) throw new Error('unpublish failed'); },
    };
    await expect(rollbackSharePublication({ base, state, release: () => { releases += 1; } }))
      .rejects.toThrow('unpublish failed');
    expect(releases).toBe(0);

    const release = () => { if (++releases === 1) throw new Error('release failed'); };
    await expect(rollbackSharePublication({ base, state, release })).rejects.toThrow('release failed');
    expect(await rollbackSharePublication({ base, state, release })).toEqual({ restored: false });
    expect(releases).toBe(2);
  });
});
