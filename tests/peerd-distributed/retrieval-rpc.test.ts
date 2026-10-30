import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {ROUTED_RETRIEVAL,RETRIEVAL_TYPES as TYPE,RETRIEVAL_CHANNEL} from '../../extension/peerd-distributed/transport/capabilities.js';
import {createRetrievalRpc} from '../../extension/peerd-distributed/transport/retrieval-rpc.js';
import {signEnvelope,buildEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
const hash='b'.repeat(64);
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
const fixture=async(read:(index:number,request:any,signal:AbortSignal)=>Promise<Uint8Array|null>,options:{dropParts?:boolean,delayAck?:boolean,delayAckMs?:number,reorderParts?:boolean}={})=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'retrieve',budget:2}));
 const frames:Array<{from:number,to:number,env:any}>=[],pairs:ReturnType<typeof memoryPair>[]=[];
 for(let a=0;a<3;a++){
  const pair=memoryPair();pairs.push(pair);
  for(const i of [0,1]){
   const send=pair[i].send.bind(pair[i]);pair[i].send=async(env:any,opt:any)=>{
    if(env?.ch===RETRIEVAL_CHANNEL){frames.push({from:a+i,to:a+1-i,env:structuredClone(env)});if(options.dropParts&&a+i===3&&env.typ===TYPE.PART)return;}
    if(options.reorderParts&&env.typ===TYPE.PART&&env.body.part.offset%16384===0){
     setTimeout(()=>{void send(env,opt).catch(()=>{});},10);return;
    }
    await send(env,opt);if((options.delayAck||options.delayAckMs)&&env.typ===TYPE.ACK)await new Promise(r=>setTimeout(r,options.delayAckMs??2));
   };
  }
  const sessions=await Promise.all([0,1].map(i=>createSession({identity:ids[a+i],channel:pair[i],caps:[ROUTED_RETRIEVAL]})));
  for(const i of [0,1])expect(meshes[a+i].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps})).toBe(true);
 }
 let offset=0;const now=()=>Date.now()+offset;
 const rpcs=meshes.map((mesh,i)=>createRetrievalRpc({identity:ids[i],roomId:'retrieve',mesh,now,read:(request,signal)=>read(i,request,signal)}));
 return {ids,meshes,rpcs,frames,pairs,now,advance:(ms:number)=>{offset+=ms;},path:ids.map(id=>id.did),close:()=>{rpcs.forEach(r=>r.close());meshes.forEach(m=>m.close());}};
};
test('bounded immutable retrieval crosses a full chain without adding or replacing links',async()=>{
 const bytes=Uint8Array.from({length:262144},(_,i)=>i%251),reads:number[]=[];
 const f=await fixture(async i=>{reads.push(i);return bytes;});try{
  const before=f.meshes.map(m=>m.peers().map(p=>p.did));
  const result=await f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal);
  expect(result).toEqual(bytes);expect(reads).toEqual([3]);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
  expect(f.meshes.map(m=>m.peers().map(p=>p.did))).toEqual(before);
  expect(f.meshes.every(m=>m.stats().totalDegree<=2)).toBe(true);
  expect(f.frames.filter(f=>f.env.typ===TYPE.PART&&f.from===3)).toHaveLength(256);
  expect(f.frames.filter(f=>f.env.typ===TYPE.ACK&&f.from===0)).toHaveLength(16);
 }finally{f.close();}
});
test('absence completes with one part and ACK; completed signed calls cannot replay',async()=>{
 let reads=0;const f=await fixture(async()=>{reads++;return null;});try{
  expect(await f.rpcs[0].retrieve(f.path,{kind:'providers',hash},new AbortController().signal)).toEqual(new Uint8Array());
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
  const call=f.frames.find(x=>x.from===0&&x.env.typ===TYPE.CALL)!.env;
  await f.pairs[0][0].send(call);await new Promise(r=>setTimeout(r,30));
  expect(reads).toBe(1);expect(f.rpcs.every(r=>r.stats().active===0)).toBe(true);
 }finally{f.close();}
});
test('origin cancellation aborts pending endpoint read and retires every hop',async()=>{
 let endpointSignal:AbortSignal|undefined;
 const f=await fixture(async(_i,_request,signal)=>{endpointSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
 try{
  const ac=new AbortController();const result=f.rpcs[0].retrieve(f.path,{kind:'manifest',hash},ac.signal).catch(e=>e);
  await until(()=>!!endpointSignal);ac.abort();expect(await result).toBeInstanceOf(Error);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));expect(endpointSignal!.aborted).toBe(true);
 }finally{f.close();}
});
test('a broken intermediate connection aborts retrieval without creating a replacement',async()=>{
 const f=await fixture(async()=>new Uint8Array(2048),{dropParts:true});try{
  const result=f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal).catch(e=>e);
  await until(()=>f.frames.some(x=>x.env.typ===TYPE.PART));f.meshes[1].removeLink(f.ids[2].did);
  expect(await result).toBeInstanceOf(Error);await until(()=>f.rpcs.every(r=>r.stats().active===0));
  expect(f.meshes[1].stats().totalDegree).toBe(1);
 }finally{f.close();}
});
test('relay-signed forged replies and wrong request hashes cannot complete a request',async()=>{
 const f=await fixture(async()=>new Uint8Array(2),{dropParts:true});try{
  const ac=new AbortController();let settled=false;
  const result=f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},ac.signal).catch(e=>e).finally(()=>{settled=true;});
  await until(()=>f.frames.some(x=>x.env.typ===TYPE.PART));
  const legitimate=f.frames.find(x=>x.env.typ===TYPE.PART)!.env;
  for(const [signer,body] of [[1,legitimate.body],[3,{...legitimate.body,requestHash:'a'.repeat(64)}]] as const){
   const env=await signEnvelope(buildEnvelope({...legitimate,from:f.ids[signer].did,id:crypto.randomUUID(),body}),f.ids[signer]);
   await f.pairs[0][1].send(env);
  }
  await new Promise(r=>setTimeout(r,25));expect(settled).toBe(false);ac.abort();await result;
 }finally{f.close();}
});
test('origin concurrency is bounded and oversized endpoint reads fail closed',async()=>{
 const f=await fixture(async()=>new Uint8Array(262145));try{
  await expect(f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal)).rejects.toThrow();
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
  expect(f.frames.some(x=>x.env.typ===TYPE.PART)).toBe(false);
 }finally{f.close();}
 const g=await fixture(async()=>new Uint8Array(2),{dropParts:true});try{
  const ac=new AbortController();
  const pending=[0,1].map(()=>g.rpcs[0].retrieve(g.path,{kind:'chunk',hash},ac.signal).catch(e=>e));
  await until(()=>g.rpcs[0].stats().originating===2);
  await expect(g.rpcs[0].retrieve(g.path,{kind:'chunk',hash},ac.signal)).rejects.toThrow();
  ac.abort();expect((await Promise.all(pending)).every(x=>x instanceof Error)).toBe(true);
  await until(()=>g.rpcs.every(r=>r.stats().active===0));
 }finally{g.close();}
});
test('predicted ACK floods cannot advance an endpoint before its current send drains',async()=>{
 const {canonicalize}=await import('../../extension/shared/bundle/canonical.js');
 const {utf8}=await import('../../extension/shared/bundle/bytes.js');
 const {sha256hex}=await import('../../extension/shared/bundle/chunk.js');
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);
 const sent:any[]=[];let drain!:()=>void;
 const carrier={did:ids[0].did,signal:new AbortController().signal,maxFrameBytes:()=>4096,
  send:(env:any,options?:{signal?:AbortSignal})=>{
   sent.push(env);if(env.typ!==TYPE.PART)return Promise.resolve();
   return new Promise<void>((resolve,reject)=>{drain=resolve;options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  }};
 let receive!:(event:{env:any,carrier:typeof carrier})=>void;
 const rpc=createRetrievalRpc({identity:ids[1],roomId:'test',mesh:{retrievalCarrier:()=>null,onRetrieval:cb=>{receive=cb;return ()=>{};}},read:async()=>new Uint8Array(32768)});
 try{
  const call=await signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,typ:TYPE.CALL,from:ids[0].did,id:crypto.randomUUID(),ts:Date.now(),
   body:{room:'test',path:ids.map(x=>x.did),request:{kind:'chunk',hash}}}),ids[0]);
  receive({env:call,carrier});await until(()=>sent.length===1);
  for(let count=1;count<16;count++){drain();await until(()=>sent.length===count+1);}
  const ack=await signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,typ:TYPE.ACK,from:ids[0].did,id:crypto.randomUUID(),ts:Date.now(),
   body:{room:'test',origin:ids[0].did,requestId:call.id,requestHash:await sha256hex(utf8(canonicalize(call))),offset:16384}}),ids[0]);
  for(let i=0;i<20;i++)receive({env:ack,carrier});
  await new Promise(r=>setTimeout(r,25));expect(sent).toHaveLength(16);
  drain();await until(()=>sent.length===17);expect(sent[16].body.part.offset).toBe(16384);
  expect(rpc.stats().active).toBe(1);
 }finally{rpc.close();}
});
test('replies arriving before ACK send completion preserve the final part',async()=>{
 const bytes=Uint8Array.from({length:4097},(_,i)=>i%253);
 const f=await fixture(async()=>bytes,{delayAck:true});try{
  expect(await f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal)).toEqual(bytes);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
 }finally{f.close();}
});
test('the fixed lifetime cannot be renewed by a fresh correlated frame',async()=>{
 const f=await fixture(async()=>new Uint8Array(4),{dropParts:true});try{
  const result=f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal).catch(e=>e);
  await until(()=>f.frames.some(x=>x.env.typ===TYPE.PART));
  const first=f.frames.find(x=>x.env.typ===TYPE.PART)!.env;f.advance(60001);
  const late=await signEnvelope(buildEnvelope({...first,id:crypto.randomUUID(),ts:f.now()}),f.ids[3]);
  await f.pairs[0][1].send(late);expect(await result).toBeInstanceOf(Error);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
 }finally{f.close();}
});
test('cancelled storage work keeps a capacity slot until its promise settles',async()=>{
 const {canonicalize}=await import('../../extension/shared/bundle/canonical.js');
 const {utf8}=await import('../../extension/shared/bundle/bytes.js');
 const {sha256hex}=await import('../../extension/shared/bundle/chunk.js');
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);
 const carrier={did:ids[0].did,signal:new AbortController().signal,maxFrameBytes:()=>4096,send:async()=>{}};
 let receive!:(event:{env:any,carrier:typeof carrier})=>void;
 const release:Array<()=>void>=[];
 const rpc=createRetrievalRpc({identity:ids[1],roomId:'test',mesh:{retrievalCarrier:()=>null,onRetrieval:cb=>{receive=cb;return ()=>{};}},
  read:async()=>new Promise(resolve=>release.push(()=>resolve(null)))});
 const sign=(typ:number,body:any)=>signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,typ,from:ids[0].did,id:crypto.randomUUID(),ts:Date.now(),body}),ids[0]);
 try{
  for(let i=0;i<16;i++){
   const call=await sign(TYPE.CALL,{room:'test',path:ids.map(x=>x.did),request:{kind:'chunk',hash}});
   receive({env:call,carrier});await until(()=>release.length===i+1);
   const cancel=await sign(TYPE.CANCEL,{room:'test',origin:ids[0].did,requestId:call.id,requestHash:await sha256hex(utf8(canonicalize(call)))});
   receive({env:cancel,carrier});expect(rpc.stats().active).toBe(0);
  }
  expect(rpc.stats().serving).toBe(16);
  receive({env:await sign(TYPE.CALL,{room:'test',path:ids.map(x=>x.did),request:{kind:'chunk',hash}}),carrier});
  await until(()=>rpc.stats().active===0);expect(release).toHaveLength(16);
  release.forEach(done=>done());await until(()=>rpc.stats().serving===0);
 }finally{release.forEach(done=>done());rpc.close();}
});

