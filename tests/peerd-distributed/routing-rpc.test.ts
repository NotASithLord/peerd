import {test,expect,spyOn} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {canonicalize} from '../../extension/shared/bundle/canonical.js';
import {utf8} from '../../extension/shared/bundle/bytes.js';
import {sha256hex} from '../../extension/shared/bundle/chunk.js';
import {buildEnvelope,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {createSession,ADMISSION_READY} from '../../extension/peerd-distributed/transport/session.js';
import {ROUTING_WITNESS,ROUTING_CONTROL} from '../../extension/peerd-distributed/transport/capabilities.js';
import {createRoutingPathHolds} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {createRoutingRpc} from '../../extension/peerd-distributed/transport/routing-rpc.js';
import {createRoutingPathSearch} from '../../extension/peerd-distributed/transport/routing-path-search.js';
import {createRoutingWitnesses} from '../../extension/peerd-distributed/transport/routing-witness.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
const fixture=async(edges:number[][],count=6,onSend?:(from:number,to:number,env:any)=>Promise<void>)=>{
 const frames:Array<{from:number,to:number,env:any}>=[];
 const ids=await Promise.all(Array.from({length:count},()=>generateIdentity()));let offset=0;const now=()=>Date.now()+offset;
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'rpc',budget:2,sparse:true,now}));
 for(const [a,b] of edges){
  const pair=memoryPair();
  for(const [i,node] of [a,b].entries()){
   const original=pair[i].send.bind(pair[i]);pair[i].send=async(env:any,options:any)=>{
    if(env?.ch===0&&env.typ>=10){frames.push({from:node,to:i===0?b:a,env:structuredClone(env)});await onSend?.(node,i===0?b:a,env);}
    return original(env,options);
   };
  }
  const sessions=await Promise.all([a,b].map((node,i)=>createSession({identity:ids[node],channel:pair[i],caps:[ROUTING_WITNESS]})));
  for(const [i,node] of [a,b].entries())expect(meshes[node].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps},{locallySelected:true})).toBe(true);offset++;
 }
 offset+=NEIGHBOR_GRACE_MS;
 const gates=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'rpc',holdRoutingLink:mesh.holdRoutingLink,now}));
 const rpcs=meshes.map((mesh,i)=>createRoutingRpc({identity:ids[i],roomId:'rpc',mesh,holds:gates[i],now}));
 const searches=rpcs.map((rpc,i)=>createRoutingPathSearch({selfDid:ids[i].did,readNeighbors:rpc.readNeighbors,now}));
 const witnesses=rpcs.map((rpc,i)=>createRoutingWitnesses({identity:ids[i],roomId:'rpc',acquireHop:rpc.acquireHop,now}));
 return {ids,meshes,rpcs,searches,witnesses,frames,now,advance:(ms:number)=>offset+=ms,
  close:()=>{searches.forEach(x=>x.close());witnesses.forEach(x=>x.close());rpcs.forEach(x=>x.close());gates.forEach(x=>x.close());meshes.forEach(x=>x.close());}};
};
test('signed multi-hop RPC returns only the requested endpoint roster',async()=>{
 const f=await fixture([[0,1],[1,2],[2,3]]);try{
  const result=await f.rpcs[0].readNeighbors([0,1,2].map(i=>f.ids[i].did),new AbortController().signal);
  expect(new Set(result)).toEqual(new Set([f.ids[1].did,f.ids[3].did]));
 }finally{f.close();}
});
test('wire search excludes both planned cuts rather than traversing a bridge',async()=>{
 const f=await fixture([[0,1],[1,2],[2,3],[3,0]]);try{
  const cuts=[[f.ids[0].did,f.ids[1].did],[f.ids[2].did,f.ids[3].did]];
  expect(await f.searches[0].find({target:f.ids[1].did,cuts})).toBeNull();
 }finally{f.close();}
});
test('signed receipts travel over existing carriers and cancellation releases remote holds',async()=>{
 const f=await fixture([[0,1],[1,2],[2,0]]);try{
  const cuts=[[f.ids[0].did,f.ids[1].did]];
  const path=await f.searches[0].find({target:f.ids[1].did,cuts});expect(path).toEqual([0,2,1].map(i=>f.ids[i].did));
  const witness=await f.witnesses[0].acquire({candidate:[f.ids[0].did,f.ids[3].did],cuts,path:[...path!]});
  expect(witness.receipts).toHaveLength(3);
  expect(()=>f.meshes[2].reserveAdmission(f.ids[3].did,{locallySelected:true})).toThrow();
  witness.release();
  await until(()=>{try{f.meshes[2].reserveAdmission(f.ids[3].did,{locallySelected:true}).release();return true;}catch{return false;}});
  expect(f.meshes.slice(0,3).every(m=>m.stats().peerDegree===2)).toBe(true);
 }finally{f.close();}
});
test('a broken intermediate carrier aborts a collected remote witness',async()=>{
 const f=await fixture([[0,1],[1,2],[2,0]]);try{
  const witness=await f.witnesses[0].acquire({candidate:[f.ids[0].did,f.ids[3].did],cuts:[[f.ids[0].did,f.ids[1].did]],path:[0,2,1].map(i=>f.ids[i].did)});
  f.meshes[2].removeLink(f.ids[1].did);await until(()=>witness.signal.aborted);
 }finally{f.close();}
});

