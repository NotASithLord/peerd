import {test,expect} from 'bun:test';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {CONTENT_ONLY} from '../../extension/peerd-distributed/transport/capabilities.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
const fixture=async()=>{
 let now=1;const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'reservation',budget:1,sparse:true,now:()=>now});
 const old=memoryPair();expect(mesh.addLink(old[0],'old',{}, {locallySelected:true})).toBe(true);now+=NEIGHBOR_GRACE_MS;
 return {mesh,old};
};
test('refused remote admission releases reservation without retiring the established edge',async()=>{
 const {mesh,old}=await fixture();try{
  const reservation=mesh.reserveAdmission('candidate',{locallySelected:true});
  expect(mesh.hasLink('old')).toBe(true);expect(old[1].isClosed()).toBe(false);
  reservation.release();reservation.release();
  expect(mesh.hasLink('old')).toBe(true);expect(mesh.stats().peerDegree).toBe(1);
 }finally{mesh.close();}
});
test('reservation owns its candidate and local selection and excludes competing admission',async()=>{
 const {mesh}=await fixture();try{
  const reservation=mesh.reserveAdmission('candidate',{locallySelected:true});
  expect(()=>mesh.reserveAdmission('competitor',{locallySelected:true})).toThrow();
  expect(mesh.addLink(memoryPair()[0],'competitor',{}, {locallySelected:true})).toBe(false);
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:false,reservation})).toBe(false);
  expect(mesh.hasLink('old')).toBe(true);
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:true,reservation})).toBe(true);
  expect(mesh.hasLink('old')).toBe(false);expect(mesh.stats().peerDegree).toBe(1);
 }finally{mesh.close();}
});
test('cancelled reservation cannot commit and leaves old admission intact',async()=>{
 const {mesh}=await fixture();try{
  const ac=new AbortController();const reservation=mesh.reserveAdmission('candidate',{locallySelected:true,signal:ac.signal});ac.abort();
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:true,reservation})).toBe(false);
  expect(mesh.hasLink('old')).toBe(true);
  const next=mesh.reserveAdmission('next',{locallySelected:true});next.release();
 }finally{mesh.close();}
});
test('independent free slots can be reserved concurrently without oversubscribing the budget',async()=>{
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'parallel-reservations',budget:2});
 try{
  const a=mesh.reserveAdmission('a',{locallySelected:true});const b=mesh.reserveAdmission('b',{locallySelected:true});
  expect(()=>mesh.reserveAdmission('c',{locallySelected:true})).toThrow();
  expect(mesh.addLink(memoryPair()[0],'outside',{}, {locallySelected:true})).toBe(false);
  expect(mesh.addLink(memoryPair()[0],'b',{}, {locallySelected:true,reservation:b})).toBe(true);
  expect(mesh.addLink(memoryPair()[0],'a',{}, {locallySelected:true,reservation:a})).toBe(true);
  expect(mesh.stats().peerDegree).toBe(2);
 }finally{mesh.close();}
});
test('a readiness reservation excludes competing candidate admission and victim replacement',async()=>{
 const {mesh,old}=await fixture();try{
  const reservation=mesh.reserveAdmission('candidate',{locallySelected:true});
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:true})).toBe(false);
  expect(mesh.addLink(memoryPair()[0],'old',{}, {locallySelected:true})).toBe(false);
  expect(old[1].isClosed()).toBe(false);expect(mesh.hasLink('old')).toBe(true);
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:true,reservation})).toBe(true);
  expect(mesh.stats().peerDegree).toBe(1);
 }finally{mesh.close();}
});

test('temporary content admission cannot claim an identity reserved for routing readiness',async()=>{
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'role-race',budget:3,transferSlots:1});
 try{
  const reservation=mesh.reserveAdmission('candidate',{locallySelected:true});
  expect(mesh.addLink(memoryPair()[0],'candidate',{caps:[CONTENT_ONLY]},{purpose:'content'})).toBe(false);
  expect(mesh.stats().totalDegree).toBe(0);
  expect(mesh.addLink(memoryPair()[0],'candidate',{}, {locallySelected:true,reservation})).toBe(true);
  expect(mesh.stats().peerDegree).toBe(1);
 }finally{mesh.close();}
});

test('pending free slot does not cause a sparse peer to reserve an unnecessary rotation', async () => {
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'pending-free-slot',budget:2,sparse:true});
 try {
  expect(mesh.addLink(memoryPair()[0],'established',{}, {locallySelected:false})).toBe(true);
  const first=mesh.reserveAdmission('first',{locallySelected:true,requireWitness:true});
  expect(first.rotates).toBe(false);
  expect(()=>mesh.reserveAdmission('second',{locallySelected:true,requireWitness:true})).toThrow();
  expect(mesh.hasLink('established')).toBe(true);
  first.release();
  const retry=mesh.reserveAdmission('second',{locallySelected:true,requireWitness:true});
  expect(retry.rotates).toBe(false);
  expect(mesh.addLink(memoryPair()[0],'second',{}, {locallySelected:true,reservation:retry})).toBe(true);
  const full=mesh.reserveAdmission('third',{locallySelected:true,requireWitness:true});
  expect(full.rotates).toBe(true);
  full.release();
 } finally { mesh.close(); }
});

test('isolated sparse peer serializes provisional admissions until its first routing link commits', async () => {
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'isolated-sparse',budget:4,sparse:true});
 try {
  const pending=mesh.reserveAdmission('a',{locallySelected:true});
  expect(()=>mesh.reserveAdmission('b',{locallySelected:true})).toThrow();
  expect(()=>mesh.reserveAdmission('c',{locallySelected:false})).toThrow();
  pending.release();
  const first=mesh.reserveAdmission('first',{locallySelected:true});
  expect(mesh.addLink(memoryPair()[0],'first',{}, {locallySelected:true,reservation:first})).toBe(true);
  const b=mesh.reserveAdmission('b',{locallySelected:true});
  const c=mesh.reserveAdmission('c',{locallySelected:true});
  b.release();c.release();
  expect(mesh.stats().peerDegree).toBe(1);
 } finally { mesh.close(); }
});
