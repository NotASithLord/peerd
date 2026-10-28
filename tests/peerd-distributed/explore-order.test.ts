import { expect, test } from 'bun:test';
import { EXPLORE_WINDOW, exploreOrder, matchesWords, nextSuggestion, searchWords, suggestionKey, SURPRISE_HISTORY_LIMIT } from '../../extension/home/explore-order.js';
import { encodeDidKey } from '../../extension/shared/address/did.js';
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
test('Explore finds an app by any word of a task, as the search label asks for', () => {
  const cards = [
    { dwapp_id: 'split', name: 'Expense splitter', description: 'Split shared costs and settle up with friends.' },
    { dwapp_id: 'trip', name: 'Trip planner', description: 'Plan routes, stops and packing lists.' },
    { dwapp_id: 'chess', name: 'Chess clock', description: 'A two-player clock.' },
  ];
  const found = (query: string) => exploreOrder(cards, { query }).map(a => a.dwapp_id).sort();
  expect(found('split a bill')).toEqual(['split']);
  expect(found('Plan a TRIP')).toEqual(['trip']);
  expect(found('chess or a trip')).toEqual(['chess', 'trip']);
  // Only short words: the query matches as typed.
  expect(found('a t')).toEqual(['chess']);
  expect(found('a b')).toEqual([]);
  expect(found('  ')).toEqual(['chess', 'split', 'trip']);
});
test('search words: words of 3 or more letters, else the whole query, lower case', () => {
  expect(searchWords('  Split a BILL ')).toEqual(['split', 'bill']);
  expect(searchWords('to do')).toEqual(['to do']);
  expect(searchWords('')).toEqual([]);
  // The small words of a sentence match almost any app, so they never count.
  expect(searchWords('split the bill')).toEqual(['split', 'bill']);
  expect(searchWords('what did ana share')).toEqual(['ana', 'share']);
  expect(searchWords('the app')).toEqual(['the app']);
  expect(matchesWords('Expense splitter', ['bill', 'split'])).toBe(true);
  expect(matchesWords('Expense splitter', ['bill'])).toBe(false);
  expect(matchesWords('anything', [])).toBe(true);
});
test('a sentence finds the apps it is about: filler words and the did:key text of every maker match nothing', () => {
  const maker = (n: number) => encodeDidKey(new Uint8Array(32).fill(n));
  const cards = [
    { dwapp_id: 'split', publisher: maker(1), name: 'Expense splitter', description: 'Split a bill with friends.' },
    { dwapp_id: 'chess', publisher: maker(2), name: 'Chess clock', description: 'A clock for over-the-board games. Pause them both.' },
    { dwapp_id: 'reading', publisher: maker(3), name: 'Reading list', description: 'Books you want to read next.' },
    { dwapp_id: 'notes', publisher: maker(2), name: 'Field notes', description: 'Notes and sketches from a walk.' },
  ];
  const names = new Map([[maker(1), 'Ana']]);
  const found = (query: string) => exploreOrder(cards, { query, names }).map(a => a.dwapp_id);
  expect(found('split the bill')).toEqual(['split']);
  expect(found('what did ana share')).toEqual(['split']);
  expect(found('house key tracker')).toEqual([]);
  expect(found('my key notes')).toEqual(['notes']);
  // The maker still matches by the short key a tile shows, or by the whole did.
  expect(found(maker(3).slice(-8))).toEqual(['reading']);
  expect(found(maker(2)).sort()).toEqual(['chess', 'notes']);
});

test('an app that matches more words of the query comes first; ties keep the seeded order', () => {
  const cards = [
    { dwapp_id: 'a', publisher: 'one', name: 'Trip notes' },
    { dwapp_id: 'b', publisher: 'two', name: 'Trip planner', description: 'Plan a trip with friends.' },
    { dwapp_id: 'c', publisher: 'three', name: 'Packing list', description: 'Pack for a trip.' },
  ];
  const seeded = exploreOrder(cards, { seed: 42 }).map(a => a.dwapp_id);
  const ranked = exploreOrder(cards, { query: 'plan a trip', seed: 42 }).map(a => a.dwapp_id);
  expect(ranked[0]).toBe('b');
  expect(ranked.slice(1)).toEqual(seeded.filter(id => id !== 'b'));
});

test('with a query, a maker whose many cards match more words still gets one place per round', () => {
  const packed = Array.from({ length: 120 }, (_, i) => ({ dwapp_id: `packed-${i}`, publisher: 'packer', name: `Tool ${i}`, description: 'split bill plan trip budget' }));
  const honest = Array.from({ length: 30 }, (_, i) => ({ dwapp_id: `honest-${i}`, publisher: `maker-${i}`, name: i % 2 ? 'Expense splitter' : 'Bill tracker' }));
  const ordered = exploreOrder([...packed, ...honest], { query: 'split a bill', seed: 42 });
  expect(ordered).toHaveLength(150);
  // The first round holds one app from each of the 31 makers, the best match first.
  expect(new Set(ordered.slice(0, 31).map(app => app.publisher)).size).toBe(31);
  expect(ordered[0]?.publisher).toBe('packer');
  expect(ordered.slice(0, EXPLORE_WINDOW).filter(app => app.publisher !== 'packer')).toHaveLength(30);
  // One maker's own list puts its best matches first.
  const own = [
    { dwapp_id: 'weak', publisher: 'ana', name: 'Bill tracker' },
    { dwapp_id: 'strong', publisher: 'ana', name: 'Split the bill' },
    { dwapp_id: 'other', publisher: 'bob', name: 'Expense splitter' },
  ];
  for (const seed of [1, 2, 3, 42]) {
    const ids = exploreOrder(own, { query: 'split a bill', seed }).map(app => app.dwapp_id);
    expect(ids.indexOf('strong')).toBeLessThan(ids.indexOf('weak'));
    expect(ids.at(-1)).toBe('weak');
  }
});

test('Explore searches the saved contact name a tile shows, keyed by the full did', () => {
  const cards = [{ dwapp_id: 'x', publisher: 'did:key:zMaker', name: 'Expense splitter' }, { dwapp_id: 'y', publisher: 'did:key:zOther', name: 'Trip planner' }];
  const names = new Map([['did:key:zMaker', 'Ana Lima']]);
  expect(exploreOrder(cards, { query: 'ana lima', names }).map(a => a.dwapp_id)).toEqual(['x']);
  expect(exploreOrder(cards, { query: 'ana lima' })).toEqual([]);
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


test('Surprise me skips only fresh retrieval misses and restores eligibility after expiry', () => {
  const a = {dwapp_id:'a', publisher:'one', retrieval:{outcome:'no-provider-found',observedAt:100,expiresAt:200}};
  const b = {dwapp_id:'b', publisher:'two'};
  expect(nextSuggestion([a,b],new Set(),null,150)).toEqual(b);
  expect(nextSuggestion([a],new Set(),null,150)).toBeNull();
  expect(nextSuggestion([a],new Set(),null,200)).toEqual(a);
  expect(nextSuggestion([a],new Set(),null,99)).toEqual(a);
  expect(nextSuggestion([{...a,retrieval:{...a.retrieval,outcome:'lookup-error'}}],new Set(),null,150)?.dwapp_id).toBe('a');
});
