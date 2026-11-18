import { expect, test } from 'bun:test';
import {
  GAME_NET_LIMITS, gameNetProtocol, gamePayload, gamePlayer, gameRateLimit, gameRecipients, gameWorld,
} from '../../../extension/shared/game-net.js';

test('accepts only the supported descriptor and integer protocol range', () => {
  for (const protocol of [0, 2, 65535]) expect(gameNetProtocol({ v: 1, protocol })).toBe(protocol);
  for (const config of [null, [], {}, { v: 2, protocol: 1 }, { v: 1, protocol: 1, room: 'other' },
    ...[-1, 65536, 1.5, '1', NaN].map(protocol => ({ v: 1, protocol }))]) {
    expect(gameNetProtocol(config)).toBeNull();
  }
});

test('binds the world to the publisher, game ID and protocol across releases', async () => {
  const tree = { publisher: 'publisher-a', hash: 'a'.repeat(64) };
  const release = { ...tree, dwapp_id: 'b'.repeat(64) };
  const world = await gameWorld(release, tree, 1);
  expect(world?.roomId).toMatch(/^game\.[a-f0-9]{40}$/);
  const nextTree = { ...tree, hash: 'c'.repeat(64) };
  expect(await gameWorld({ ...release, ...nextTree }, nextTree, 1)).toEqual(world);
  expect(await gameWorld(release, tree, 2)).not.toEqual(world);
  expect(await gameWorld({ ...release, dwapp_id: 'd'.repeat(64) }, tree, 1)).not.toEqual(world);
  const nextPublisher = { ...tree, publisher: 'publisher-b' };
  expect(await gameWorld({ ...release, ...nextPublisher }, nextPublisher, 1)).not.toEqual(world);
  for (const claim of [undefined, tree, { ...release, publisher: 'other' }, { ...release, hash: 'wrong' },
    { ...release, dwapp_id: 'wrong' }]) expect(await gameWorld(claim, tree, 1)).toBeNull();
});

test('derives stable player IDs for one world', async () => {
  const player = await gamePlayer('world-a', 'did:key:a');
  expect(player).toMatch(/^[\w-]{22}$/);
  expect(await gamePlayer('world-a', 'did:key:a')).toBe(player);
  expect(await gamePlayer('world-a', 'did:key:b')).not.toBe(player);
  expect(await gamePlayer('world-b', 'did:key:a')).not.toBe(player);
});

test('limits payloads to JSON and 1024 UTF-8 bytes', () => {
  expect(gamePayload(JSON.stringify('é'.repeat(511)))).toBe(true);
  expect(gamePayload(JSON.stringify('é'.repeat(512)))).toBe(false);
  expect(gamePayload(JSON.stringify('x'.repeat(1022)))).toBe(true);
  expect(gamePayload(JSON.stringify('x'.repeat(1023)))).toBe(false);
  for (const value of [undefined, {}, '', '{', 'Infinity']) expect(gamePayload(value)).toBe(false);
});

test('limits direct recipients to 16 player IDs', () => {
  const id = 'a'.repeat(22);
  expect(gameRecipients(Array(16).fill(id))).toBe(true);
  expect(gameRecipients(Array(17).fill(id))).toBe(false);
  for (const ids of [null, id, [1], ['did:key:x'], ['a'.repeat(21)]]) expect(gameRecipients(ids)).toBe(false);
});

test('enforces separate publish and direct rate and burst limits', () => {
  const { publishRate, publishBurst, sendRate, sendBurst } = GAME_NET_LIMITS;
  for (const [rate, burst] of [[publishRate, publishBurst], [sendRate, sendBurst]]) {
    const take = gameRateLimit(rate, burst);
    for (let i = 0; i < burst; i += 1) expect(take(0)).toBe(true);
    expect(take(0)).toBe(false);
    expect(take(1000 / rate - 1)).toBe(false);
    expect(take(1000)).toBe(true);
    for (let i = 1; i < rate; i += 1) expect(take(1000)).toBe(true);
    expect(take(1000)).toBe(false);
  }
});
