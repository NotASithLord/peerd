// Deterministic protocol diagnostic. Run with Bun; failure is a release blocker,
// not an expected passing assertion. No rendezvous, native ICE or wire shortcuts.
import assert from 'node:assert/strict';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {importIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {joinRoom} from '../../extension/peerd-distributed/transport/rooms.js';
import {makeDhtDialer} from '../../extension/peerd-distributed/transport/dht-dialer.js';
import {createBaseNetwork} from '../../extension/peerd-distributed/base-network.js';

// Public deterministic fixture identities, never production keys.
const identities=await Promise.all(Array.from({length:5},async(_,i)=>{
 const seed=new Uint8Array(32).fill(i+1);
 const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
 const publicKey=new Uint8Array(createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32));
 return importIdentity({seed,publicKey});
}));
const index=did=>identities.findIndex(identity=>identity.did===did);
const pending=new Map();let next=0;
const events=[];
const transport={
 async connect(_peer,{signaling}){const pair=memoryPair();const id=String(++next);pending.set(id,pair[1]);await signaling.send({type:'offer',sdp:id});return pair[0];},
 async accept({offer}){const channel=pending.get(offer.sdp);pending.delete(offer.sdp);return {channel};}
};
const reserve=process.argv.includes('--handoff')?2:1;
const rooms=await Promise.all(identities.map((identity,i)=>joinRoom({identity,roomId:'fixed-chain',url:null,transport,budget:(i===0||i===4?1:2)+reserve,transferSlots:reserve})));
const bases=await Promise.all(rooms.map((room,i)=>{
 const dial=makeDhtDialer(room);
 for(const kind of ['acquireLookup','acquireContent']){
  const acquire=dial[kind];
  dial[kind]=async(contact,options)=>{
   const event={node:i,kind,target:index(contact.did),brokers:[...new Set([contact.hints?.broker,...(contact.brokers??[])])].filter(Boolean).map(index)};
   try{const lease=await acquire(contact,options);events.push({...event,ok:true});return lease;}
   catch(error){events.push({...event,ok:false,reason:error.message});throw error;}
  };
 }
 return createBaseNetwork({identity:identities[i],mesh:room.mesh,dial});
}));
const report={ok:false,topology:'0-1-2-3-4',reserve,events};
try{
 for(let i=0;i<4;i++){
  const pair=memoryPair();
  const sessions=await Promise.all([0,1].map(j=>createSession({identity:identities[i+j],channel:pair[j]})));
  for(let j=0;j<2;j++)rooms[i+j].mesh.addLink(pair[j],sessions[j].remoteDid,{caps:sessions[j].remoteCaps});
  await bases[i].node.dht.learn(identities[i+1].did);await bases[i+1].node.dht.learn(identities[i].did);
 }
 report.before=rooms.map(room=>room.mesh.peers().map(peer=>index(peer.did)));
 assert.deepEqual(report.before,[[1],[0,2],[1,3],[2,4],[3]]);
 const app=await bases[4].publishApp({name:'chain',entry:'index.html',files:{'index.html':'fixed chain verified payload'}});
 await bases[4].announceProvider(app.uri);
 const original=await bases[4].fetchApp(app.uri);
 const fetched=await bases[0].fetchApp(app.uri);
 assert.deepEqual(fetched.payload,original.payload);
 assert.equal(fetched.manifest.publisher,identities[4].did);
 assert(rooms.every(room=>room.mesh.stats().transferDegree===0));
 report.ok=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
 report.after=rooms.map(room=>({peers:room.mesh.peers().map(peer=>index(peer.did)),temporary:room.mesh.stats().transferDegree,total:room.mesh.stats().totalDegree}));
 bases.forEach(base=>base.close());rooms.forEach(room=>room.leave());
 console.log(JSON.stringify(report,null,2));
}
