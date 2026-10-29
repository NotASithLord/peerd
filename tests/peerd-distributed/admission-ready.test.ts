import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {createSession,ADMISSION_READY} from '../../extension/peerd-distributed/transport/session.js';
import {createRoomMesh} from '../../extension/peerd-distributed/transport/mesh.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';

test('signed readiness refuses an asymmetric replacement before either healthy edge is evicted',async()=>{
 const ids=await Promise.all(Array.from({length:4},()=>generateIdentity()));let now=1;
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'ready',budget:1,sparse:true,now:()=>now}));
 const seed=(a:number,b:number)=>{const pair=memoryPair();expect(meshes[a].addLink(pair[0],ids[b].did,{}, {locallySelected:true})).toBe(true);expect(meshes[b].addLink(pair[1],ids[a].did,{}, {locallySelected:true})).toBe(true);};
 const tickets:Array<{release:()=>void}|undefined>=[];
 try{
  seed(0,2);now+=NEIGHBOR_GRACE_MS;seed(1,3);
  const pair=memoryPair();const results=await Promise.allSettled([0,1].map(i=>createSession({identity:ids[i],channel:pair[i],caps:[ADMISSION_READY],
   prepareAdmission:did=>{tickets[i]=meshes[i].reserveAdmission(did,{locallySelected:true});}})));
  expect(results.every(r=>r.status==='rejected')).toBe(true);
  expect(meshes[0].hasLink(ids[2].did)).toBe(true);expect(meshes[1].hasLink(ids[3].did)).toBe(true);
 }finally{tickets.forEach(t=>t?.release());meshes.forEach(mesh=>mesh.close());}
});
test('mutual readiness waits for both local admission decisions before completing',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>entered=r);let finished=0;
 const sessions=ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],prepareAdmission:async()=>{if(i===1){entered();await gate;}}}).then(s=>{finished++;return s;}));
 try{await started;await new Promise(r=>setTimeout(r,0));expect(finished).toBe(0);release();await Promise.all(sessions);expect(finished).toBe(2);}
 finally{pair.forEach(c=>c.close());}
});
test('a valid readiness signature from another session cannot authorize this carrier',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);let recorded:any;
 const first=memoryPair();const original=first[0].send.bind(first[0]);
 first[0].send=(msg:any,opts:any)=>{if(msg.__t==='ADMISSION_READY')recorded=structuredClone(msg);return original(msg,opts);};
 await Promise.all(ids.map((identity,i)=>createSession({identity,channel:first[i],caps:[ADMISSION_READY]})));first.forEach(c=>c.close());
 expect(recorded).toBeDefined();const second=memoryPair();const send=second[0].send.bind(second[0]);
 second[0].send=(msg:any,opts:any)=>send(msg.__t==='ADMISSION_READY'?recorded:msg,opts);
 try{const results=await Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:second[i],caps:[ADMISSION_READY]})));
  expect(results[1].status).toBe('rejected');
  if(results[1].status==='rejected')expect(results[1].reason.message).toContain('does not match this channel');
 }finally{second.forEach(c=>c.close());}
});
