import {expect,test} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair,createBufferedChannel} from '../../extension/peerd-distributed/transport/channel.js';
import {joinRoom} from '../../extension/peerd-distributed/transport/rooms.js';
import {createAdmissionGovernor} from '../../extension/peerd-distributed/transport/admission.js';
import {createChannelClient} from '../../extension/peerd-distributed/content/transfer.js';

test('signed relay purpose and HELLO admit a content carrier while routing slots are full', async()=>{
 const identities=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const pending=new Map<string,ReturnType<typeof memoryPair>[number]>();
 let next=0; const channels:ReturnType<typeof memoryPair>[number][]=[];
 const transport={
  async connect(_peer:any,{signaling}:any){const pair=memoryPair();channels.push(...pair);const id=String(++next);pending.set(id,pair[1]);await signaling.send({type:'offer',sdp:id});return pair[0];},
  async accept({offer}:any){const channel=pending.get(offer.sdp);pending.delete(offer.sdp);return {channel};}
 };
 const admission=createAdmissionGovernor();
 const rooms=await Promise.all(identities.map(identity=>joinRoom({identity,roomId:'r',url:null,transport,admission,budget:3,transferSlots:1})));
 try {
  for(const i of [0,1]) {const pair=memoryPair();channels.push(...pair);rooms[i].mesh.addLink(pair[0],identities[2].did);rooms[2].mesh.addLink(pair[1],identities[i].did);rooms[i].mesh.addLink(createBufferedChannel({send(){}}),'routing-filler');}
  rooms[1].mesh.serveContent({getManifest:()=>null});
  const leases=await Promise.all([rooms[0].acquireContentVia(identities[2].did,identities[1].did),rooms[0].acquireContentVia(identities[2].did,identities[1].did)]);
  // A sender's completion precedes the remote continuation. Await actual
  // authenticated admission, not a guessed sleep or a fake response.
  for(let i=0;i<100&&!rooms[1].mesh.hasContentLink(identities[0].did);i++) await new Promise(r=>setTimeout(r,1));
  for(const i of [0,1]) {expect(rooms[i].mesh.stats().totalDegree).toBe(3);expect(rooms[i].mesh.stats().peerDegree).toBe(2);expect(rooms[i].mesh.hasLink(identities[1-i].did)).toBe(false);}
  await rooms[0].dialVia(identities[2].did,identities[1].did,{purpose:'content'});
  expect(next).toBe(1); // reuse the established carrier without replacing owners
  const client=createChannelClient(rooms[0].mesh.contentChannel(identities[1].did)!,500);
  try{expect((await client.manifest('a'.repeat(64))).t).toBe('NOMANIFEST');}finally{client.close();}
  expect(admission.stats().active).toBe(0);
  leases[0].release();expect(rooms[0].mesh.hasContentLink(identities[1].did)).toBe(true);
  leases[1].release();expect(rooms[0].mesh.hasContentLink(identities[1].did)).toBe(false);
 } finally {rooms.forEach(r=>r.leave());channels.forEach(c=>c.close());}
});

import {createBaseNetwork} from '../../extension/peerd-distributed/base-network.js';
import {makeDhtDialer} from '../../extension/peerd-distributed/transport/dht-dialer.js';

for (const cancel of [false, true]) test(`actual provider fetch releases its temporary carrier after ${cancel ? 'caller cancellation' : 'verified transfer'}`,async()=>{
 const identities=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const pending=new Map<string,ReturnType<typeof memoryPair>[number]>();let next=0;
 const transport={
  async connect(_peer:any,{signaling}:any){const pair=memoryPair();const id=String(++next);pending.set(id,pair[1]);await signaling.send({type:'offer',sdp:id});return pair[0];},
  async accept({offer}:any){const channel=pending.get(offer.sdp);pending.delete(offer.sdp);return {channel};}
 };
 const rooms=await Promise.all(identities.map((identity,i)=>joinRoom({identity,roomId:'provider',url:null,transport,budget:i===2?3:2,transferSlots:i===2?0:1})));
 const bases=await Promise.all(rooms.map((room,i)=>createBaseNetwork({identity:identities[i],mesh:room.mesh,dial:makeDhtDialer(room)})));
 try {
  for(const i of [0,1]) {const pair=memoryPair();rooms[i].mesh.addLink(pair[0],identities[2].did);rooms[2].mesh.addLink(pair[1],identities[i].did);await bases[i].node.dht.learn(identities[2].did);await bases[2].node.dht.learn(identities[i].did);}
  const app=await bases[1].publishApp({name:'bounded transfer',entry:'index.html',files:{'index.html':'verified'.repeat(20000)}});
  await bases[1].announceProvider(app.uri);
  bases[2].node.dht.routingTable.remove(identities[1].did);
  const controller=new AbortController();
  let cancelledDuringTransfer=false;
  const result=await bases[0].fetchApp(app.uri,{
   timeoutMs:1000, signal:controller.signal,
   onProgress(progress){
    if(cancel && progress.phase==='manifest' && progress.publisher){
     expect(rooms[0].mesh.stats().transferDegree).toBe(1);
     cancelledDuringTransfer=true;
     controller.abort(new Error('caller stopped transfer'));
    }
   }
  }).then(value=>({value,error:null}),error=>({value:null,error}));
  if(cancel){
   expect(cancelledDuringTransfer).toBe(true);
   expect(result.error).toBeTruthy();
   expect(result.value).toBeNull();
  }else{
   expect(result.error).toBeNull();
   expect(result.value!.manifest.publisher).toBe(identities[1].did);
  }
  expect(next).toBeGreaterThanOrEqual(1);
  expect(rooms[0].mesh.stats().transferDegree).toBe(0);
  expect(rooms[0].mesh.stats().peerDegree).toBe(1);
  expect(rooms[0].mesh.hasLink(identities[2].did)).toBe(true);
 }finally{bases.forEach(b=>b.close());rooms.forEach(r=>r.leave());}
});

import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {CONTENT_ONLY} from '../../extension/peerd-distributed/transport/capabilities.js';

for (const purpose of ['routing','content'] as const) test(`signed HELLO cannot substitute the opposite role for ${purpose} admission`,async()=>{
 const [local,remote,broker]=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const channels:ReturnType<typeof memoryPair>[number][]=[];
 const sessions:Promise<unknown>[]=[];
 const admission=createAdmissionGovernor();
 const room=await joinRoom({identity:local,roomId:'role-conflict',url:null,budget:3,transferSlots:1,admission,
  transport:{
   async connect(){
    const pair=memoryPair();channels.push(...pair);
    sessions.push(createSession({channel:pair[1],identity:remote,caps:purpose==='content'?['content']:['content',CONTENT_ONLY]}).catch(error=>error));
    return pair[0];
   },
   async accept(){throw new Error('unexpected accept');}
  }
 });
 try{
  room.mesh.addLink(createBufferedChannel({send(){}}),broker.did);
  await expect(room.dialVia(broker.did,remote.did,{purpose})).rejects.toThrow('peer connection purpose mismatch');
  expect(room.mesh.hasLink(remote.did)).toBe(false);
  expect(room.mesh.hasContentLink(remote.did)).toBe(false);
  expect(room.mesh.stats().totalDegree).toBe(1);
  expect(admission.stats().active).toBe(0);
  expect(channels.every(channel=>channel.isClosed?.())).toBe(true);
 }finally{room.leave();channels.forEach(channel=>channel.close());await Promise.all(sessions);}
});