test('wire search and witnesses preserve every member when young full components join',async()=>{
 const f=await fixture([[0,1],[1,2],[2,0],[3,4],[4,5],[5,3]]);
 f.advance(-NEIGHBOR_GRACE_MS);
 const endpoints=[0,3],tickets=endpoints.map((node,i)=>f.meshes[node].reserveAdmission(f.ids[endpoints[1-i]].did,{locallySelected:true,requireWitness:true}));
 const witnesses:Array<Awaited<ReturnType<typeof f.witnesses[0]['acquire']>>>=[];
 try{
  const pair=memoryPair();const sessions=await Promise.all(endpoints.map((node,i)=>createSession({
   identity:f.ids[node],channel:pair[i],caps:[ROUTING_WITNESS,ADMISSION_READY],
   prepareAdmission:()=>tickets[i],
   commitAdmission:async({remoteDid,localVictim,remoteVictim,signal})=>{
    expect(localVictim).toBe(tickets[i].victim);expect(remoteVictim).toBe(tickets[1-i].victim);
    const cuts=[[f.ids[node].did,localVictim!],[remoteDid,remoteVictim!]];
    const path=await f.searches[node].find({target:localVictim!,cuts,signal});expect(path).not.toBeNull();
    const witness=await f.witnesses[node].acquire({candidate:[f.ids[node].did,remoteDid],cuts,path:[...path!],signal});
    witnesses[i]=witness;expect(tickets[i].bindWitness(witness)).toBe(true);return witness;
   },
  })));
  for(const [i,node] of endpoints.entries()){
   expect(witnesses[i].signal.aborted).toBe(false);expect(f.now()).toBeLessThan(witnesses[i].validUntil);
   expect(f.meshes[node].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps},{locallySelected:true,reservation:tickets[i]})).toBe(true);
  }
  const seen=new Set([f.ids[0].did]),pending=[0];
  for(const node of pending)for(const peer of f.meshes[node].peers())if(!seen.has(peer.did)){
   seen.add(peer.did);pending.push(f.ids.findIndex(id=>id.did===peer.did));
  }
  expect(seen.size).toBe(6);expect(f.meshes.every(mesh=>mesh.stats().peerDegree<=2)).toBe(true);
 }finally{tickets.forEach(t=>t.release());witnesses.forEach(w=>w.release());f.close();}
});

test('a missing forwarding edge is cancelled promptly without a new dial',async()=>{
 const f=await fixture([[0,1],[2,3]]);try{
  await expect(f.rpcs[0].readNeighbors([0,1,2].map(i=>f.ids[i].did),new AbortController().signal)).rejects.toThrow();
  expect(f.meshes[1].hasLink(f.ids[2].did)).toBe(false);
 }finally{f.close();}
});

test('a valid signature from an intermediate cannot impersonate the requested endpoint',async()=>{
 let resume!:()=>void,entered!:()=>void,blocked=false;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const f=await fixture([[0,1],[1,2]],6,async(from,_to,env)=>{
  if(from===2&&env.typ===ROUTING_CONTROL.ROUTE_REPLY&&!blocked){blocked=true;entered();await gate;}
 });
 let settled=false;
 try{
  const result=f.rpcs[0].readNeighbors([0,1,2].map(i=>f.ids[i].did),new AbortController().signal).then(value=>{settled=true;return value;});
  await started;const reply=f.frames.find(frame=>frame.from===2&&frame.env.typ===ROUTING_CONTROL.ROUTE_REPLY)!.env;
  const forged=await f.meshes[1].sign(0,ROUTING_CONTROL.ROUTE_REPLY,reply.body);
  await f.meshes[1].routingCarrier(f.ids[0].did)!.send(forged);
  await new Promise(r=>setTimeout(r,10));expect(settled).toBe(false);
  const wrongHash=await f.meshes[2].sign(0,ROUTING_CONTROL.ROUTE_REPLY,{...reply.body,requestHash:'0'.repeat(64)});
  await f.meshes[2].routingCarrier(f.ids[1].did)!.send(wrongHash);
  await new Promise(r=>setTimeout(r,10));expect(settled).toBe(false);
  resume();expect(await result).toEqual([f.ids[1].did]);
 }finally{resume();f.close();}
});

test('replaying a completed signed call does not forward a second request',async()=>{
 const f=await fixture([[0,1],[1,2]]);try{
  await f.rpcs[0].readNeighbors([0,1,2].map(i=>f.ids[i].did),new AbortController().signal);
  const call=f.frames.find(frame=>frame.from===0&&frame.env.typ===ROUTING_CONTROL.ROUTE_CALL)!.env;
  const before=f.frames.filter(frame=>frame.from===1&&frame.to===2&&frame.env.typ===ROUTING_CONTROL.ROUTE_CALL).length;
  await f.meshes[0].routingCarrier(f.ids[1].did)!.send(call);await new Promise(r=>setTimeout(r,10));
  expect(f.frames.filter(frame=>frame.from===1&&frame.to===2&&frame.env.typ===ROUTING_CONTROL.ROUTE_CALL)).toHaveLength(before);
 }finally{f.close();}
});

