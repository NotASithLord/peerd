import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {DIRECTORY_INTRODUCTIONS} from '../../extension/peerd-distributed/transport/directory-introductions.js';

test('directory carriers relay only correlated temporary introductions without joining routing membership',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity(),generateIdentity()]);
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'r',budget:3,transferSlots:1}));
 const directory=memoryPair();const routing=memoryPair();
 const link=async(pair:ReturnType<typeof memoryPair>,a:number,b:number,purpose:'directory'|'routing')=>{
  const caps=purpose==='directory'?[DIRECTORY_INTRODUCTIONS]:[];
  const sessions=await Promise.all([a,b].map((i,j)=>createSession({identity:ids[i],channel:pair[j],caps})));
  for(const [j,i]of [a,b].entries())expect(meshes[i].addLink(pair[j],sessions[j].remoteDid,{caps:sessions[j].remoteCaps},{purpose})).toBe(true);
 };
 const received:any[]=[];const replies:any[]=[];
 try{
  await link(directory,0,1,'directory');await link(routing,1,2,'routing');
  meshes[2].onRelay(async ({env})=>{
   received.push(env);
   await meshes[2].relay(ids[1].did,ids[0].did,'answer',env.body.sid,{type:'answer',sdp:'answer'});
  });
  meshes[0].onRelay(({env})=>replies.push(env));
  expect(await meshes[0].requestRoster(ids[1].did)).toContain(ids[2].did);
  expect(meshes[1].peers().map(p=>p.did)).toEqual([ids[2].did]);
  expect(meshes[0].hasLink(ids[1].did)).toBe(false);
  expect(meshes[0].contentChannel(ids[1].did)).toBeNull();
  await expect(meshes[0].relay(ids[1].did,ids[2].did,'offer','routing',{type:'offer',sdp:'offer',purpose:'routing'})).rejects.toThrow('no link');
  await meshes[0].relay(ids[1].did,ids[2].did,'offer','temporary',{type:'offer',sdp:'offer',purpose:'content'});
  for(let i=0;i<50&&!replies.length;i++)await new Promise(r=>setTimeout(r,1));
  expect(received).toHaveLength(1);expect(replies).toHaveLength(1);
  expect(received[0].from).toBe(ids[0].did);expect(replies[0].from).toBe(ids[2].did);
  await meshes[2].relay(ids[1].did,ids[0].did,'answer','unsolicited',{type:'answer',sdp:'answer'});
  await new Promise(r=>setTimeout(r,0));expect(replies).toHaveLength(1);
  await directory[0].send(await meshes[0].sign(4,0,{value:'forbidden'}));
  await new Promise(r=>setTimeout(r,0));expect(directory[1].isClosed()).toBe(true);
 }finally{meshes.forEach(mesh=>mesh.close());}
});
