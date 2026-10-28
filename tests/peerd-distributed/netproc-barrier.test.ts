import {test,expect} from 'bun:test';
import {createBarrier} from './netproc/barrier.ts';
test('every unique participant must reach ordered stages',()=>{
 const b=createBarrier(3);
 for(const id of ['a','b','c']) expect(b.join(id)).toBe(true);
 expect(b.join('a')).toBe(false);expect(b.join('d')).toBe(false);
 expect(b.arrive('unknown','ready')).toBe(false);
 expect(b.arrive('a','complete')).toBe(false);
 for(const stage of ['ready','published','complete']) {
  expect(b.arrive('a',stage)).toBe(false);
  expect(b.arrive('a',stage)).toBe(false);
  expect(b.arrive('b',stage)).toBe(false);
  expect(b.arrive('c',stage)).toBe(true);
 }
});
test('missing participant fails closed and cannot be replaced',()=>{
 const b=createBarrier(2);b.join('a');b.join('b');b.leave('b');
 expect(b.join('c')).toBe(false);expect(b.arrive('a','ready')).toBe(false);
 expect(b.arrive('b','ready')).toBe(false);
});
test('participants cannot move beyond an unreleased stage',()=>{
 const b=createBarrier(2);b.join('a');b.join('b');b.arrive('a','ready');
 expect(b.arrive('a','published')).toBe(false);
 expect(b.arrive('b','ready')).toBe(true);
 expect(b.arrive('a','published')).toBe(false);
 expect(b.arrive('b','published')).toBe(true);
 for(const n of [0,1,66,NaN,2.5]) expect(()=>createBarrier(n)).toThrow();
});
