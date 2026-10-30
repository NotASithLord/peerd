import {expect,test} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {joinRoom} from '../../extension/peerd-distributed/transport/rooms.js';
import {createAdmissionGovernor} from '../../extension/peerd-distributed/transport/admission.js';
import {ROUTING_WITNESS,ROUTED_RETRIEVAL} from '../../extension/peerd-distributed/transport/capabilities.js';
import {makeDhtDialer} from '../../extension/peerd-distributed/transport/dht-dialer.js';
import {createBaseNetwork} from '../../extension/peerd-distributed/base-network.js';

for(const [reserve,closeEndpoints,seeder] of [[0,false,4],[2,false,4],[0,true,4],[0,true,3],[2,true,3]] as const) test(`chain recovery reserve ${reserve}, explicit endpoint control ${closeEndpoints}, seeder ${seeder}`, async()=>{
 let clockOffset=0;const now=()=>Date.now()+clockOffset;
 const identities=await Promise.all(Array.from({length:5},()=>generateIdentity()));
 const pending=new Map<string,ReturnType<typeof memoryPair>[number]>();
 const channels:ReturnType<typeof memoryPair>[number][]=[];let next=0;
 const transport={
  async connect(_peer:any,{signaling}:any){const pair=memoryPair();channels.push(...pair);const id=String(++next);pending.set(id,pair[1]);await signaling.send({type:'offer',sdp:id});return pair[0];},
  async accept({offer}:any){const channel=pending.get(offer.sdp);pending.delete(offer.sdp);return {channel};}
 };
 const rooms=await Promise.all(identities.map(identity=>joinRoom({identity,roomId:'chain-recovery',url:null,
  now,transport,admission:createAdmissionGovernor(),budget:2+reserve,transferSlots:reserve})));
 rooms.forEach(room=>room.mesh.enableSparseAdmission());
 const traces:any[]=[];
 const sanitize=(value:unknown)=>{let text=String(value);identities.forEach((identity,index)=>{text=text.split(identity.did).join(`node${index}`);});return text.replace(/did:key:[A-Za-z0-9]+/g,'[peer]').slice(0,240);};
 const tracedRooms=rooms.map((room,index)=>{const originalDial=room.dialVia.bind(room);return {...room,dialVia:async(broker:any,target:any,options:any)=>{
  const trace:any={source:index,broker:identities.findIndex(v=>v.did===broker),target:identities.findIndex(v=>v.did===target)};
  traces.push(trace);try{const result=await originalDial(broker,target,options);trace.result='returned';return result;}
  catch(error){trace.result='rejected';trace.error=sanitize(error);throw error;}
 }};});
 const bases=await Promise.all(tracedRooms.map((room,i)=>createBaseNetwork({identity:identities[i],mesh:room.mesh,dial:makeDhtDialer(room)})));
 rooms.forEach((room,index)=>room.onPeerGone(detail=>traces.push({goneAt:index,peer:identities.findIndex(v=>v.did===detail.did),reason:detail.why})));
 const edges=[[0,2],[2,3],[3,1],[1,4]];
 try {
  const app=await bases[0].publishApp({name:'chain recovery',entry:'index.html',files:{'index.html':'signed chain payload'}});
  const original=await bases[0].fetchApp(app.uri);
  await bases[seeder].seedApp(original);
  await bases[0].unshareApp({publisher:identities[0].did,hash:app.hash});
  for(const [a,b] of edges){
   const pair=memoryPair();channels.push(...pair);const caps=['content',ROUTING_WITNESS,ROUTED_RETRIEVAL];
   await Promise.all([createSession({channel:pair[0],identity:identities[a],caps}),createSession({channel:pair[1],identity:identities[b],caps})]);
   expect(rooms[a].mesh.addLink(pair[0],identities[b].did,{caps},{locallySelected:true})).toBe(true);
   expect(rooms[b].mesh.addLink(pair[1],identities[a].did,{caps},{locallySelected:true})).toBe(true);
   await bases[a].node.dht.learn(identities[b].did);await bases[b].node.dht.learn(identities[a].did);
  }
  expect(rooms.map(room=>room.mesh.stats().peerDegree)).toEqual([1,2,2,2,1]);
  await bases[seeder].announceProvider(app.uri);
  // Control only: preconnect the known seeder to the reader; this is NOT a route-discovery fix.
  if(closeEndpoints){const a=0,b=4;
   const pair=memoryPair();channels.push(...pair);const caps=['content',ROUTING_WITNESS,ROUTED_RETRIEVAL];
   await Promise.all([createSession({channel:pair[0],identity:identities[a],caps}),createSession({channel:pair[1],identity:identities[b],caps})]);
   expect(rooms[a].mesh.addLink(pair[0],identities[b].did,{caps},{locallySelected:true})).toBe(true);
   expect(rooms[b].mesh.addLink(pair[1],identities[a].did,{caps},{locallySelected:true})).toBe(true);
   await bases[a].node.dht.learn(identities[b].did);await bases[b].node.dht.learn(identities[a].did);
  }
  clockOffset=65_000;
  // Age admission independently of liveness: the clock jump must not pretend
  // that healthy carriers stopped exchanging heartbeat traffic for a minute.
  await Promise.all(rooms.flatMap(room=>room.mesh.peers().map(async peer=>
    room.mesh.send(peer.did,await room.mesh.sign(0,2,{nonce:'aged-live-link'})))));
  for(let i=0;i<100&&rooms.some(room=>room.mesh.peers().some(peer=>peer.lastSeen<now()-1000));i++)await new Promise(resolve=>setTimeout(resolve,5));
  expect(rooms.every(room=>room.mesh.peers().every(peer=>peer.lastSeen>=now()-1000))).toBe(true);
  // Desired recovery contract: success must preserve the existing bridge edges
  // and signed bytes, without enlarging degree or weakening routing witnesses.
  const fetchTraceStart=traces.length;
  const outcome=await bases[0].fetchApp(app.uri).then(value=>({value,error:null}),error=>({value:null,error:String(error.message)}));
  console.log(JSON.stringify({agedMs:clockOffset,reserve,closeEndpoints,seeder,traces,error:sanitize(outcome.error),finalDegrees:rooms.map(room=>room.mesh.stats().totalDegree)}));
  for(const [a,b] of edges){expect(rooms[a].mesh.hasLink(identities[b].did)).toBe(true);expect(rooms[b].mesh.hasLink(identities[a].did)).toBe(true);}
  expect(rooms.every(room=>room.mesh.stats().totalDegree<=2+reserve)).toBe(true);

  expect(traces.slice(fetchTraceStart).filter(trace=>trace.source!==undefined)).toHaveLength(0);
  expect(outcome.error).toBeNull();
  expect(outcome.value?.payload).toEqual(original.payload);
 }finally{bases.forEach(base=>base.close());rooms.forEach(room=>room.leave());channels.forEach(channel=>channel.close());}
},30000);
