import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {ROUTED_RETRIEVAL} from '../../extension/peerd-distributed/transport/capabilities.js';
import {createRetrievalClient} from '../../extension/peerd-distributed/transport/retrieval-client.js';
import {createRetrievalRpc} from '../../extension/peerd-distributed/transport/retrieval-rpc.js';
import {createRoutedContentReader,createRoutedContentChannel} from '../../extension/peerd-distributed/content/routed.js';
import {createContentServiceBudget} from '../../extension/peerd-distributed/content/service-budget.js';
import {createContentStore} from '../../extension/peerd-distributed/content/store.js';
import {buildManifest} from '../../extension/peerd-distributed/content/manifest.js';
import {swarmFetch} from '../../extension/peerd-distributed/content/swarm.js';
import {formatPeerdUri} from '../../extension/peerd-distributed/content/uri.js';
import {utf8} from '../../extension/shared/bundle/bytes.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,5));expect(check()).toBe(true);};
test('routed reader preserves announce revocation and holds the shared service budget through transfer lifetime',async()=>{
 const identity=await generateIdentity(),store=createContentStore(),budget=createContentServiceBudget({total:1,perLink:1});
 const bundle=await buildManifest({identity,payload:utf8('hello'),type:'app',entry:'index.html'});store.publish(bundle);
 const read=createRoutedContentReader({store,budget}),ac=new AbortController();
 expect(await read({kind:'chunk',hash:bundle.manifest.chunks[0].hash},ac.signal)).toEqual(bundle.chunks[0]);
 expect(budget.stats().active).toBe(1);
 await expect(read({kind:'manifest',hash:bundle.hash},new AbortController().signal)).rejects.toThrow();
 ac.abort();await until(()=>budget.stats().active===0);store.unannounce(bundle.hash);
 for(const [kind,hash] of [['manifest',bundle.hash],['chunk',bundle.manifest.chunks[0].hash]] as const){
  const life=new AbortController();expect(await read({kind,hash},life.signal)).toBeNull();life.abort();await until(()=>budget.stats().active===0);
 }
});
test('real signed routed transport feeds the unchanged swarm verifier across an intermediate peer',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'content',budget:2}));
 const stores=ids.map(()=>createContentStore()),budget=createContentServiceBudget();
 const payload=Uint8Array.from({length:800000},(_,i)=>i%251);
 const bundle=await buildManifest({identity:ids[2],payload,type:'app',entry:'index.html'});stores[2].publish(bundle);
 for(let i=0;i<2;i++){
  const pair=memoryPair(),sessions=await Promise.all([0,1].map(j=>createSession({identity:ids[i+j],channel:pair[j],caps:[ROUTED_RETRIEVAL]})));
  for(const j of [0,1])meshes[i+j].addLink(pair[j],sessions[j].remoteDid,{caps:sessions[j].remoteCaps});
 }
 const rpcs=meshes.map((mesh,i)=>createRetrievalRpc({identity:ids[i],roomId:'content',mesh,read:createRoutedContentReader({store:stores[i],budget})}));
 const client=createRetrievalClient({rpc:rpcs[0],routeTo:async()=>ids.map(id=>id.did)});
 try{
  const before=meshes.map(m=>m.peers().map(p=>p.did));
  const result=await swarmFetch({uri:formatPeerdUri({did:ids[2].did,hash:bundle.hash}),providers:[ids[2].did],
   channelFor:()=>createRoutedContentChannel({read:(kind,hash,signal,onPart)=>client.read(ids[2].did,{kind,hash},signal,onPart)})});
  expect(result.payload).toEqual(payload);expect(result.verifiedContributors).toEqual([ids[2].did]);
  expect(meshes.map(m=>m.peers().map(p=>p.did))).toEqual(before);
  await until(()=>budget.stats().active===0&&rpcs.every(r=>r.stats().active===0));
 }finally{client.close();rpcs.forEach(r=>r.close());meshes.forEach(m=>m.close());}
});
test('adapter cannot turn a bad signature or corrupt chunk into a verified swarm result',async()=>{
 const identity=await generateIdentity(),bundle=await buildManifest({identity,payload:utf8('content'),type:'app',entry:'index.html'});
 for(const corrupt of ['manifest','chunk']){
  const channel=createRoutedContentChannel({read:async(kind)=>kind==='manifest'
   ?utf8(JSON.stringify(corrupt==='manifest'?{...bundle.manifest,sig:'AA=='}:bundle.manifest))
   :utf8('corrupt')});
  await expect(swarmFetch({uri:formatPeerdUri({did:identity.did,hash:bundle.hash}),providers:[identity.did],channelFor:()=>channel})).rejects.toThrow();
 }
});
test('closing the adapter or revoking permission prevents a late reply from reaching its client',async()=>{
 let signal:AbortSignal|undefined,release!:(bytes:Uint8Array)=>void;
 let allowed=true,calls=0;
 const channel=createRoutedContentChannel({isAllowed:()=>allowed,read:async(_kind,_hash,s)=>{signal=s;return new Promise(resolve=>{release=resolve;});}});
 channel.setHandler(()=>{calls++;});
 const pending=Promise.resolve(channel.send({t:'CHUNK_REQ',hash:'a'.repeat(64)})).catch(e=>e);
 allowed=false;channel.setHandler(null);expect(signal!.aborted).toBe(true);release(utf8('late'));
 expect(await pending).toBeInstanceOf(Error);expect(calls).toBe(0);
});

