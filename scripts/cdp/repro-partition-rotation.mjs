// Diagnostic: bilateral admission prevents refusal loss, but rotation must also
// preserve overlay reachability. Uses signed sessions and deterministic ages.
import assert from 'node:assert/strict';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {createSession,ADMISSION_READY} from '../../extension/peerd-distributed/transport/session.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
import {ROUTING_WITNESS} from '../../extension/peerd-distributed/transport/capabilities.js';
import {createRoutingPathHolds} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {createRoutingRpc} from '../../extension/peerd-distributed/transport/routing-rpc.js';
import {createRoutingPathSearch} from '../../extension/peerd-distributed/transport/routing-path-search.js';
import {createRoutingWitnesses} from '../../extension/peerd-distributed/transport/routing-witness.js';
const disconnected=process.argv.includes('--disconnected');
const path=process.argv.includes('--path');
assert.ok(!(disconnected&&path),'Select only one topology');
const ids=await Promise.all(Array.from({length:disconnected?6:5},()=>generateIdentity()));
let now=1;
const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'partition-rotation',budget:2,sparse:true,now:()=>now}));
const holds=meshes.map((mesh,i)=>createRoutingPathHolds({identity:ids[i],roomId:'partition-rotation',holdRoutingLink:mesh.holdRoutingLink,now:()=>now}));
const rpc=meshes.map((mesh,i)=>createRoutingRpc({identity:ids[i],roomId:'partition-rotation',mesh,holds:holds[i],now:()=>now}));
const searches=rpc.map((owner,i)=>createRoutingPathSearch({selfDid:ids[i].did,readNeighbors:owner.readNeighbors,now:()=>now}));
const witnesses=rpc.map((owner,i)=>createRoutingWitnesses({identity:ids[i],roomId:'partition-rotation',acquireHop:owner.acquireHop,now:()=>now}));
const snapshot=()=>meshes.map(mesh=>mesh.peers().map(peer=>ids.findIndex(id=>id.did===peer.did)).sort());
const components=graph=>{
 const remaining=new Set(graph.map((_,i)=>i)),groups=[];
 while(remaining.size){const group=[remaining.values().next().value];remaining.delete(group[0]);
  for(let i=0;i<group.length;i++)for(const peer of graph[group[i]])if(remaining.delete(peer))group.push(peer);
  groups.push(group.sort());
 }return groups;
};
const connect=async(a,b)=>{
 const pair=memoryPair(),tickets=[],owned=[];
 try{
  const sessions=await Promise.all([a,b].map((node,i)=>createSession({identity:ids[node],channel:pair[i],caps:[ADMISSION_READY,ROUTING_WITNESS],
   prepareAdmission:did=>{tickets[i]=meshes[node].reserveAdmission(did,{locallySelected:true});return tickets[i];},
   commitAdmission:async({remoteDid,localVictim,remoteVictim,signal})=>{
    if(!localVictim)return null;
    const cuts=[[ids[node].did,localVictim],...(remoteVictim?[[remoteDid,remoteVictim]]:[])];
    const alternate=await searches[node].find({target:localVictim,cuts,signal});
    if(!alternate)throw new Error('no alternate path');
    const witness=await witnesses[node].acquire({candidate:[ids[node].did,remoteDid],cuts,path:[...alternate],signal});
    owned.push(witness);assert.ok(tickets[i].bindWitness(witness));return witness;
   }})));
  return [a,b].map((node,i)=>meshes[node].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps},
   {locallySelected:true,reservation:tickets[i],allowRotation:true}));
 }catch(error){if(String(error.message).includes('no alternate path')||String(error.message).includes('closed during HELLO'))return [false,false];throw error;}finally{tickets.forEach(ticket=>ticket?.release());owned.forEach(witness=>witness.release());}
};
const result={ok:false,topology:disconnected?'two-full-components':path?'connected-path':'connected-ring'};
try{
 // These are the oldest eligible victims at the candidate's two endpoints.
 const edges=disconnected?[[0,1],[1,2],[2,0],[3,4],[4,5],[5,3]]:
  path?[[3,4],[0,1],[1,2],[2,3]]:[[0,1],[2,3],[1,2],[3,4],[4,0]];
 for(const [a,b] of edges){assert.deepEqual(await connect(a,b),[true,true]);now++;}
 result.before=snapshot();assert.equal(components(result.before).length,disconnected?2:1);
 now+=NEIGHBOR_GRACE_MS;
 result.candidateAdmission=await connect(0,3);
 await new Promise(resolve=>setTimeout(resolve,0));
 result.after=snapshot();result.components=components(result.after);
 assert.equal(result.components.length,1,disconnected?'full components still require coordinated repair':path?'single-sided rotation isolated a path endpoint':'bilateral rotation partitioned a connected ring');
 result.ok=true;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{searches.forEach(owner=>owner.close());witnesses.forEach(owner=>owner.close());rpc.forEach(owner=>owner.close());holds.forEach(owner=>owner.close());meshes.forEach(mesh=>mesh.close());console.log(JSON.stringify(result,null,2));}
