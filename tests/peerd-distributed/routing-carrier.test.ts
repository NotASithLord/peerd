import {test,expect,spyOn} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh,CTRL} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {ROUTING_WITNESS,CONTENT_ONLY,LOOKUP_ONLY} from '../../extension/peerd-distributed/transport/capabilities.js';
import {DIRECTORY_INTRODUCTIONS} from '../../extension/peerd-distributed/transport/directory-introductions.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
const fixture=async(caps:string[]=[ROUTING_WITNESS])=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'carrier',budget:3,transferSlots:1}));
 const pair=memoryPair();
 const sessions=await Promise.all(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps})));
 for(const [i,mesh] of meshes.entries())expect(mesh.addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps})).toBe(true);
 const events:any[]=[];const detach=meshes.map((mesh,i)=>mesh.onRoutingControl(event=>events.push({node:i,...event})));
 return {ids,meshes,pair,events,detach,close:()=>meshes.forEach(mesh=>mesh.close())};
};
test('signed control crosses a negotiated carrier with captured connection ownership',async()=>{
 const f=await fixture();try{
  const carrier=f.meshes[0].routingCarrier(f.ids[1].did)!;
  const env=await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{room:'carrier',marker:'owned'});
  await carrier.send(env);await until(()=>f.events.length===1);
  expect(f.events[0].env.body.marker).toBe('owned');expect(f.events[0].carrier.did).toBe(f.ids[0].did);
  f.meshes[0].removeLink(f.ids[1].did);expect(carrier.signal.aborted).toBe(true);expect(f.events[0].carrier.signal.aborted).toBe(true);
 }finally{f.close();}
});
test('metadata cannot grant or revoke the authenticated negotiated capability',async()=>{
 for(const enabled of [false,true]){
  const f=await fixture(enabled?[ROUTING_WITNESS]:[]);try{
   f.meshes[0].tagLink(f.ids[1].did,{caps:enabled?[]:[ROUTING_WITNESS]});
   expect(!!f.meshes[0].routingCarrier(f.ids[1].did)).toBe(enabled);
  }finally{f.close();}
 }
});
test('temporary content, lookup and directory carriers cannot gain routing control authority',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);
 for(const purpose of ['content','lookup','directory'] as const){
  const mesh=createRoomMesh({identity:ids[0],roomId:'scope',budget:3,transferSlots:1});
  try{
   mesh.onRoutingControl(()=>{});
   const purposeCap=purpose==='content'?CONTENT_ONLY:purpose==='lookup'?LOOKUP_ONLY:DIRECTORY_INTRODUCTIONS;
   expect(mesh.addLink(memoryPair()[0],ids[1].did,{caps:[purposeCap,ROUTING_WITNESS]},{purpose})).toBe(true);
   expect(mesh.routingCarrier(ids[1].did)).toBeNull();
  }finally{mesh.close();}
 }
});
test('a replaced same-DID connection cannot revive a captured carrier',async()=>{
 const f=await fixture();try{
  const old=f.meshes[0].routingCarrier(f.ids[1].did)!;
  expect(f.meshes[0].addLink(memoryPair()[0],f.ids[1].did,{caps:[ROUTING_WITNESS]})).toBe(true);
  expect(old.signal.aborted).toBe(true);expect(old.maxFrameBytes()).toBe(0);
  await expect(old.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{}))).rejects.toThrow();
  expect(f.meshes[0].routingCarrier(f.ids[1].did)?.signal.aborted).toBe(false);
 }finally{f.close();}
});
test('protocol owner retirement cancels queued sends and does not revive old carrier handles',async()=>{
 const f=await fixture();try{
  const old=f.meshes[0].routingCarrier(f.ids[1].did)!;
  for(let i=0;i<8;i++)await old.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{i}));
  await until(()=>f.events.length===8);
  const queued=old.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{i:8}));f.detach[0]();
  await expect(queued).rejects.toThrow();expect(old.signal.aborted).toBe(true);
  f.meshes[0].onRoutingControl(()=>{});f.detach[0]();
  const fresh=f.meshes[0].routingCarrier(f.ids[1].did)!;expect(fresh.signal.aborted).toBe(false);
  await expect(old.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{}))).rejects.toThrow();
  expect(f.meshes[0].hasLink(f.ids[1].did)).toBe(true);
 }finally{f.close();}
});
test('carrier owns outgoing bytes before async pacing and restricts message scope and size',async()=>{
 const f=await fixture();try{
  const carrier=f.meshes[0].routingCarrier(f.ids[1].did)!;
  const env=await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{value:'signed'});
  const sent=carrier.send(env);env.body.value='mutated';await sent;await until(()=>f.events.length===1);
  expect(f.events[0].env.body.value).toBe('signed');
  await expect(carrier.send(await f.meshes[0].sign(0,CTRL.PING,{}))).rejects.toThrow();
  await expect(carrier.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{large:'x'.repeat(20_000)}))).rejects.toThrow();
  expect(f.meshes[0].hasLink(f.ids[1].did)).toBe(true);
 }finally{f.close();}
});
test('mesh admits only one routing protocol owner at a time',async()=>{
 const f=await fixture();try{
  expect(()=>f.meshes[0].onRoutingControl(()=>{})).toThrow();f.detach[0]();
  expect(f.meshes[0].routingCarrier(f.ids[1].did)).toBeNull();
  const detach=f.meshes[0].onRoutingControl(()=>{});expect(f.meshes[0].routingCarrier(f.ids[1].did)).not.toBeNull();detach();
 }finally{f.close();}
});

