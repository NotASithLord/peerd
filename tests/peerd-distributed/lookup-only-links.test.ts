import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair,createBufferedChannel} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession} from '../../extension/peerd-distributed/transport/session.js';
import {LOOKUP_ONLY,CONTENT_ONLY} from '../../extension/peerd-distributed/transport/capabilities.js';

for(const hostile of ['content','gossip','roster','disguised-content']) test(`lookup carrier verifies directory envelopes and rejects ${hostile}`,async()=>{
 const identities=await Promise.all([generateIdentity(),generateIdentity()]);
 const pair=memoryPair();
 const sessions=await Promise.all(identities.map((identity,i)=>createSession({identity,channel:pair[i],caps:[LOOKUP_ONLY]})));
 const meshes=identities.map(identity=>createRoomMesh({identity,roomId:'r',budget:3,transferSlots:1}));
 const received:any[]=[];
 let served=0;
 meshes[1].serveContent({getManifest(){served++;return null;}});
 meshes[1].onEnvelope(value=>received.push(value));
 try{
  for(let i=0;i<2;i++) expect(meshes[i].addLink(pair[i],sessions[i].remoteDid,{caps:sessions[i].remoteCaps},{purpose:'lookup'})).toBe(true);
  const lease=meshes[0].acquireLookupLink(identities[1].did);
  expect(meshes[0].peers()).toHaveLength(0);
  expect(meshes[0].contentChannel(identities[1].did)).toBeNull();
  expect(()=>meshes[0].acquireContentLink(identities[1].did)).toThrow();
  const query=await meshes[0].sign(1,0,{reqId:'r',msg:{t:'GET_PROVIDERS',key:'a'.repeat(64)}});
  expect(await meshes[0].send(identities[1].did,query)).toBe(false);
  expect(await meshes[0].sendLookup(identities[1].did,query)).toBe(true);
  for(let i=0;i<30&&!received.length;i++)await new Promise(r=>setTimeout(r,1));
  expect(received).toHaveLength(1);expect(received[0].purpose).toBe('lookup');
  const bad=hostile==='content'?{t:'MANIFEST_REQ',hash:'a'.repeat(64)}:hostile==='disguised-content'?{ch:1,typ:0,t:'MANIFEST_REQ',hash:'a'.repeat(64)}:await meshes[0].sign(hostile==='gossip'?4:0,0,{});
  await pair[0].send(bad);
  await new Promise(r=>setTimeout(r,0));
  expect(pair[1].isClosed()).toBe(true);expect(served).toBe(0);expect(received).toHaveLength(1);
  lease.release();
 }finally{meshes.forEach(mesh=>mesh.close());}
});

test('lookup and content share reserved capacity, and lookup lease release retires only its carrier',async()=>{
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'r',budget:3,transferSlots:1});
 const channel=()=>createBufferedChannel({send(){}});
 try{
  expect(mesh.addLink(channel(),'lookup',{caps:[LOOKUP_ONLY]},{purpose:'lookup'})).toBe(true);
  expect(mesh.addLink(channel(),'content',{caps:[CONTENT_ONLY]},{purpose:'content'})).toBe(false);
  expect(mesh.addLink(channel(),'route')).toBe(true);
  const lease=mesh.acquireLookupLink('lookup');lease.release();lease.release();
  expect(mesh.hasLookupLink('lookup')).toBe(false);expect(mesh.hasLink('route')).toBe(true);
  expect(mesh.addLink(channel(),'content',{caps:[CONTENT_ONLY]},{purpose:'content'})).toBe(true);
  expect(mesh.hasLookupLink('content')).toBe(false);
 }finally{mesh.close();}
});