test('a signed call arriving from the wrong preceding hop cannot change its route',async()=>{
 const f=await fixture([[0,1],[1,2]]);try{
  const env=await f.meshes[0].sign(0,ROUTING_CONTROL.ROUTE_CALL,{room:'rpc',path:[0,2,1].map(i=>f.ids[i].did),op:'neighbors',payload:null});
  await f.meshes[0].routingCarrier(f.ids[1].did)!.send(env);await new Promise(r=>setTimeout(r,10));
  expect(f.frames.filter(frame=>frame.from===1)).toHaveLength(0);
  expect(f.meshes[0].hasLink(f.ids[2].did)).toBe(false);
 }finally{f.close();}
});

test('signed malformed nonce fields are rejected without invoking object coercion or closing the carrier',async()=>{
 const f=await fixture([[0,1]]);try{
  const original=await f.meshes[0].sign(0,ROUTING_CONTROL.ROUTE_CALL,{room:'rpc',path:[0,1].map(i=>f.ids[i].did),op:'neighbors',payload:null});
  const {sig:_signature,...unsigned}=original;
  const malformed=await signEnvelope({...unsigned,id:{toString:null}} as any,f.ids[0]);
  await f.meshes[0].routingCarrier(f.ids[1].did)!.send(malformed);
  const reply=await f.meshes[1].sign(0,ROUTING_CONTROL.ROUTE_REPLY,{room:'rpc',origin:f.ids[0].did,id:{toString:null},requestHash:'0'.repeat(64),payload:[]});
  await f.meshes[1].routingCarrier(f.ids[0].did)!.send(reply);
  await new Promise(r=>setTimeout(r,10));
  expect(await f.rpcs[0].readNeighbors([0,1].map(i=>f.ids[i].did),new AbortController().signal)).toEqual([f.ids[0].did]);
 }finally{f.close();}
});

test('cancellation racing request hashing is retained only for the matching signed request',async()=>{
 for(const matches of [true,false]){
  const ids=await Promise.all(Array.from({length:3},()=>generateIdentity())),time=Date.now();
  const request=await signEnvelope(buildEnvelope({ch:0,typ:ROUTING_CONTROL.ROUTE_CALL,from:ids[0].did,id:crypto.randomUUID(),ts:time,
   body:{room:'hash-race',path:ids.map(id=>id.did),op:'neighbors',payload:null}}),ids[0]);
  const hash=await sha256hex(utf8(canonicalize(request)));
  const cancel=await signEnvelope(buildEnvelope({ch:0,typ:ROUTING_CONTROL.ROUTE_CANCEL,from:ids[0].did,id:crypto.randomUUID(),ts:time,
   body:{room:'hash-race',origin:ids[0].did,id:request.id,requestHash:matches?hash:'0'.repeat(64)}}),ids[0]);
  const sent:any[]=[];
  const carrier=(did:string)=>({did,signal:new AbortController().signal,maxFrameBytes:()=>16_384,send:async(env:any)=>{sent.push(env);}});
  const previous=carrier(ids[0].did),next=carrier(ids[2].did);
  let receive!:(event:{env:any,carrier:typeof previous})=>void,resume!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
  const original=crypto.subtle.digest.bind(crypto.subtle);
  const spy=spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await gate;return original(...args);});
  const rpc=createRoutingRpc({identity:ids[1],roomId:'hash-race',now:()=>time,
   mesh:{routingCarrier:did=>did===ids[2].did?next:null,peers:()=>[],onRoutingControl:handler=>{receive=handler;return ()=>{};}},
   holds:{canSuggestEdge:()=>true,acquire:async()=>{throw new Error('unused');}}});
  try{
   receive({env:request,carrier:previous});await started;receive({env:cancel,carrier:previous});resume();
   await until(()=>sent.length>0);
   expect(sent.some(env=>env.typ===ROUTING_CONTROL.ROUTE_CALL)).toBe(!matches);
  }finally{resume();rpc.close();spy.mockRestore();}
 }
});

test('routing neighbor hints exclude a released path edge during its cooldown',async()=>{
 const f=await fixture([[0,1],[1,2],[2,0]]);try{
  const witness=await f.witnesses[0].acquire({candidate:[f.ids[0].did,f.ids[3].did],cuts:[[f.ids[0].did,f.ids[1].did]],path:[0,2,1].map(i=>f.ids[i].did)});
  witness.release();
  const neighbors=await f.rpcs[0].readNeighbors([f.ids[0].did],new AbortController().signal);
  expect(neighbors).toContain(f.ids[1].did);
  expect(neighbors).not.toContain(f.ids[2].did);
  expect(f.meshes[0].hasLink(f.ids[2].did)).toBe(true);
 }finally{f.close();}
});
