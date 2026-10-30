import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {buildEnvelope,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {ROUTED_RETRIEVAL,ROUTING_WITNESS,RETRIEVAL_CHANNEL,RETRIEVAL_TYPES} from '../../extension/peerd-distributed/transport/capabilities.js';
const tick=()=>new Promise(r=>setTimeout(r,25));
const fixture=async(caps=[ROUTED_RETRIEVAL])=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const meshes=ids.slice(0,2).map(identity=>createRoomMesh({identity,roomId:'retrieval',budget:2}));
 const pair=memoryPair();
 const sessions=await Promise.all(ids.slice(0,2).map((identity,i)=>createSession({identity,channel:pair[i],caps})));
 meshes.forEach((m,i)=>expect(m.addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps})).toBe(true));
 const sign=(index=0,body:any={})=>signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,typ:RETRIEVAL_TYPES.CALL,from:ids[index].did,id:crypto.randomUUID(),ts:Date.now(),body}),ids[index]);
 return {ids,meshes,pair,sign,close:()=>meshes.forEach(m=>m.close())};
};
test('retrieval requires its own negotiated capability and live exclusive owner',async()=>{
 for(const caps of [[],[ROUTING_WITNESS],[ROUTED_RETRIEVAL]]){
  const f=await fixture(caps);try{
   expect(f.meshes[0].retrievalCarrier(f.ids[1].did)).toBeNull();
   const off=f.meshes[0].onRetrieval(()=>{});
   expect(!!f.meshes[0].retrievalCarrier(f.ids[1].did)).toBe(caps.includes(ROUTED_RETRIEVAL));
   expect(()=>f.meshes[0].onRetrieval(()=>{})).toThrow();
   off();expect(f.meshes[0].retrievalCarrier(f.ids[1].did)).toBeNull();
   expect(f.meshes[0].routingCarrier(f.ids[1].did)).toBeNull();
  }finally{f.close();}
 }
});
test('signed forwarded retrieval is confined to its owner and always uses bulk priority',async()=>{
 const f=await fixture();try{
  const received:any[]=[],generic:any[]=[],options:any[]=[];
  f.meshes[0].onRetrieval(()=>{});f.meshes[1].onRetrieval(event=>received.push(event));
  f.meshes[1].onEnvelope(event=>generic.push(event));
  const send=f.pair[0].send.bind(f.pair[0]);
  f.pair[0].send=async(env:any,opt:any)=>{options.push(opt);await send(env,opt);};
  const carrier=f.meshes[0].retrievalCarrier(f.ids[1].did)!;
  // The third identity is an origin, not the immediate link. Custody is the
  // protocol owner's job; mesh still verifies its actual signature.
  const frame=await f.sign(2);
  await carrier.send(frame,{priority:'control'});await tick();
  expect(received).toHaveLength(1);expect(received[0].env).toEqual(frame);
  expect(generic).toHaveLength(0);expect(options[0].priority).toBe('bulk');
  expect(f.meshes.map(m=>m.stats().totalDegree)).toEqual([1,1]);
  await expect(carrier.send({...frame,ch:0,typ:10})).rejects.toThrow();
  await expect(carrier.send({...frame,typ:999})).rejects.toThrow();
  await expect(carrier.send({...frame,body:'x'.repeat(4096)})).rejects.toThrow();
 }finally{f.close();}
});
test('invalid signatures, unknown types and oversized inbound frames never reach retrieval owner',async()=>{
 const f=await fixture();try{
  const received:any[]=[],generic:any[]=[];
  f.meshes[1].onRetrieval(event=>received.push(event));f.meshes[1].onEnvelope(event=>generic.push(event));
  const frame=await f.sign();
  await f.pair[0].send({...frame,body:{tampered:true}});
  await f.pair[0].send({...frame,typ:999});
  await f.pair[0].send({...frame,body:'x'.repeat(4096)});await tick();
  expect(received).toHaveLength(0);expect(generic).toHaveLength(0);
  await f.pair[0].send(frame);await tick();expect(received).toHaveLength(1);
 }finally{f.close();}
});
test('detached owners and retired connections permanently revoke captured carriers',async()=>{
 const f=await fixture();try{
  const off=f.meshes[0].onRetrieval(()=>{});
  const old=f.meshes[0].retrievalCarrier(f.ids[1].did)!;expect(old.signal.aborted).toBe(false);
  off();expect(old.signal.aborted).toBe(true);
  f.meshes[0].onRetrieval(()=>{});off();
  const current=f.meshes[0].retrievalCarrier(f.ids[1].did)!;expect(current).not.toBe(old);
  await expect(old.send(await f.sign())).rejects.toThrow();expect(old.maxFrameBytes()).toBe(0);
  f.meshes[0].removeLink(f.ids[1].did);expect(current.signal.aborted).toBe(true);
  await expect(current.send(await f.sign())).rejects.toThrow();
 }finally{f.close();}
});
test('absent owners drop inbound retrieval; a smaller carrier limit is enforced both ways',async()=>{
 const f=await fixture();try{
  const received:any[]=[],generic:any[]=[];
  f.meshes[1].onEnvelope(event=>generic.push(event));
  await f.pair[0].send(await f.sign());await tick();
  f.meshes[0].onRetrieval(()=>{});f.meshes[1].onRetrieval(event=>received.push(event));
  Object.assign(f.pair[0],{maxFrameBytes:()=>512});Object.assign(f.pair[1],{maxFrameBytes:()=>512});
  const carrier=f.meshes[0].retrievalCarrier(f.ids[1].did)!;
  expect(carrier.maxFrameBytes()).toBe(512);
  const frame=await f.sign(0,{data:'x'.repeat(512)});
  await expect(carrier.send(frame)).rejects.toThrow();
  await f.pair[0].send(frame);await tick();
  expect(received).toHaveLength(0);expect(generic).toHaveLength(0);
 }finally{f.close();}
});
test('queued sends retain an owned frame and abort when the owner detaches',async()=>{
 const f=await fixture();try{
  const off=f.meshes[0].onRetrieval(()=>{});const carrier=f.meshes[0].retrievalCarrier(f.ids[1].did)!;
  let queued:any,signal:AbortSignal|undefined,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.pair[0].send=(env:any,options:any)=>new Promise<void>((_resolve,reject)=>{
   queued=env;signal=options.signal;entered();
   signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
  });
  const frame=await f.sign(0,{data:'original'});
  const rejected=carrier.send(frame).then(()=>null,error=>error);
  await started;frame.body.data='mutated';expect(queued.body.data).toBe('original');
  off();expect(await rejected).toBeInstanceOf(Error);expect(signal!.aborted).toBe(true);
 }finally{f.close();}
});
