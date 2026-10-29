import {test,expect} from 'bun:test';
import {findOfflineRepairRoute,REPAIR_BROKERS,REPAIR_QUERY_CONCURRENCY} from '../../extension/peerd-distributed/transport/offline-repair-route.js';
test('repair finds an authenticated common broker and prioritizes the newest lost peer',async()=>{
 const rosters:Record<string,string[]>={a:['old'],b:['unrelated'],c:['new']};
 const route=await findOfflineRepairRoute({peers:['a','b','c'],targets:['new','old'],round:0,signal:new AbortController().signal,readRoster:async peer=>rosters[peer]});
 expect(route).toEqual({via:'c',target:'new'});
});
test('repair bounds probes and concurrent requests and retires every query owner',async()=>{
 let active=0,peak=0,calls=0;const owners:AbortSignal[]=[];
 const result=await findOfflineRepairRoute({peers:Array.from({length:100},(_,i)=>String(i)),targets:['missing'],round:2,signal:new AbortController().signal,
 readRoster:async(_peer,signal)=>{calls++;owners.push(signal);active++;peak=Math.max(peak,active);await Promise.resolve();active--;return [];}});
 expect(result).toBeNull();expect(calls).toBe(REPAIR_BROKERS);expect(peak).toBeLessThanOrEqual(REPAIR_QUERY_CONCURRENCY);expect(owners.every(s=>s.aborted)).toBe(true);
});
test('retirement stops silent queries even when the injected reader ignores cancellation',async()=>{
 const owner=new AbortController();const signals:AbortSignal[]=[];
 const task=findOfflineRepairRoute({peers:['a','b','c','d'],targets:['lost'],round:0,signal:owner.signal,
 readRoster:async(_peer,signal)=>{signals.push(signal);return new Promise(()=>{});}});
 owner.abort();await expect(task).rejects.toThrow();expect(signals).toHaveLength(REPAIR_QUERY_CONCURRENCY);expect(signals.every(s=>s.aborted)).toBe(true);
});

test('silent brokers consume only the bounded probe budget and cannot retain query timers',async()=>{
 let created=0,cleared=0;const owners:AbortSignal[]=[];
 const timers={setTimeout:(fn:()=>void)=>{created++;queueMicrotask(fn);return created;},clearTimeout:()=>{cleared++;}};
 const result=await findOfflineRepairRoute({peers:Array.from({length:100},(_,i)=>String(i)),targets:['lost'],round:0,signal:new AbortController().signal,timers,
 readRoster:async(_peer,signal)=>{owners.push(signal);return new Promise(()=>{});}});
 expect(result).toBeNull();expect(owners).toHaveLength(REPAIR_BROKERS);expect(owners.every(s=>s.aborted)).toBe(true);expect(cleared).toBe(created);
});
