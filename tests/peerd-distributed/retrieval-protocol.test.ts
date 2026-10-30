import {test,expect} from 'bun:test';
import {generateIdentity} from '../../extension/peerd-distributed/identity/keypair.js';
import {RETRIEVAL_CHANNEL,RETRIEVAL_TYPES} from '../../extension/peerd-distributed/transport/capabilities.js';
import {MAX_ROUTING_PATH_NODES} from '../../extension/peerd-distributed/transport/routing-path-holds.js';
import {buildEnvelope,envelopeBytes,signEnvelope} from '../../extension/peerd-distributed/transport/envelope.js';
import {toBase64} from '../../extension/shared/bundle/bytes.js';
import {validRetrievalCall,validRetrievalPart,createRetrievalReply,retrievalReplyLimit,
 RETRIEVAL_PART_BYTES,RETRIEVAL_FRAME_BYTES} from '../../extension/peerd-distributed/transport/retrieval-protocol.js';

const hash='a'.repeat(64);
test('retrieval requests grant only fixed-path immutable reads',async()=>{
 const ids=await Promise.all(Array.from({length:3},()=>generateIdentity()));
 const body={room:'test',path:ids.map(id=>id.did),request:{kind:'providers',hash}};
 expect(validRetrievalCall(body,'test',ids[0].did)).toBe(true);
 for(const kind of ['manifest','chunk'])expect(validRetrievalCall({...body,request:{kind,hash}},'test',ids[0].did)).toBe(true);
 for(const changed of [
  {...body,room:'another'}, {...body,path:[ids[0].did]}, {...body,path:[ids[0].did,ids[0].did]},
  {...body,path:[ids[0].did,'invalid']}, {...body,path:[ids[1].did,ids[0].did]},
  {...body,request:{kind:'STORE',hash}}, {...body,request:{kind:'hold',hash}},
  {...body,request:{kind:'signal',hash}}, {...body,request:{kind:'__proto__',hash}},
  {...body,request:{kind:'chunk',hash,url:'https://example.test'}},
  {...body,request:{kind:'chunk',hash:hash.toUpperCase()}}, {...body,extra:true},
 ])expect(validRetrievalCall(changed,'test',ids[0].did)).toBe(false);
});

test('maximum fixed path request and one response part fit the small frame budget',async()=>{
 const ids=await Promise.all(Array.from({length:MAX_ROUTING_PATH_NODES+1},()=>generateIdentity()));
 const body={room:'peerd/base/1',path:ids.slice(0,-1).map(id=>id.did),request:{kind:'chunk',hash}};
 expect(validRetrievalCall(body,body.room,ids[0].did)).toBe(true);
 expect(validRetrievalCall({...body,path:ids.map(id=>id.did)},body.room,ids[0].did)).toBe(false);
 const frame=await signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,typ:RETRIEVAL_TYPES.CALL,from:ids[0].did,id:crypto.randomUUID(),ts:Date.now(),body}),ids[0]);
 expect(envelopeBytes(frame)).toBeLessThanOrEqual(RETRIEVAL_FRAME_BYTES);
 const part={offset:0,total:retrievalReplyLimit('chunk'),data:toBase64(new Uint8Array(RETRIEVAL_PART_BYTES))};
 const reply={...frame,body:{room:body.room,origin:ids[0].did,requestId:frame.id,requestHash:hash,part}};
 expect(envelopeBytes(reply)).toBeLessThanOrEqual(RETRIEVAL_FRAME_BYTES);
});

test('existing manifest and chunk bounds assemble exactly; completion does not allow reuse',()=>{
 for(const kind of ['providers','manifest','chunk'] as const){
  for(const size of [0,1,RETRIEVAL_PART_BYTES,RETRIEVAL_PART_BYTES+1,retrievalReplyLimit(kind)]){
   const expected=Uint8Array.from({length:size},(_,i)=>i%251),owner=createRetrievalReply(kind);
   let result:Uint8Array|null=null;
   for(let offset=0;offset<Math.max(1,size);offset+=RETRIEVAL_PART_BYTES){
    result=owner.accept({offset,total:size,data:toBase64(expected.subarray(offset,offset+RETRIEVAL_PART_BYTES))});
    if(offset+RETRIEVAL_PART_BYTES<size)expect(result).toBeNull();
   }
   expect(result).toEqual(expected);
   expect(()=>owner.accept({offset:0,total:0,data:''})).toThrow();
  }
 }
});

test('malformed parts fail before decode and retire the assembly',()=>{
 const good={offset:0,total:1,data:'AA=='};
 for(const part of [
  {...good,total:retrievalReplyLimit('chunk')+1}, {...good,total:NaN}, {...good,total:-1},
  {...good,offset:0.5}, {...good,offset:1}, {...good,offset:-1}, {...good,data:'AB=='},
  {...good,data:'AA==\n'}, {...good,data:'AAAA'}, {...good,data:'A'.repeat(4096)},
  {...good,total:1025}, {...good,extra:true}, null,
 ]){
  expect(validRetrievalPart(part,'chunk')).toBe(false);
  const owner=createRetrievalReply('chunk');
  expect(()=>owner.accept(part)).toThrow();expect(()=>owner.accept(good)).toThrow();
 }
});

test('gaps, repeats, changed totals and cancellation cannot retain an active assembly',()=>{
 const first={offset:0,total:2049,data:toBase64(new Uint8Array(1024))};
 for(const invalid of [first,{...first,offset:2048,data:'AA=='},{...first,offset:1024,total:2050}]){
  const owner=createRetrievalReply('chunk');expect(owner.accept(first)).toBeNull();
  expect(()=>owner.accept(invalid)).toThrow();
  expect(()=>owner.accept({...first,offset:1024})).toThrow();
 }
 const cancelled=createRetrievalReply('chunk');cancelled.accept(first);cancelled.close();
 expect(()=>cancelled.accept({...first,offset:1024})).toThrow();
});
