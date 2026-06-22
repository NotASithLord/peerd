import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  buildMeta, verifyMeta, metaWellFormed, dwappId, metaDwappId, MetaRejectedError, MAX_DESC,
} from '../../extension/peerd-distributed/apps/meta.js';

const head = (n = 1) => ({ version_id: `${'a'.repeat(63)}${n}`, content_addr: 'peerd://pub/hash', size: 1234 });

describe('dwapp meta — the signed app card', () => {
  test('builds, verifies, and derives a stable id from (publisher, slug)', async () => {
    const id = await generateIdentity();
    const card = await buildMeta({ slug: 'tictactoe', name: 'Tic Tac Toe', seq: 1, head: head() }, id);
    expect(await verifyMeta(card)).toBe(true);
    // the claimed id is verifiable from the card's own publisher + salt
    expect(await metaDwappId(card)).toBe(await dwappId(id.did, 'tictactoe'));
  });

  test('the id is stable across versions but distinct per publisher', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const v1 = await buildMeta({ slug: 'chess', name: 'Chess', seq: 1, head: head(1) }, a);
    const v2 = await buildMeta({ slug: 'chess', name: 'Chess', seq: 2, head: head(2) }, a);
    expect(await metaDwappId(v1)).toBe(await metaDwappId(v2));         // same app across versions
    const bChess = await buildMeta({ slug: 'chess', name: 'Chess', seq: 1, head: head() }, b);
    expect(await metaDwappId(bChess)).not.toBe(await metaDwappId(v1)); // different author, different app
  });

  test('a forged card (tampered value) fails verification', async () => {
    const id = await generateIdentity();
    const card = await buildMeta({ slug: 'x', name: 'X', seq: 1, head: head() }, id);
    const forged = { ...card, value: { ...card.value, name: 'Evil' } };
    expect(await verifyMeta(forged)).toBe(false);
  });

  test('caps are enforced at build', async () => {
    const id = await generateIdentity();
    await expect(buildMeta({ slug: 'x', name: 'a'.repeat(65), seq: 1, head: head() }, id)).rejects.toBeInstanceOf(MetaRejectedError);
    await expect(buildMeta({ slug: 'a'.repeat(65), name: 'x', seq: 1, head: head() }, id)).rejects.toBeInstanceOf(MetaRejectedError);
    await expect(buildMeta({ slug: 'x', name: 'x', seq: 1, head: { version_id: 'h', content_addr: 'http://nope', size: 1 } }, id)).rejects.toBeInstanceOf(MetaRejectedError);
    await expect(buildMeta({ slug: 'x', name: 'x', seq: 1, head: head(), icon: 'data:inline' }, id)).rejects.toBeInstanceOf(MetaRejectedError);
  });

  test('an oversized description is rejected by metaWellFormed', async () => {
    const id = await generateIdentity();
    await expect(buildMeta({ slug: 'x', name: 'x', description: 'd'.repeat(MAX_DESC + 1), seq: 1, head: head() }, id)).rejects.toBeInstanceOf(MetaRejectedError);
  });

  test('metaWellFormed is a cheap pre-filter that catches shape breakage', async () => {
    const id = await generateIdentity();
    const card = await buildMeta({ slug: 'x', name: 'X', seq: 1, head: head() }, id);
    expect(metaWellFormed(card)).toBe(true);
    expect(metaWellFormed({ ...card, seq: -1 })).toBe(false);
    expect(metaWellFormed({ ...card, value: { ...card.value, head: { version_id: 'h' } } })).toBe(false);
  });
});
