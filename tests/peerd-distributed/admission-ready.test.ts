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
for(const rotations of [[true,true],[true,false],[false,true]]){
 test(`signed readiness rejects unproven eviction (${rotations.join(',')})`,async()=>{
  const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
  try{
   const results=await Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],prepareAdmission:()=>({victim:rotations[i]?'did:key:old-peer':null})})));
   expect(results.every(r=>r.status==='rejected')).toBe(true);
  }finally{pair.forEach(c=>c.close());}
 });
}
test('rotation intent is covered by the signed readiness envelope',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();const send=pair[0].send.bind(pair[0]);
 pair[0].send=(msg:any,opts:any)=>send(msg.__t==='ADMISSION_READY'?{...msg,env:{...msg.env,body:{...msg.env.body,victim:'did:key:forged-victim'}}}:msg,opts);
 // Neither honest endpoint requests rotation; signature verification must
 // reject a forged victim before any witness acquisition.
 try{
  const results=await Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],prepareAdmission:()=>({victim:null})})));
  expect(results[1].status).toBe('rejected');
  if(results[1].status==='rejected')expect(results[1].reason.message).toContain('signature');
 }finally{pair.forEach(c=>c.close());}
});

test('reservation expiry during delayed readiness send cancels both handshakes',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);
 const expiry=new Set<()=>void>();
 const timers={setTimeout:(fn:()=>void)=>{expiry.add(fn);return fn;},clearTimeout:(fn:()=>void)=>expiry.delete(fn)};
 const meshes=ids.map(identity=>createRoomMesh({identity,roomId:'expiry',budget:1,sparse:true,timers}));
 const pair=memoryPair();let resume!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const send=pair[0].send.bind(pair[0]);
 pair[0].send=async(msg:any,opts:any)=>{if(msg.__t==='ADMISSION_READY'){entered();await gate;}return send(msg,opts);};
 const tickets:Array<ReturnType<typeof meshes[0]['reserveAdmission']>>=[];
 const result=Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],
  prepareAdmission:did=>{const ticket=meshes[i].reserveAdmission(did,{locallySelected:true});tickets.push(ticket);return ticket;}})));
 try{
  await started;
  for(const expire of [...expiry])expire();
  expect(tickets.every(ticket=>ticket.signal.aborted)).toBe(true);
  resume();
  const results=await result;
  expect(results.every(r=>r.status==='rejected')).toBe(true);
  expect(meshes.every(mesh=>mesh.stats().peerDegree===0)).toBe(true);
 }finally{resume();tickets.forEach(ticket=>ticket.release());pair.forEach(c=>c.close());meshes.forEach(mesh=>mesh.close());}
});

test('an already retired admission cannot advertise readiness',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
 const lifetime=new AbortController();lifetime.abort();let ready=0;
 const send=pair[0].send.bind(pair[0]);pair[0].send=(msg:any,opts:any)=>{if(msg.__t==='ADMISSION_READY')ready++;return send(msg,opts);};
 try{
  const results=await Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],
   prepareAdmission:()=>({victim:null,...(i===0?{signal:lifetime.signal}:{})})})));
  expect(results.every(r=>r.status==='rejected')).toBe(true);expect(ready).toBe(0);
 }finally{pair.forEach(c=>c.close());}
});

test('commit signature binds both readiness plans',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
 const send=pair[0].send.bind(pair[0]);
 pair[0].send=(msg:any,opts:any)=>send(msg.__t==='ADMISSION_COMMIT'?{...msg,env:{...msg.env,id:crypto.randomUUID()}}:msg,opts);
 try{
  const results=await Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY]})));
  expect(results[1].status).toBe('rejected');
  if(results[1].status==='rejected')expect(results[1].reason.message).toContain('commit signature');
 }finally{pair.forEach(c=>c.close());}
});

test('a collected witness retiring during commit send prevents completion',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
 const witness=new AbortController();let resume!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const send=pair[0].send.bind(pair[0]);
 pair[0].send=async(msg:any,opts:any)=>{if(msg.__t==='ADMISSION_COMMIT'){entered();await gate;}return send(msg,opts);};
 const results=Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],
  prepareAdmission:()=>({victim:i===0?'did:key:old-peer':null}),
  commitAdmission:async()=>i===0?{digest:'a'.repeat(64),signal:witness.signal}:null,
 })));
 try{
  await started;witness.abort();resume();
  expect((await results).every(result=>result.status==='rejected')).toBe(true);
 }finally{resume();pair.forEach(c=>c.close());}
});

test('a reservation returned after handshake cancellation is released rather than orphaned',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
 let resume!:()=>void,entered!:()=>void,released=0;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const owner=new AbortController();
 const results=Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],signal:owner.signal,
  prepareAdmission:async()=>{if(i===0){entered();await gate;}return {victim:null,release:()=>{if(i===0)released++;}};},
 })));
 try{
  await started;owner.abort();await results;resume();
  await new Promise(r=>setTimeout(r,0));
  expect(released).toBe(1);
 }finally{resume();pair.forEach(c=>c.close());}
});

test('a witness returned after handshake cancellation is released',async()=>{
 const ids=await Promise.all([generateIdentity(),generateIdentity()]);const pair=memoryPair();
 let resume!:()=>void,entered!:()=>void,released=0;
 const gate=new Promise<void>(r=>resume=r),started=new Promise<void>(r=>entered=r);
 const owner=new AbortController();
 const results=Promise.allSettled(ids.map((identity,i)=>createSession({identity,channel:pair[i],caps:[ADMISSION_READY],signal:owner.signal,
  prepareAdmission:()=>({victim:i===0?'did:key:old-peer':null}),
  commitAdmission:async()=>{if(i!==0)return null;entered();await gate;return {digest:'a'.repeat(64),signal:new AbortController().signal,release:()=>{released++;}};},
 })));
 try{
  await started;owner.abort();await results;resume();
  await new Promise(r=>setTimeout(r,0));
  expect(released).toBe(1);
 }finally{resume();pair.forEach(c=>c.close());}
});