test('routed send settles on authenticated progress and retains the last fragment until ACK completion',async()=>{
 let observe!:import('../../extension/peerd-distributed/transport/retrieval-rpc.js').PartObserver;
 let release!:(bytes:Uint8Array)=>void;
 const bytes=Uint8Array.from({length:50000},(_,i)=>i%251),messages:any[]=[];
 const channel=createRoutedContentChannel({read:async(_kind,_hash,_signal,onPart)=>{
  observe=onPart!;return new Promise(resolve=>{release=resolve;});
 }});
 channel.setHandler(message=>{messages.push(message);});
 const sent=Promise.resolve(channel.send({t:'CHUNK_REQ',hash:'a'.repeat(64),requestId:'request'}));
 observe({offset:0,total:bytes.length,bytes:bytes.subarray(0,1024)});await sent;
 expect(messages).toHaveLength(0);
 for(let offset=1024;offset<bytes.length;offset+=1024)observe({offset,total:bytes.length,bytes:bytes.subarray(offset,offset+1024)});
 expect(messages).toHaveLength(1);expect(messages[0].offset).toBe(0);
 release(bytes);await until(()=>messages.length===2);
 expect(messages[1].offset).toBe(48000);expect(messages[1].size).toBe(50000);
 channel.setHandler(null);
});

test('a routed read failure after send completion closes its channel and aborts outstanding work',async()=>{
 let observe!:import('../../extension/peerd-distributed/transport/retrieval-rpc.js').PartObserver;
 let rejectRead!:(error:Error)=>void,signal:AbortSignal|undefined;let closed=0;
 const channel=createRoutedContentChannel({read:async(_kind,_hash,s,onPart)=>{
  signal=s;observe=onPart!;return new Promise((_resolve,reject)=>{rejectRead=reject;});
 }});
 channel.setHandler(()=>{throw new Error('partial bytes must not complete this request');});
 channel.onClose!(()=>{closed++;});
 const sent=Promise.resolve(channel.send({t:'CHUNK_REQ',hash:'a'.repeat(64),requestId:'request'}));
 observe({offset:0,total:50000,bytes:new Uint8Array(1024)});await sent;
 rejectRead(new Error('peer disappeared'));await until(()=>closed===1);expect(signal!.aborted).toBe(true);
 channel.setHandler(null);expect(closed).toBe(1);
});