test('a full next batch can arrive while the previous ACK transport still drains',async()=>{
 const bytes=Uint8Array.from({length:65537},(_,i)=>i%253);
 const f=await fixture(async()=>bytes,{delayAckMs:50});try{
  expect(await f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal)).toEqual(bytes);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
 }finally{f.close();}
});

test('bounded authenticated reordering preserves a full chunk without changing its bytes',async()=>{
 const bytes=Uint8Array.from({length:262144},(_,i)=>i%251);
 const f=await fixture(async()=>bytes,{reorderParts:true});try{
  expect(await f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal)).toEqual(bytes);
  await until(()=>f.rpcs.every(r=>r.stats().active===0));
 }finally{f.close();}
});
test('duplicate queued parts and offsets beyond one batch retire the request',async()=>{
 for(const mode of ['duplicate','distant']){
  const f=await fixture(async()=>new Uint8Array(65536),{dropParts:true});try{
   const result=f.rpcs[0].retrieve(f.path,{kind:'chunk',hash},new AbortController().signal).catch(error=>error);
   await until(()=>f.frames.filter(x=>x.env.typ===TYPE.PART).length===16);
   const original=f.frames.find(x=>x.env.typ===TYPE.PART&&x.env.body.part.offset===1024)!.env;
   const frame=mode==='duplicate'?original:await signEnvelope(buildEnvelope({...original,id:crypto.randomUUID(),
    body:{...original.body,part:{...original.body.part,offset:16384}}}),f.ids[3]);
   await f.pairs[0][1].send(frame);
   if(mode==='duplicate')await f.pairs[0][1].send(frame);
   expect(await result).toBeInstanceOf(Error);
   await until(()=>f.rpcs.every(r=>r.stats().active===0));
  }finally{f.close();}
 }
});
