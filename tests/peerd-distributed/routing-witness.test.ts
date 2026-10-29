import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoutingPathHolds} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {createRoutingPathSearch} from '../../extension/peerd-distributed/transport/routing-path-search.js';
import {createRoutingWitnesses} from '../../extension/peerd-distributed/transport/routing-witness.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';

type Hop=Awaited<ReturnType<ReturnType<typeof createRoutingPathHolds>['acquire']>>;
const fixture=async(hook?:(index:number,acquire:()=>Promise<Hop>)=>Promise<Hop>)=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));let time=100_000;
 const meshes=ids.slice(0,3).map(identity=>createRoomMesh({identity,roomId:'witness',budget:2,sparse:true,now:()=>time}));
 const carriers=meshes.map(()=>new Map<number,AbortSignal>());
 for(const [a,b] of [[0,1],[1,2],[2,0]]){
  const pair=memoryPair();
  for(const [index,node,peer] of [[0,a,b],[1,b,a]]){
   const ac=new AbortController();pair[index].onClose(()=>ac.abort());carriers[node].set(peer,ac.signal);
   meshes[node].addLink(pair[index],ids[peer].did,{}, {locallySelected:true});
  }
 }
 time+=NEIGHBOR_GRACE_MS;
 const gates=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'witness',holdRoutingLink:mesh.holdRoutingLink,now:()=>time}));
 const acquired:Hop[]=[];
 const owner=createRoutingWitnesses({identity:ids[0],roomId:'witness',now:()=>time,
  acquireHop:async(request,index,signal)=>{
   const acquire=async()=>{
    const hop=await gates[index].acquire(request,index?{did:ids[index-1].did,signal:carriers[index].get(index-1)!}:null,{signal});
    acquired.push(hop);return hop;
   };
   return hook?hook(index,acquire):acquire();
  }});
 const plan={candidate:[ids[0].did,ids[3].did],cuts:[[ids[0].did,ids[2].did]],path:ids.slice(0,3).map(id=>id.did)};
 return {ids,meshes,owner,plan,acquired,advance:(ms:number)=>time+=ms,
  close:()=>{owner.close();gates.forEach(g=>g.close());meshes.forEach(m=>m.close());}};
};
test('coordinator owns every signed hop and releases the complete witness',async()=>{
 const f=await fixture();try{
  const witness=await f.owner.acquire(f.plan);
  expect(witness.digest).toMatch(/^[0-9a-f]{64}$/);expect(witness.receipts).toHaveLength(3);
  expect(witness.validUntil).toBe(100_000+NEIGHBOR_GRACE_MS+10_000);
  expect(f.acquired.every(h=>!h.signal.aborted)).toBe(true);
  witness.release();expect(witness.signal.aborted).toBe(true);expect(f.acquired.every(h=>h.signal.aborted)).toBe(true);
 }finally{f.close();}
});
test('partial acquisition failure retires earlier hops without evicting peers',async()=>{
 const f=await fixture(async(index,acquire)=>{if(index===1)throw new Error('unreachable');return acquire();});
 try{
  await expect(f.owner.acquire(f.plan)).rejects.toThrow();expect(f.acquired).toHaveLength(1);
  expect(f.acquired[0].signal.aborted).toBe(true);expect(f.meshes.every(m=>m.stats().peerDegree===2)).toBe(true);
 }finally{f.close();}
});
test('a late transport result after cancellation is retired instead of leaking',async()=>{
 let resume!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const f=await fixture(async(index,acquire)=>{const hop=await acquire();if(index===1){entered();await gate;}return hop;});
 const ac=new AbortController();try{
  const result=f.owner.acquire({...f.plan,signal:ac.signal});await started;ac.abort();
  await expect(result).rejects.toThrow();resume();await new Promise(r=>setTimeout(r,0));
  expect(f.acquired.every(h=>h.signal.aborted)).toBe(true);
 }finally{resume();f.close();}
});
test('carrier loss retires an already collected witness',async()=>{
 const f=await fixture();try{
  const witness=await f.owner.acquire(f.plan);f.meshes[1].removeLink(f.ids[2].did);
  expect(witness.signal.aborted).toBe(true);expect(f.acquired.every(h=>h.signal.aborted)).toBe(true);
 }finally{f.close();}
});
test('delayed timer callbacks cannot allow a witness to complete past its deadline',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;
 f=await fixture(async(index,acquire)=>{const hop=await acquire();if(index===2)f.advance(10_000);return hop;});
 try{
  await expect(f.owner.acquire(f.plan)).rejects.toThrow();expect(f.acquired.every(h=>h.signal.aborted)).toBe(true);
 }finally{f.close();}
});
test('invalid path plan is rejected before transport work',async()=>{
 const f=await fixture();try{
  await expect(f.owner.acquire({...f.plan,path:[...f.plan.path,f.plan.path[0]]})).rejects.toThrow();
  expect(f.acquired).toHaveLength(0);
 }finally{f.close();}
});

