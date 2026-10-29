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
