import {test,expect} from 'bun:test';
import {createDirectoryTraversal} from '../../extension/peerd-distributed/transport/directory-traversal.js';

// Model separate owners on one admitted carrier; releasing a frontier must
// never retire an RPC lease or a different fetch's hold.
function fixture(){
 const counts=new Map<string,number>();
 const lease=(did:string,{signal}:any={})=>{
  counts.set(did,(counts.get(did)??0)+1);let live=true;
  const release=()=>{if(!live)return;live=false;counts.set(did,counts.get(did)!-1);signal?.removeEventListener('abort',release);};
  signal?.addEventListener('abort',release,{once:true});if(signal?.aborted)release();
  return {release};
 };
 const room:any={mesh:{selfDid:'self',peers:()=>[{did:'root'}],hasDirectoryLink:(did:string)=>did==='root'||(counts.get(did)??0)>0,
  hasContentLink:()=>false,acquireDirectoryLink:lease,acquireLookupLink:lease,
  requestRoster:async()=>['a','b','provider']},
  acquireDirectoryVia:async(_broker:string,did:string,options:any)=>lease(did,{signal:options.leaseSignal}),
  acquireContentVia:async(_broker:string,did:string,options:any)=>lease(did,{signal:options.leaseSignal})};
 return {room,counts,lease};
}
test('directory frontier handoff preserves an outstanding RPC and another fetch owner',async()=>{
 const {room,counts}=fixture();const one=createDirectoryTraversal(room);const two=createDirectoryTraversal(room);
 const first=await one.acquireLookup({did:'a',hints:{broker:'root'}},{});
 const second=await two.acquireLookup({did:'a',hints:{broker:'root'}},{});
 const next=await one.acquireLookup({did:'b',hints:{broker:'a'}},{});
 expect(counts.get('a')).toBe(3);one.close();expect(counts.get('a')).toBe(3);
 first.release();expect(counts.get('a')).toBe(2);second.release();two.close();next.release();
 expect([...counts.values()].every(n=>n===0)).toBe(true);
});
test('late introduction completion after cancellation releases its admitted lease',async()=>{
 const {room,counts,lease}=fixture();let finish:any;let started:any;
 const ready=new Promise<void>(r=>started=r);
 room.acquireDirectoryVia=async()=>{started();await new Promise(r=>finish=r);return lease('a');};
 const owner=new AbortController();const traversal=createDirectoryTraversal(room,{signal:owner.signal});
 const pending=traversal.acquireLookup({did:'a',hints:{broker:'root'}},{});
 await ready;owner.abort();finish();await expect(pending).rejects.toThrow();
 expect([...counts.values()].every(n=>n===0)).toBe(true);
 await expect(traversal.acquireLookup({did:'b'},{})).rejects.toThrow();
});
test('per-RPC cancellation preserves the fetch frontier until explicit close',async()=>{
 const {room,counts}=fixture();const traversal=createDirectoryTraversal(room);const rpc=new AbortController();
 await traversal.acquireLookup({did:'a',hints:{broker:'root'}},{signal:rpc.signal});
 expect(counts.get('a')).toBe(2);rpc.abort();expect(counts.get('a')).toBe(1);
 traversal.close();traversal.close();expect([...counts.values()].every(n=>n===0)).toBe(true);
});

test('stale provider referral recovers through current authenticated rosters without leaking holds',async()=>{
 const {room,counts}=fixture();const seen:string[]=[];
 room.mesh.requestRoster=async(did:string)=>{seen.push(did);return did==='root'?['a']:did==='a'?['root','b']:did==='b'?['a','provider']:[];};
 const traversal=createDirectoryTraversal(room);
 const content=await traversal.acquireContent({did:'provider',hints:{broker:'root'}},{});
 expect(seen).toContain('b');expect(counts.get('provider')).toBe(1);
 content.release();traversal.close();expect([...counts.values()].every(n=>n===0)).toBe(true);
});
test('unreachable provider search is bounded even when every roster offers a fresh neighbor',async()=>{
 const {room,counts}=fixture();let queried=0;
 room.mesh.requestRoster=async(did:string)=>{queried++;return [did==='root'?'n1':`n${Number(did.slice(1))+1}`];};
 const traversal=createDirectoryTraversal(room,{onAttempt:()=>{throw new Error('diagnostic sink failed');}});
 await expect(traversal.acquireContent({did:'absent',hints:{broker:'root'}},{})).rejects.toThrow('directory introduction unavailable');
 expect(queried).toBeLessThanOrEqual(129);
 traversal.close();expect([...counts.values()].every(n=>n===0)).toBe(true);
});