test('a transport ignoring cancellation cannot hand a fresh leaked lease to a retired owner',async()=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));
 let resume!:()=>void,entered!:()=>void,released=0;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const owner=createRoutingWitnesses({identity:ids[0],roomId:'late',now:()=>100_000,acquireHop:async()=>{
  entered();await gate;return {receipt:{},signal:new AbortController().signal,release:()=>{released++;}};
 }});
 const ac=new AbortController();
 try{
  const result=owner.acquire({candidate:[ids[0].did,ids[3].did],cuts:[[ids[0].did,ids[2].did]],path:ids.slice(0,3).map(i=>i.did),signal:ac.signal});
  await started;ac.abort();await expect(result).rejects.toThrow();resume();await new Promise(r=>setTimeout(r,0));
  expect(released).toBe(1);
 }finally{resume();owner.close();}
});

test('per-room coordinator bounds active operations and closes pending work',async()=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));let entered!:()=>void,count=0;
 const started=new Promise<void>(r=>entered=r);
 const owner=createRoutingWitnesses({identity:ids[0],roomId:'bounded',now:()=>100_000,
  acquireHop:async(_request,_index,signal)=>new Promise((_resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(new Error('retired')),{once:true});if(++count===2)entered();
  })});
 const plan={candidate:[ids[0].did,ids[3].did],cuts:[[ids[0].did,ids[2].did]],path:ids.slice(0,3).map(i=>i.did)};
 try{
  const results=Promise.allSettled([owner.acquire(plan),owner.acquire(plan)]);await started;
  await expect(owner.acquire(plan)).rejects.toThrow();owner.close();
  expect((await results).every(r=>r.status==='rejected')).toBe(true);expect(count).toBe(2);
 }finally{owner.close();}
});

test('search and signed hold acquisition join full components using the actual reserved victims',async()=>{
 const ids=await Promise.all(Array.from({length:6},()=>generateIdentity()));let time=100_000;
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'composed',budget:2,sparse:true,now:()=>time}));
 const carriers=meshes.map(()=>new Map<string,AbortSignal>());
 const gates=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'composed',holdRoutingLink:mesh.holdRoutingLink,now:()=>time}));
 const ownerIds=[0,3];
 const searches=ownerIds.map(i=>createRoutingPathSearch({selfDid:ids[i].did,now:()=>time,readNeighbors:async path=>{
  const node=ids.findIndex(id=>id.did===path.at(-1));return meshes[node].peers().map(peer=>peer.did);
 }}));
 const owners=ownerIds.map(i=>createRoutingWitnesses({identity:ids[i],roomId:'composed',now:()=>time,acquireHop:async(request,index,signal)=>{
  const path=request.body.path as string[],node=ids.findIndex(id=>id.did===path[index]);
  return gates[node].acquire(request,index?{did:path[index-1],signal:carriers[node].get(path[index-1])!}:null,{signal});
 }}));
 const tickets:Array<ReturnType<typeof meshes[0]['reserveAdmission']>>=[];
 const witnesses:Array<Awaited<ReturnType<typeof owners[0]['acquire']>>>=[];
 try{
  for(const [a,b] of [[0,1],[1,2],[2,0],[3,4],[4,5],[5,3]]){
   const pair=memoryPair();for(const [index,node,peer] of [[0,a,b],[1,b,a]]){
    const ac=new AbortController();pair[index].onClose(()=>ac.abort());carriers[node].set(ids[peer].did,ac.signal);
    expect(meshes[node].addLink(pair[index],ids[peer].did,{}, {locallySelected:true})).toBe(true);
   }time++;
  }
  time+=NEIGHBOR_GRACE_MS;
  for(const [i,node] of ownerIds.entries())tickets.push(meshes[node].reserveAdmission(ids[ownerIds[1-i]].did,{locallySelected:true}));
  const cuts=tickets.map((ticket,i)=>[ids[ownerIds[i]].did,ticket.victim!]);
  for(const [i,ticket] of tickets.entries()){
   const path=await searches[i].find({target:ticket.victim!,cuts,signal:ticket.signal});expect(path).not.toBeNull();
   witnesses.push(await owners[i].acquire({candidate:ownerIds.map(i=>ids[i].did),cuts,path:[...path!],signal:ticket.signal}));
  }
  const pair=memoryPair();
  for(const [i,node] of ownerIds.entries()){
   expect(witnesses[i].signal.aborted).toBe(false);expect(time).toBeLessThan(witnesses[i].validUntil);
   expect(meshes[node].addLink(pair[i],ids[ownerIds[1-i]].did,{}, {locallySelected:true,reservation:tickets[i]})).toBe(true);
  }
  const seen=new Set([ids[0].did]),pending=[0];
  for(const node of pending)for(const peer of meshes[node].peers())if(!seen.has(peer.did)){
   seen.add(peer.did);pending.push(ids.findIndex(id=>id.did===peer.did));
  }
  expect(seen.size).toBe(6);expect(meshes.every(mesh=>mesh.stats().peerDegree<=2)).toBe(true);
  expect(witnesses.every(w=>w.signal.aborted)).toBe(true);
 }finally{tickets.forEach(t=>t.release());witnesses.forEach(w=>w.release());searches.forEach(s=>s.close());owners.forEach(o=>o.close());gates.forEach(g=>g.close());meshes.forEach(m=>m.close());}
});
