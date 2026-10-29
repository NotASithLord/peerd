// Release diagnostic: a refused candidate must not cost an established edge.
// Uses authenticated sessions and a deterministic clock; no native ICE required.
import assert from 'node:assert/strict';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
const identities=await Promise.all(Array.from({length:4},()=>generateIdentity()));
let now=1;
const events=[];
const meshes=identities.map((identity,node)=>createRoomMesh({identity,roomId:'asymmetric-admission',budget:1,sparse:true,now:()=>now,
 audit:(event,data)=>{if(['peer_link_closed','peer_budget_refused'].includes(event))events.push({node,event,reason:data.why??'admission'});}}));
const connect=async(a,b)=>{
 const pair=memoryPair();const sessions=await Promise.all([a,b].map((i,j)=>createSession({identity:identities[i],channel:pair[j]})));
 return [meshes[a].addLink(pair[0],sessions[0].remoteDid,{caps:sessions[0].remoteCaps},{locallySelected:true}),
 meshes[b].addLink(pair[1],sessions[1].remoteDid,{caps:sessions[1].remoteCaps},{locallySelected:true})];
};
const result={ok:false,events};
try{
 assert.deepEqual(await connect(0,2),[true,true]);
 now+=NEIGHBOR_GRACE_MS;
 assert.deepEqual(await connect(1,3),[true,true]);
 result.candidateAdmission=await connect(0,1);
 await new Promise(resolve=>setTimeout(resolve,0));
 result.degrees=meshes.map(mesh=>mesh.stats().peerDegree);
 result.originalEdgePreserved=meshes[0].hasLink(identities[2].did);
 assert(result.originalEdgePreserved,'remote candidate refusal discarded the established edge');
 result.ok=true;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{meshes.forEach(mesh=>mesh.close());console.log(JSON.stringify(result,null,2));}