test('crypto completion cannot cross handler ownership or mutate frame authority',async()=>{
 for(const mode of ['owner','scope','body']){
  const f=await fixture();let resume!:()=>void,entered!:()=>void,finished!:()=>void;
  const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r),verified=new Promise<void>(r=>finished=r);
  const original=crypto.subtle.verify.bind(crypto.subtle);
  const spy=spyOn(crypto.subtle,'verify').mockImplementation(async(...args)=>{
   entered();await gate;try{return await original(...args);}finally{finished();}
  });
  try{
   const env=await f.meshes[0].sign(0,mode==='scope'?CTRL.PING:CTRL.ROUTE_CALL,{marker:'signed'});
   const send=f.pair[0].send(env);await started;
   if(mode==='owner'){f.detach[1]();f.meshes[1].onRoutingControl(event=>f.events.push({node:1,...event}));}
   else if(mode==='scope')env.typ=CTRL.ROUTE_CALL;
   else env.body.marker='tampered';
   resume();await send;await verified;await new Promise(r=>setTimeout(r,0));
   if(mode==='body'){expect(f.events).toHaveLength(1);expect(f.events[0].env.body.marker).toBe('signed');}
   else expect(f.events).toHaveLength(0);
   expect(f.meshes[1].hasLink(f.ids[0].did)).toBe(true);
  }finally{resume();spy.mockRestore();f.close();}
 }
});

test('unnegotiated routing frames do not reach the protocol owner',async()=>{
 const f=await fixture([]);try{
  await f.pair[0].send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{}));
  await new Promise(r=>setTimeout(r,0));expect(f.events).toHaveLength(0);
  expect(f.meshes[1].hasLink(f.ids[0].did)).toBe(true);
 }finally{f.close();}
});

test('frame budget is rechecked after pacing and at the receive boundary',async()=>{
 const f=await fixture();try{
  let limit=16_384;f.pair[0].maxFrameBytes=()=>limit;
  const carrier=f.meshes[0].routingCarrier(f.ids[1].did)!;
  for(let i=0;i<8;i++)await carrier.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{i}));
  await until(()=>f.events.length===8);
  const queued=carrier.send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{large:'x'.repeat(500)}));limit=256;
  await expect(queued).rejects.toThrow();expect(f.events).toHaveLength(8);
  f.pair[1].maxFrameBytes=()=>256;
  await f.pair[0].send(await f.meshes[0].sign(0,CTRL.ROUTE_CALL,{large:'x'.repeat(500)}));
  await new Promise(r=>setTimeout(r,0));expect(f.events).toHaveLength(8);
  expect(f.meshes.every((mesh,i)=>mesh.hasLink(f.ids[1-i].did))).toBe(true);
 }finally{f.close();}
});
