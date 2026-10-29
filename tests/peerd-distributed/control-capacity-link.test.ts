import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {createRoomMesh,CTRL} from '../../extension/peerd-distributed/transport/mesh.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {buildEnvelope,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {CONTROL_BURST,CONTROL_WAITERS} from '../../extension/peerd-distributed/transport/control-pacer.js';

test('local control queue overflow fails its send without dropping the link or other queued owners',async()=>{
 const [self,peer]=await Promise.all([generateIdentity(),generateIdentity()]);
 const mesh=createRoomMesh({identity:self,roomId:'capacity',now:()=>0});const pair=memoryPair();
 const owner=new AbortController();const pending:Promise<boolean>[]=[];
 try{
  expect(mesh.addLink(pair[0],peer.did)).toBe(true);
  for(let i=0;i<CONTROL_BURST;i++)expect(await mesh.send(peer.did,{ch:0})).toBe(true);
  for(let i=0;i<CONTROL_WAITERS;i++)pending.push(mesh.send(peer.did,{ch:0},{signal:owner.signal}));
  expect(await mesh.send(peer.did,{ch:0})).toBe(false);
  expect(mesh.hasLink(peer.did)).toBe(true);
  expect(pair[0].isClosed()).toBe(false);
  owner.abort();expect((await Promise.all(pending)).every(value=>value===false)).toBe(true);
  expect(mesh.hasLink(peer.did)).toBe(true);
  expect(await mesh.send(peer.did,{ch:4})).toBe(true);
 }finally{owner.abort();mesh.close();pair[1].close();await Promise.all(pending);}
});

test('a real transport send failure still retires the failed carrier',async()=>{
 const [self,peer]=await Promise.all([generateIdentity(),generateIdentity()]);
 const mesh=createRoomMesh({identity:self,roomId:'capacity'});const pair=memoryPair();
 try{
  expect(mesh.addLink(pair[0],peer.did)).toBe(true);
  pair[0].send=()=>{throw new Error('native send failed');};
  expect(await mesh.send(peer.did,{ch:4})).toBe(false);
  expect(mesh.hasLink(peer.did)).toBe(false);
 }finally{mesh.close();pair[1].close();}
});

test('an authenticated inbound request cannot close a healthy carrier when its response queue is full',async()=>{
 const [self,peer]=await Promise.all([generateIdentity(),generateIdentity()]);
 const mesh=createRoomMesh({identity:self,roomId:'capacity',now:()=>0});const pair=memoryPair();
 pair[1].setHandler(()=>{});const owner=new AbortController();const pending:Promise<boolean>[]=[];
 try{
  expect(mesh.addLink(pair[0],peer.did)).toBe(true);
  for(let i=0;i<CONTROL_BURST;i++)expect(await mesh.send(peer.did,{ch:0})).toBe(true);
  for(let i=0;i<CONTROL_WAITERS;i++)pending.push(mesh.send(peer.did,{ch:0},{signal:owner.signal}));
  const ping=await signEnvelope(buildEnvelope({ch:0,typ:CTRL.PING,from:peer.did,body:{nonce:'capacity'},id:crypto.randomUUID(),ts:0}),peer);
  await pair[1].send(ping);
  for(let i=0;i<100&&!mesh.stats().sends.other.failed;i++)await new Promise(resolve=>setTimeout(resolve,1));
  expect(mesh.stats().sends.other.failed).toBe(1);
  expect(mesh.hasLink(peer.did)).toBe(true);
  owner.abort();await Promise.all(pending);
  expect(await mesh.send(peer.did,{ch:4})).toBe(true);
 }finally{owner.abort();mesh.close();pair[1].close();await Promise.all(pending);}
});
