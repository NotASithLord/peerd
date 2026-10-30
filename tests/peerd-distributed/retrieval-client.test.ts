import {test,expect} from 'bun:test';
import {createRetrievalClient} from '../../extension/peerd-distributed/transport/retrieval-client.js';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const clock=()=>{
 let time=0,id=0;const jobs=new Map<number,{at:number,fn:()=>void}>();
 return {now:()=>time,timers:{setTimeout:(fn:()=>void,delay:number)=>{jobs.set(++id,{at:time+delay,fn});return id;},clearTimeout:(key:number)=>jobs.delete(key)},
  advance:(ms:number)=>{time+=ms;for(const [key,job] of [...jobs])if(job.at<=time){jobs.delete(key);job.fn();}},pending:()=>jobs.size};
};
const request={kind:'chunk' as const,hash:'a'.repeat(64)};
test('client bounds active work, queued requests and starts; close aborts every owned operation',async()=>{
 const time=clock(),signals:AbortSignal[]=[],starts:number[]=[];
 const client=createRetrievalClient({...time,routeTo:async({target})=>['self',target],rpc:{retrieve:async(_path,_request,signal)=>{
  signals.push(signal);starts.push(time.now());return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
 }}});
 const signal=new AbortController().signal;
 try{
  const jobs=Array.from({length:17},()=>client.read('target',request,signal).catch(e=>e));await flush();
  expect(client.stats()).toMatchObject({active:1,queued:16});
  await expect(client.read('target',request,signal)).rejects.toThrow();
  time.advance(499);await flush();expect(signals).toHaveLength(1);
  time.advance(1);await flush();expect(client.stats()).toMatchObject({active:2,queued:15});expect(starts).toEqual([0,500]);
  time.advance(5000);await flush();expect(signals).toHaveLength(2);
  client.close();expect((await Promise.all(jobs)).every(e=>e instanceof Error)).toBe(true);
  expect(signals.every(s=>s.aborted)).toBe(true);expect(time.pending()).toBe(0);expect(client.stats()).toEqual({active:0,queued:0,paths:0});
 }finally{client.close();}
});
test('queued cancellation releases capacity without starting discovery',async()=>{
 const time=clock();let routes=0;
 const client=createRetrievalClient({...time,routeTo:async()=>{routes++;return ['self','target'];},rpc:{retrieve:async()=>new Uint8Array([1])}});
 try{
  await client.read('target',request,new AbortController().signal);
  const ac=new AbortController(),pending=client.read('other',request,ac.signal).catch(e=>e);ac.abort();
  expect(await pending).toBeInstanceOf(Error);time.advance(500);await flush();expect(routes).toBe(1);expect(time.pending()).toBe(0);
 }finally{client.close();}
});
test('cached paths expire and failed requests invalidate their hints',async()=>{
 const time=clock();let routes=0,fail=false;
 const client=createRetrievalClient({...time,routeTo:async()=>{routes++;return ['self','target'];},rpc:{retrieve:async()=>{if(fail)throw new Error('link retired');return new Uint8Array([1]);}}});
 const signal=new AbortController().signal;
 try{
  await client.read('target',request,signal);time.advance(500);await client.read('target',request,signal);expect(routes).toBe(1);
  time.advance(30000);await client.read('target',request,signal);expect(routes).toBe(2);
  time.advance(500);fail=true;await expect(client.read('target',request,signal)).rejects.toThrow();expect(client.stats().paths).toBe(0);
  time.advance(500);fail=false;await client.read('target',request,signal);expect(routes).toBe(3);
 }finally{client.close();}
});
