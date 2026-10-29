import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {buildEnvelope,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {createRoutingPathHolds,verifyRoutingPathReceipts,ROUTING_PATH_HOLD} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';

const fixture=async(offset=0)=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));let time=100_000;
 const meshes=ids.slice(0,3).map(identity=>createRoomMesh({identity,roomId:'receipt',budget:2,now:()=>time+offset}));
 for(const [a,b] of [[0,1],[1,2],[2,0]]){const pair=memoryPair();meshes[a].addLink(pair[0],ids[b].did);meshes[b].addLink(pair[1],ids[a].did);}
 const gates=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'receipt',holdRoutingLink:mesh.holdRoutingLink,now:()=>time+offset}));
 const request=await signEnvelope(buildEnvelope({ch:0,typ:ROUTING_PATH_HOLD,from:ids[0].did,id:crypto.randomUUID(),ts:time,
  body:{room:'receipt',candidate:[ids[0].did,ids[3].did],cuts:[[ids[0].did,ids[2].did]],path:ids.slice(0,3).map(id=>id.did)}}),ids[0]);
 const held:Array<Awaited<ReturnType<(typeof gates)[number]['acquire']>>>=[];
 for(const [index,gate] of gates.entries())held.push(await gate.acquire(request,index?{did:ids[index-1].did,signal:new AbortController().signal}:null));
 const verify=(receipts=held.map(h=>h.receipt),env=request,startedAt=100_000)=>verifyRoutingPathReceipts(env,receipts,{roomId:'receipt',startedAt,now:()=>time});
 return {ids,request,held,verify,advance:(ms:number)=>time+=ms,close:()=>{gates.forEach(g=>g.close());meshes.forEach(m=>m.close());}};
};
test('every hop signs the exact request and coordinator deadline starts before transit',async()=>{
 const f=await fixture();try{
  expect(await f.verify()).toMatchObject({validUntil:110_000});
  f.advance(9_999);expect(await f.verify()).not.toBeNull();
  f.advance(1);expect(await f.verify()).toBeNull();
 }finally{f.close();}
});
test('remote clock skew cannot extend the coordinator deadline',async()=>{
 for(const offset of [-5_000,5_000]){
  const f=await fixture(offset);try{
   expect(await f.verify()).toMatchObject({validUntil:110_000});
   f.advance(10_000);expect(await f.verify()).toBeNull();
  }finally{f.close();}
 }
});
test('missing, duplicated, reordered, forged and altered receipts are rejected',async()=>{
 const f=await fixture();try{
  const receipts=f.held.map(h=>h.receipt);
  expect(await f.verify(receipts.slice(1))).toBeNull();
  expect(await f.verify([receipts[0],receipts[0],receipts[2]])).toBeNull();
  expect(await f.verify([...receipts].reverse())).toBeNull();
  for(const field of ['signature','duration','origin','index']){
   const altered=structuredClone(receipts);
   if(field==='signature')altered[1].sig='invalid';
   if(field==='duration')altered[1].body.validForMs=9_000;
   if(field==='origin')altered[1].from=f.ids[3].did;
   if(field==='index')altered[1].body.index=2;
   expect(await f.verify(altered)).toBeNull();
  }
 }finally{f.close();}
});
test('receipts from another signed nonce or removal plan cannot authorize a request',async()=>{
 const f=await fixture();try{
  for(const mode of ['nonce','cuts']){
   const {sig:_signature,...unsigned}=structuredClone(f.request);
   if(mode==='nonce')unsigned.id=crypto.randomUUID();
   else unsigned.body.candidate=[f.ids[2].did,f.ids[3].did];
   const other=await signEnvelope(unsigned,f.ids[0]);
   expect(await f.verify(undefined,other)).toBeNull();
  }
 }finally{f.close();}
});
test('receipt verification observes cancellation and owns an immutable frame snapshot',async()=>{
 const f=await fixture();try{
  const controller=new AbortController(),receipts=f.held.map(h=>h.receipt);
  const pending=verifyRoutingPathReceipts(f.request,receipts,{roomId:'receipt',startedAt:100_000,now:()=>100_000,signal:controller.signal});
  controller.abort();expect(await pending).toBeNull();
  const copies=structuredClone(receipts);
  const isolated=f.verify(copies);copies[1].body.validForMs=1;expect(await isolated).toMatchObject({validUntil:110_000});
 }finally{f.close();}
});
test('expiry while signing a receipt releases local holds and emits no receipt',async()=>{
 const f=await fixture();let time=100_000;
 let resume!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const identity={did:f.ids[0].did,sign:async(bytes:Uint8Array)=>{entered();await gate;return f.ids[0].sign(bytes);}};
 const mesh=createRoomMesh({identity,roomId:'receipt',budget:2,now:()=>time});
 mesh.addLink(memoryPair()[0],f.ids[1].did);
 const paths=createRoutingPathHolds({identity,roomId:'receipt',holdRoutingLink:mesh.holdRoutingLink,now:()=>time});
 try{
  const result=paths.acquire(f.request,null);await started;time+=10_000;resume();await expect(result).rejects.toThrow();
  // Every hold slot is available again, even though the timer callbacks have
  // not run: the post-signing deadline check owns rollback itself.
  const leases=Array.from({length:16},()=>mesh.holdRoutingLink(f.ids[1].did));leases.forEach(h=>h.release());
 }finally{resume();paths.close();mesh.close();f.close();}
});
