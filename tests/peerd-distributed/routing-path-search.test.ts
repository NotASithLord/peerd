import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoutingPathSearch,MAX_ROUTING_PATH_QUERIES,MAX_ROUTING_PATH_NEIGHBORS} from '../../extension/peerd-distributed/transport/routing-path-search.js';

const graphFixture=async(edges:number[][],count=6)=>{
 const ids=await Promise.all(Array.from({length:count},()=>generateIdentity()));
 const graph=ids.map(()=>new Set<number>());
 for(const [a,b] of edges){graph[a].add(b);graph[b].add(a);}
 const queried:number[][]=[];
 const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async path=>{
  const nodes=path.map(did=>ids.findIndex(id=>id.did===did));queried.push(nodes);
  for(let i=1;i<nodes.length;i++)expect(graph[nodes[i-1]].has(nodes[i])).toBe(true);
  return [...graph[nodes.at(-1)!]].map(i=>ids[i].did);
 }});
 const find=(target:number,cuts:number[][])=>owner.find({target:ids[target].did,cuts:cuts.map(edge=>edge.map(i=>ids[i].did))});
 return {ids,owner,find,queried};
};
test('finds an alternate multi-hop path without querying across the removed edge',async()=>{
 const f=await graphFixture([[0,1],[1,2],[2,3],[3,4],[4,0]]);
 try{
  const path=await f.find(1,[[0,1]]);expect(path).toEqual([0,4,3,2,1].map(i=>f.ids[i].did));
  expect(f.queried.every(path=>!path.some((n,i)=>i>0&&path[i-1]===0&&n===1))).toBe(true);
 }finally{f.owner.close();}
});
test('rejects a bridge and the simultaneous two-edge cut of a ring',async()=>{
 const path=await graphFixture([[0,1],[1,2],[2,3]]);
 const ring=await graphFixture([[0,1],[1,2],[2,3],[3,0]]);
 try{expect(await path.find(1,[[0,1]])).toBeNull();expect(await ring.find(1,[[0,1],[2,3]])).toBeNull();}
 finally{path.owner.close();ring.owner.close();}
});
test('finds a component-local alternate path when two full components can join',async()=>{
 const f=await graphFixture([[0,1],[1,2],[2,0],[3,4],[4,5],[5,3]]);
 try{expect(await f.find(1,[[0,1],[3,4]])).toEqual([0,2,1].map(i=>f.ids[i].did));}
 finally{f.owner.close();}
});
test('cycles and repeated referrals cannot exceed the query budget',async()=>{
 const count=80,edges=Array.from({length:count-2},(_,i)=>[i,i+1]);
 // A shallow branching graph exercises the query budget rather than just the
 // hop limit. The disconnected target is a valid but unreachable identity.
 for(let i=1;i<30;i++)edges.push([0,i]);
 const f=await graphFixture(edges,count);
 try{expect(await f.find(79,[[0,79]])).toBeNull();expect(f.queried.length).toBe(MAX_ROUTING_PATH_QUERIES);}
 finally{f.owner.close();}
});
test('oversized or malformed referrals are refused without expanding the search',async()=>{
 const ids=await Promise.all(Array.from({length:3},()=>generateIdentity()));
 for(const response of [Array(MAX_ROUTING_PATH_NEIGHBORS+1).fill(ids[1].did),[ids[1].did,'not-a-did']]){
  let calls=0;const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async()=>{calls++;return response;}});
  try{expect(await owner.find({target:ids[2].did,cuts:[[ids[0].did,ids[2].did]]})).toBeNull();expect(calls).toBe(1);}
  finally{owner.close();}
 }
});
test('cancellation rejects promptly even when a query ignores its signal',async()=>{
 const ids=await Promise.all(Array.from({length:2},()=>generateIdentity()));let entered!:()=>void;
 const started=new Promise<void>(r=>entered=r);const ac=new AbortController();
 const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async()=>{entered();return new Promise(()=>{});}});
 try{const result=owner.find({target:ids[1].did,cuts:[[ids[0].did,ids[1].did]],signal:ac.signal});await started;ac.abort();await expect(result).rejects.toThrow();}
 finally{owner.close();}
});
test('deadlines do not depend on timer delivery',async()=>{
 const ids=await Promise.all(Array.from({length:3},()=>generateIdentity()));let time=1;
 const cuts=[[ids[0].did,ids[2].did]];
 const owner=createRoutingPathSearch({selfDid:ids[0].did,now:()=>time,timers:{setTimeout:()=>1,clearTimeout:()=>{}},
  readNeighbors:async()=>{cuts[0][1]=ids[1].did;time+=4_000;return [ids[2].did];}});
 try{await expect(owner.find({target:ids[2].did,cuts})).rejects.toThrow();}
 finally{owner.close();}
});

