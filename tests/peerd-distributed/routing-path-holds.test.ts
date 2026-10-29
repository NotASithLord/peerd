import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {buildEnvelope,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {createRoutingPathHolds,ROUTING_PATH_HOLD,MAX_ROUTING_PATH_REQUESTS,ROUTING_PATH_COOLDOWN_MS} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {createRoomMesh,ROTATION_HOLD_MS} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
const carrier=(did:string)=>({did,signal:new AbortController().signal});
const fixture=async()=>{
 const ids=await Promise.all(Array.from({length:6},()=>generateIdentity()));let time=100_000;
 const expiry=new Map<object,{at:number,fn:()=>void}>();
 const timers={setTimeout:(fn:()=>void,ms:number)=>{const key={};expiry.set(key,{at:time+ms,fn});return key;},clearTimeout:(key:object)=>expiry.delete(key)};
 const mesh=createRoomMesh({identity:ids[1],roomId:'path',budget:2,sparse:true,now:()=>time,timers});
 for(const i of [0,2])expect(mesh.addLink(memoryPair()[0],ids[i].did,{}, {locallySelected:true})).toBe(true);
 time+=NEIGHBOR_GRACE_MS;
 const gate=createRoutingPathHolds({identity:ids[1],roomId:'path',holdRoutingLink:mesh.holdRoutingLink,now:()=>time});
 const request=async(overrides:Record<string,unknown>={})=>signEnvelope(buildEnvelope({ch:0,typ:ROUTING_PATH_HOLD,from:ids[0].did,
  id:crypto.randomUUID(),ts:time,body:{room:'path',candidate:[ids[0].did,ids[3].did],cuts:[[ids[0].did,ids[2].did]],path:[ids[0].did,ids[1].did,ids[2].did],...overrides}}),ids[0]);
 const advance=(ms:number)=>{time+=ms;for(const [key,entry] of [...expiry])if(time>=entry.at){expiry.delete(key);entry.fn();}};
 return {ids,mesh,gate,request,advance,close:()=>{gate.close();mesh.close();}};
};
test('signed path holds both local edges without admitting or evicting a peer',async()=>{
 const f=await fixture();try{
  const hold=await f.gate.acquire(await f.request(),carrier(f.ids[0].did));
  expect(hold.index).toBe(1);expect(f.mesh.stats().peerDegree).toBe(2);
  expect(()=>f.mesh.reserveAdmission(f.ids[3].did,{locallySelected:true})).toThrow();
  hold.release();expect(hold.signal.aborted).toBe(true);
  f.mesh.reserveAdmission(f.ids[3].did,{locallySelected:true}).release();
 }finally{f.close();}
});
test('path requests bind the origin signature, immediate hop and room',async()=>{
 for(const mode of ['signature','hop','room','origin']){
  const f=await fixture();try{
   const env=await f.request(mode==='room'?{room:'other'}:{});
   if(mode==='signature')env.body.candidate[1]=f.ids[4].did;
   if(mode==='origin')env.from=f.ids[4].did;
   await expect(f.gate.acquire(env,carrier(f.ids[mode==='hop'?2:0].did))).rejects.toThrow();
   f.mesh.reserveAdmission(f.ids[3].did,{locallySelected:true}).release();
  }finally{f.close();}
 }
});
test('paths cannot use either cut, repeat a node, invent endpoints or exceed the hop bound',async()=>{
 const f=await fixture();try{
  const d=f.ids.map(id=>id.did);
  const invalid=[
   {cuts:[[d[0],d[2]],[d[3],d[1]]],path:[d[0],d[1],d[3],d[2]]},
   {path:[d[0],d[1],d[0],d[2]]},
   {path:[d[0],d[1],d[4]]},
   {cuts:[[d[0],d[2]],[d[0],d[4]]]},
   {path:Array.from({length:17},(_,i)=>d[i%6])},
  ];
  for(const body of invalid)await expect(f.gate.acquire(await f.request(body),carrier(d[0]))).rejects.toThrow();
 }finally{f.close();}
});
test('a released or failed request cannot be replayed to renew a path',async()=>{
 const f=await fixture();try{
  const env=await f.request();const hold=await f.gate.acquire(env,carrier(f.ids[0].did));hold.release();
  await expect(f.gate.acquire(env,carrier(f.ids[0].did))).rejects.toThrow();
  const ticket=f.mesh.reserveAdmission(f.ids[3].did,{locallySelected:true});const refused=await f.request();
  await expect(f.gate.acquire(refused,carrier(f.ids[0].did))).rejects.toThrow();ticket.release();
  await expect(f.gate.acquire(refused,carrier(f.ids[0].did))).rejects.toThrow();
 }finally{f.close();}
});
test('link loss, deadline, owner cancellation and close release the entire local path',async()=>{
 for(const mode of ['link','deadline','abort','close']){
  const f=await fixture();try{
   const owner=new AbortController();const hold=await f.gate.acquire(await f.request(),carrier(f.ids[0].did),{signal:owner.signal});
   if(mode==='link')f.mesh.removeLink(f.ids[0].did);
   else if(mode==='deadline')f.advance(ROTATION_HOLD_MS);
   else if(mode==='abort')owner.abort();else f.gate.close();
   expect(hold.signal.aborted).toBe(true);
   f.mesh.reserveAdmission(f.ids[3].did,{locallySelected:true}).release();
  }finally{f.close();}
 }
});
test('concurrent path requests are bounded and release cannot restart the edge deadline',async()=>{
 const f=await fixture();try{
  const holds=[];
  for(let i=0;i<MAX_ROUTING_PATH_REQUESTS;i++)holds.push(await f.gate.acquire(await f.request(),carrier(f.ids[0].did)));
  await expect(f.gate.acquire(await f.request(),carrier(f.ids[0].did))).rejects.toThrow();holds.forEach(h=>h.release());
  await expect(f.gate.acquire(await f.request(),carrier(f.ids[0].did))).rejects.toThrow();
  f.advance(10_000);await expect(f.gate.acquire(await f.request(),carrier(f.ids[0].did))).rejects.toThrow();
  f.advance(ROUTING_PATH_COOLDOWN_MS-10_000);(await f.gate.acquire(await f.request(),carrier(f.ids[0].did))).release();
 }finally{f.close();}
});
test('failure on the second edge rolls back the first hold',async()=>{
 const f=await fixture();try{
  // Retiring the second edge makes the signed path unusable. A partial hold on
  // the first edge must not keep consuming capacity after rejection.
  f.mesh.removeLink(f.ids[2].did);
  await expect(f.gate.acquire(await f.request(),carrier(f.ids[0].did))).rejects.toThrow();
  const leases=Array.from({length:16},()=>f.mesh.holdRoutingLink(f.ids[0].did));leases.forEach(h=>h.release());
 }finally{f.close();}
});

test('invalid signatures consume the bounded verification rate without acquiring holds',async()=>{
 const f=await fixture();try{
  for(let i=0;i<8;i++){
   const env=await f.request();env.sig='invalid';
   await expect(f.gate.acquire(env,carrier(f.ids[0].did))).rejects.toThrow();
  }
  await expect(f.gate.acquire(await f.request(),carrier(f.ids[0].did))).rejects.toThrow();
  f.advance(10_000);(await f.gate.acquire(await f.request(),carrier(f.ids[0].did))).release();
 }finally{f.close();}
});

test('protected alternate paths permit joining two full triangles without losing a member',async()=>{
 const ids=await Promise.all(Array.from({length:6},()=>generateIdentity()));let time=100_000;
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'join',budget:2,sparse:true,now:()=>time}));
 const gates=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'join',holdRoutingLink:mesh.holdRoutingLink,now:()=>time}));
 const holds:Array<{release:()=>void,signal:AbortSignal}>=[];
 const tickets:Array<{release:()=>void}>=[];
 try{
  for(const [a,b] of [[0,1],[1,2],[2,0],[3,4],[4,5],[5,3]]){
   const pair=memoryPair();
   expect(meshes[a].addLink(pair[0],ids[b].did,{}, {locallySelected:true})).toBe(true);
   expect(meshes[b].addLink(pair[1],ids[a].did,{}, {locallySelected:true})).toBe(true);time++;
  }
  time+=NEIGHBOR_GRACE_MS;
  const left=meshes[0].reserveAdmission(ids[3].did,{locallySelected:true});
  const right=meshes[3].reserveAdmission(ids[0].did,{locallySelected:true});tickets.push(left,right);
  for(const path of [[0,2,1],[3,5,4]]){
   const env=await signEnvelope(buildEnvelope({ch:0,typ:ROUTING_PATH_HOLD,from:ids[path[0]].did,
    id:crypto.randomUUID(),ts:time,body:{room:'join',candidate:[ids[0].did,ids[3].did],
     cuts:[[ids[0].did,ids[1].did],[ids[3].did,ids[4].did]],path:path.map(i=>ids[i].did)}}),ids[path[0]]);
   for(const [index,node] of path.entries())holds.push(await gates[node].acquire(env,index?carrier(ids[path[index-1]].did):null));
  }
  expect(holds.every(hold=>!hold.signal.aborted)).toBe(true);
  const replacement=memoryPair();
  expect(meshes[0].addLink(replacement[0],ids[3].did,{}, {locallySelected:true,reservation:left})).toBe(true);
  expect(meshes[3].addLink(replacement[1],ids[0].did,{}, {locallySelected:true,reservation:right})).toBe(true);
  const seen=new Set([0]),pending=[0];
  for(const node of pending)for(const peer of meshes[node].peers()){
   const index=ids.findIndex(id=>id.did===peer.did);if(!seen.has(index)){seen.add(index);pending.push(index);}
  }
  expect(seen.size).toBe(6);expect(meshes.every(mesh=>mesh.stats().peerDegree<=2)).toBe(true);
  expect(holds.every(hold=>!hold.signal.aborted)).toBe(true);
 }finally{holds.forEach(h=>h.release());tickets.forEach(t=>t.release());gates.forEach(g=>g.close());meshes.forEach(m=>m.close());}
});

test('an incoming carrier retired during signature verification cannot transfer authority to its replacement',async()=>{
 const f=await fixture();try{
  const origin=new AbortController(),env=await f.request();
  const pending=f.gate.acquire(env,{did:f.ids[0].did,signal:origin.signal});origin.abort();
  await expect(pending).rejects.toThrow();
  const leases=Array.from({length:16},()=>f.mesh.holdRoutingLink(f.ids[0].did));leases.forEach(h=>h.release());
 }finally{f.close();}
});
