import { expect, test } from 'bun:test';
import { exploreOrder, nextSuggestion, suggestionKey, SURPRISE_HISTORY_LIMIT } from '../../extension/home/explore-order.js';
const apps = Array.from({ length: 120 }, (_, i) => ({ dwapp_id: `app-${i}`, publisher: i < 100 ? 'prolific' : `publisher-${i}`, name: `App ${i}` }));
test('Explore balances publisher rounds without duplicate apps or arrival-order ranking', () => {
  const ordered = exploreOrder(apps, { seed: 42 });
  expect(ordered).toHaveLength(120);
  expect(new Set(ordered.slice(0, 21).map(a => a.publisher)).size).toBe(21);
  expect(exploreOrder([...apps].reverse(), { seed: 42 })).toEqual(ordered);
  expect(exploreOrder([...apps, apps[0]!], { seed: 42 })).toEqual(ordered);
  expect(exploreOrder(apps, { seed: 871 })).not.toEqual(ordered);
});
test('Explore searches the full publisher identity and the description', () => {
  expect(exploreOrder(apps, { query: 'publisher-110' }).map(a => a.dwapp_id)).toEqual(['app-110']);
  expect(exploreOrder([{dwapp_id:'legacy',description:'A physics simulator'}], {query:'PHYSICS'})).toHaveLength(1);
});


test('Surprise me rotates publishers and immutable versions without implying availability', () => {
  const a = {dwapp_id:'a',publisher:'one',version_id:'v1'};
  const b = {dwapp_id:'b',publisher:'one',version_id:'v1'};
  const c = {dwapp_id:'c',publisher:'two',version_id:'v1'};
  const unsupported = {dwapp_id:'bad',runtimeCompatibility:{status:'unsupported'}};
  const seen = new Set<string>();
  expect(nextSuggestion([unsupported,a,b,c],seen,null)).toEqual(a);
  seen.add(suggestionKey(a));
  expect(nextSuggestion([a,b,c],seen,'one')).toEqual(c);
  seen.add(suggestionKey(c));
  expect(nextSuggestion([a,b,c],seen,'two')).toEqual(b);
  seen.add(suggestionKey(b));
  expect(nextSuggestion([unsupported,a,b,c],seen,'one')).toBeNull();
  expect(nextSuggestion([{...a,version_id:'v2'}],seen,'one')?.version_id).toBe('v2');
  expect(nextSuggestion([a],new Set(Array.from({length:SURPRISE_HISTORY_LIMIT},(_,i)=>String(i))),null)).toBeNull();
  seen.clear();
  expect(nextSuggestion([a],seen,null)).toEqual(a);
});
