import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createRoomRetrieval} from '../../extension/peerd-distributed/transport/room-retrieval.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {ROUTED_RETRIEVAL} from '../../extension/peerd-distributed/transport/capabilities.js';
const request={kind:'chunk' as const,hash:'a'.repeat(64)};
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
const fixture=async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);let blocked=false;
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'test',budget:2}));
 const owners=ids.map((identity,i)=>createRoomRetrieval({identity,roomId:'test',mesh:meshes[i],routeTo:async()=>[identity.did,ids[1-i].did],isBlocked:did=>i===0&&blocked&&did===ids[1].did}));
 const pair=memoryPair();const sessions=await Promise.all(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ROUTED_RETRIEVAL]})));
 meshes.forEach((mesh,i)=>mesh.addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps}));
 return {ids,meshes,owners,block:()=>{blocked=true;},close:()=>{owners.forEach(o=>o.close());meshes.forEach(m=>m.close());}};
};
test('service binding is exclusive and detach permanently cancels its room authority',async()=>{
 const f=await fixture();try{
  let signal:AbortSignal|undefined;
  const detach=f.owners[1].serve(async(_request,s)=>{signal=s;return new Promise((_,reject)=>s.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
  expect(()=>f.owners[1].serve(async()=>null)).toThrow();
  const carrier=f.meshes[1].retrievalCarrier(f.ids[0].did)!;
  const pending=f.owners[0].read(f.ids[1].did,request,new AbortController().signal).catch(e=>e);
  await until(()=>!!signal);detach();expect(await pending).toBeInstanceOf(Error);expect(signal!.aborted).toBe(true);
  await until(()=>carrier.signal.aborted);expect(()=>f.owners[1].serve(async()=>null)).toThrow();
 }finally{f.close();}
});
test('a target blocked during retrieval cannot deliver its pending content',async()=>{
 const f=await fixture();try{
  let release!:(bytes:Uint8Array)=>void;
  f.owners[1].serve(async()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.owners[0].read(f.ids[1].did,request,new AbortController().signal).catch(e=>e);
  await until(()=>!!release);f.block();release(new Uint8Array([1]));
  expect(await pending).toBeInstanceOf(Error);
  await expect(f.owners[0].read(f.ids[1].did,request,new AbortController().signal)).rejects.toThrow();
 }finally{f.close();}
});
test('closing a room aborts outbound work and leaves unrelated routing links intact',async()=>{
 const f=await fixture();try{
  let signal:AbortSignal|undefined;
  f.owners[1].serve(async(_request,s)=>{signal=s;return new Promise((_,reject)=>s.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
  const pending=f.owners[0].read(f.ids[1].did,request,new AbortController().signal).catch(e=>e);
  await until(()=>!!signal);f.owners[0].close();expect(await pending).toBeInstanceOf(Error);
  await until(()=>signal!.aborted);expect(f.meshes.every(m=>m.stats().totalDegree===1)).toBe(true);
 }finally{f.close();}
});
