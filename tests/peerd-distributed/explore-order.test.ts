import { expect, test } from 'bun:test';
import { exploreOrder } from '../../extension/home/explore-order.js';
const apps = Array.from({ length: 120 }, (_, i) => ({ dwapp_id: `app-${i}`, publisher: i < 100 ? 'prolific' : `publisher-${i}`, name: `App ${i}`, includes_wasm: i % 3 === 0 ? true : i % 3 === 1 ? false : null }));
test('Explore balances publisher rounds without duplicate apps or arrival-order ranking', () => {
  const ordered = exploreOrder(apps, { seed: 42 });
  expect(ordered).toHaveLength(120);
  expect(new Set(ordered.slice(0, 21).map(a => a.publisher)).size).toBe(21);
  expect(exploreOrder([...apps].reverse(), { seed: 42 })).toEqual(ordered);
  expect(exploreOrder([...apps, apps[0]!], { seed: 42 })).toEqual(ordered);
  expect(exploreOrder(apps, { seed: 871 })).not.toEqual(ordered);
});
test('Explore filters exact signed claims without guessing from names and searches full publisher identity', () => {
  for (const [wasm, value] of [['yes', true], ['no', false], ['unknown', null]] as const) {
    const selected = exploreOrder(apps, { wasm });
    expect(selected).toHaveLength(40); expect(selected.every(a => a.includes_wasm === value)).toBe(true);
  }
  expect(exploreOrder(apps, { query: 'publisher-110' }).map(a => a.dwapp_id)).toEqual(['app-110']);
  expect(exploreOrder([{dwapp_id:'legacy',name:'WebAssembly app'}], {wasm:'yes'})).toEqual([]);
  expect(exploreOrder([{dwapp_id:'legacy',description:'A physics simulator'}], {query:'PHYSICS'})).toHaveLength(1);
});