test('mutating caller cuts during a query cannot authorize the excluded direct edge',async()=>{
 const ids=await Promise.all(Array.from({length:3},()=>generateIdentity()));
 const cuts=[[ids[0].did,ids[2].did]];
 const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async()=>{cuts[0][1]=ids[1].did;return [ids[2].did];}});
 try{expect(await owner.find({target:ids[2].did,cuts})).toBeNull();}
 finally{owner.close();}
});

test('existing route discovery crosses a bridge without granting permission to replace it',async()=>{
 const f=await graphFixture([[0,1],[1,2],[2,3]]);
 try{
  expect(await f.owner.routeTo({target:f.ids[3].did})).toEqual([0,1,2,3].map(i=>f.ids[i].did));
  expect(await f.find(1,[[0,1]])).toBeNull();
  await expect(f.owner.find({target:f.ids[1].did,cuts:[]})).rejects.toThrow();
  await expect(f.owner.routeTo({target:f.ids[0].did})).rejects.toThrow();
  await expect(f.owner.routeTo({target:'invalid'})).rejects.toThrow();
 }finally{f.owner.close();}
});

test('route discovery and replacement searches share capacity and cancellation cleanup',async()=>{
 const ids=await Promise.all(Array.from({length:3},()=>generateIdentity()));let calls=0;
 const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async()=>{calls++;return new Promise(()=>{});}});
 const controller=new AbortController();
 try{
  const first=owner.routeTo({target:ids[1].did,signal:controller.signal});
  const second=owner.find({target:ids[2].did,cuts:[[ids[0].did,ids[2].did]],signal:controller.signal});
  const results=Promise.allSettled([first,second]);
  await expect(owner.routeTo({target:ids[2].did})).rejects.toThrow();expect(calls).toBe(2);
  controller.abort();expect((await results).every(result=>result.status==='rejected')).toBe(true);
  const third=owner.routeTo({target:ids[1].did});
  const stopped=Promise.allSettled([third]);expect(calls).toBe(3);owner.close();
  expect((await stopped)[0].status).toBe('rejected');
  await expect(owner.routeTo({target:ids[1].did})).rejects.toThrow();
 }finally{owner.close();}
});

test('existing route discovery bounds cyclic exploration when the target is absent',async()=>{
 const edges=Array.from({length:30},(_,i)=>[0,i+1]);
 const f=await graphFixture(edges,32);
 try{
  expect(await f.owner.routeTo({target:f.ids[31].did})).toBeNull();
  expect(f.queried).toHaveLength(MAX_ROUTING_PATH_QUERIES);
  expect(new Set(f.queried.map(path=>path.at(-1))).size).toBe(f.queried.length);
 }finally{f.owner.close();}
});

test('legacy fallback consumes the shared route search query budget',async()=>{
 const ids=await Promise.all(Array.from({length:20},()=>generateIdentity()));let requests=0;
 const owner=createRoutingPathSearch({selfDid:ids[0].did,readNeighbors:async()=>{throw new Error('wrong reader');},
  readRouteNeighbors:async(path,_signal,charge)=>{
   requests++;
   if(path.length>1){charge();requests++;}
   return ids.slice(1,19).map(id=>id.did);
  }});
 try{
  expect(await owner.routeTo({target:ids[19].did})).toBeNull();
  expect(requests).toBe(MAX_ROUTING_PATH_QUERIES);
 }finally{owner.close();}
});
