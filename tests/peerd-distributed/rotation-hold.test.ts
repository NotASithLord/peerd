import {test,expect} from 'bun:test';
import {createRoomMesh,MAX_ROTATION_HOLDS,ROTATION_HOLD_MS} from '../../extension/peerd-distributed/transport/mesh.js';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {memoryPair} from '../../extension/peerd-distributed/transport/channel.js';
import {NEIGHBOR_GRACE_MS} from '../../extension/peerd-distributed/transport/neighbor-policy.js';
const fixture=async()=>{
 let now=1,id=0;const callbacks=new Map<number,{at:number,fn:()=>void}>();
 const timers={setTimeout:(fn:()=>void,ms:number)=>{const key=++id;callbacks.set(key,{at:now+ms,fn});return key;},clearTimeout:(key:number)=>callbacks.delete(key)};
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'hold',budget:1,sparse:true,now:()=>now,timers});
 const pair=memoryPair();expect(mesh.addLink(pair[0],'old',{}, {locallySelected:true})).toBe(true);now+=NEIGHBOR_GRACE_MS;
 const advance=(ms:number)=>{now+=ms;for(const [key,entry] of [...callbacks])if(entry.at<=now){callbacks.delete(key);entry.fn();}};
 return {mesh,pair,advance};
};
test('a routing hold prevents eviction until released and does not change the link budget',async()=>{
 const {mesh}=await fixture();try{
  const hold=mesh.holdRoutingLink('old');
  expect(()=>mesh.reserveAdmission('new',{locallySelected:true})).toThrow();
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true})).toBe(false);
  expect(mesh.stats().peerDegree).toBe(1);
  hold.release();hold.release();expect(hold.signal.aborted).toBe(true);
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});ticket.release();
 }finally{mesh.close();}
});
test('sharing a hold does not renew its deadline and expiry releases all owners',async()=>{
 const {mesh,advance}=await fixture();try{
  const first=mesh.holdRoutingLink('old');advance(ROTATION_HOLD_MS-1);
  const second=mesh.holdRoutingLink('old');expect(second.expiresAt).toBe(first.expiresAt);
  first.release();expect(second.signal.aborted).toBe(false);advance(1);
  expect(second.signal.aborted).toBe(true);
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});ticket.release();
 }finally{mesh.close();}
});
test('holds cannot capture a victim already owned by admission',async()=>{
 const {mesh}=await fixture();try{
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});
  expect(()=>mesh.holdRoutingLink('old')).toThrow();ticket.release();
  const hold=mesh.holdRoutingLink('old');hold.release();
 }finally{mesh.close();}
});
test('holds are bounded independently of shared edge count and cancellation releases capacity',async()=>{
 const {mesh}=await fixture();try{
  const owner=new AbortController();const held=Array.from({length:MAX_ROTATION_HOLDS},()=>mesh.holdRoutingLink('old',{signal:owner.signal}));
  expect(()=>mesh.holdRoutingLink('old')).toThrow();owner.abort();
  expect(held.every(h=>h.signal.aborted)).toBe(true);
  const next=mesh.holdRoutingLink('old');next.release();
  expect(()=>mesh.holdRoutingLink('old',{signal:owner.signal})).toThrow();
 }finally{mesh.close();}
});
test('link retirement, replacement and room close invalidate only their owned generation',async()=>{
 for(const action of ['disconnect','replace','close']){
  const {mesh,pair}=await fixture();try{
   const hold=mesh.holdRoutingLink('old');
   if(action==='disconnect')pair[1].close();
   else if(action==='replace')expect(mesh.addLink(memoryPair()[0],'old',{}, {locallySelected:true})).toBe(true);
   else mesh.close();
   expect(hold.signal.aborted).toBe(true);
   if(action==='replace'){
    const fresh=mesh.holdRoutingLink('old');hold.release();expect(fresh.signal.aborted).toBe(false);fresh.release();
   }else expect(()=>mesh.holdRoutingLink('old')).toThrow();
  }finally{mesh.close();}
 }
});

test('expired admission cannot evict a peer when its timer callback is delayed',async()=>{
 const identity=await generateIdentity();let time=1;
 const mesh=createRoomMesh({identity,roomId:'delayed',budget:1,sparse:true,now:()=>time,
  timers:{setTimeout:()=>1,clearTimeout:()=>{}}});
 try{
  mesh.addLink(memoryPair()[0],'old',{}, {locallySelected:true});time+=NEIGHBOR_GRACE_MS;
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});time=ticket.expiresAt;
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true,reservation:ticket})).toBe(false);
  expect(ticket.signal.aborted).toBe(true);expect(mesh.hasLink('old')).toBe(true);
  const hold=mesh.holdRoutingLink('old');hold.release();
 }finally{mesh.close();}
});

test('admission loses its reserved victim when its bound witness is cancelled',async()=>{
 const {mesh}=await fixture();try{
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});
  const owner=new AbortController();
  expect(ticket.bindWitness({signal:owner.signal,validUntil:ticket.expiresAt})).toBe(true);
  expect(ticket.bindWitness({signal:new AbortController().signal,validUntil:ticket.expiresAt})).toBe(false);
  owner.abort();
  expect(ticket.signal.aborted).toBe(true);
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true,reservation:ticket})).toBe(false);
  expect(mesh.hasLink('old')).toBe(true);
 }finally{mesh.close();}
});

test('final admission checks the shorter witness deadline even when timers are delayed',async()=>{
 let time=1;
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'witness-expiry',budget:1,sparse:true,now:()=>time,
  timers:{setTimeout:()=>1,clearTimeout:()=>{}}});
 try{
  mesh.addLink(memoryPair()[0],'old',{}, {locallySelected:true});time+=NEIGHBOR_GRACE_MS;
  const ticket=mesh.reserveAdmission('new',{locallySelected:true});
  expect(ticket.bindWitness({signal:new AbortController().signal,validUntil:time+1})).toBe(true);
  time++;
  expect(time).toBeLessThan(ticket.expiresAt);
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true,reservation:ticket})).toBe(false);
  expect(ticket.signal.aborted).toBe(true);expect(mesh.hasLink('old')).toBe(true);
 }finally{mesh.close();}
});

test('young-edge recovery reservations cannot evict without a live bound witness',async()=>{
 const mesh=createRoomMesh({identity:await generateIdentity(),roomId:'young-proof',budget:1,sparse:true});
 try{
  expect(mesh.addLink(memoryPair()[0],'old',{}, {locallySelected:true})).toBe(true);
  expect(()=>mesh.reserveAdmission('new',{locallySelected:true})).toThrow();
  const ticket=mesh.reserveAdmission('new',{locallySelected:true,requireWitness:true});
  expect(ticket.victim).toBe('old');
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true,reservation:ticket})).toBe(false);
  expect(mesh.hasLink('old')).toBe(true);ticket.release();
  const proved=mesh.reserveAdmission('new',{locallySelected:true,requireWitness:true});
  const witness=new AbortController();
  expect(proved.bindWitness({signal:witness.signal,validUntil:proved.expiresAt})).toBe(true);
  expect(mesh.addLink(memoryPair()[0],'new',{}, {locallySelected:true,reservation:proved})).toBe(true);
  // A live proof never exempts recovery from the room's rotation rate limit.
  expect(()=>mesh.reserveAdmission('another',{locallySelected:true,requireWitness:true})).toThrow();
 }finally{mesh.close();}
});
