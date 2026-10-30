// @ts-check
import { buildEnvelope, envelopeBytes, signEnvelope } from './envelope.js';
import { RETRIEVAL_CHANNEL, RETRIEVAL_TYPES as TYPE } from './capabilities.js';
import { validRetrievalCall, validRetrievalPart, createRetrievalReply, retrievalReplyLimit,
  RETRIEVAL_FRAME_BYTES, RETRIEVAL_PART_BYTES } from './retrieval-protocol.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, toBase64 } from '/shared/bundle/bytes.js';
import { sha256hex } from '/shared/bundle/chunk.js';

const LIVE_LIMIT=16, REPLAY_LIMIT=128, LIFETIME_MS=60_000, REPLAY_MS=130_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const exact=(/** @type {any} */ x,/** @type {string[]} */ keys)=>x&&typeof x==='object'&&!Array.isArray(x)
  &&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export class RetrievalRpcError extends Error {
  constructor(){super('bounded retrieval unavailable');this.name='RetrievalRpcError';}
}
/** @typedef {import('./routing-rpc.js').Carrier & {noteProgress?:()=>void}} Carrier */
/** @typedef {import('./retrieval-protocol.js').RetrievalKind} Kind */
/** @typedef {{env:any,hash:string,previous:Carrier|null,next:Carrier|null,life:AbortController,
 * expires:number,timer:any,live:boolean,phase:'part'|'ack',offset:number,total:number,sending:boolean,pendingAck?:any,ackSending:boolean,pendingPart?:any,
 * bytes?:Uint8Array,assembly?:ReturnType<typeof createRetrievalReply>,detach:Array<()=>void>,
 * resolve?:(bytes:Uint8Array)=>void,reject?:(error:Error)=>void,pendingCancel?:{env:any,carrier:Carrier}}} State */
/**
 * Mesh verifies signatures; this owner enforces fixed-route custody and endpoint
 * identity. Only immutable bounded reads are exposed. No links are created.
 * why stop-and-wait: each path retains at most one part in flight, independent
 * of hop count or chunk size; ACKs preserve ordinary transport backpressure.
 * @param {{identity:{did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},roomId:string,
 * mesh:{retrievalCarrier:(did:string)=>Carrier|null,onRetrieval:(cb:(event:{env:any,carrier:Carrier})=>void)=>()=>void},
 * read:(request:{kind:Kind,hash:string},signal:AbortSignal)=>Promise<Uint8Array|null>,now?:()=>number,timers?:any,isAllowed?:(did:string)=>boolean}} opts
 */
export const createRetrievalRpc=({identity,roomId,mesh,read,now=Date.now,timers=globalThis,isAllowed=()=>true})=>{
  /** @type {Map<string,State>} */const states=new Map();
  /** @type {Map<string,number>} */const seen=new Map();
  /** @type {Set<Promise<void>>} */const cleanup=new Set();
  let closed=false,originating=0,serving=0,windowStart=now(),requests=0;
  const fail=()=>new RetrievalRpcError();
  const key=(/** @type {string} */ origin,/** @type {string} */ id)=>JSON.stringify([origin,id]);
  const fresh=(/** @type {any} */ env)=>exact(env,['v','ch','typ','from','body','id','ts','sig'])
    &&env.v===1&&env.ch===RETRIEVAL_CHANNEL&&typeof env.from==='string'&&env.from.length<=128
    &&typeof env.id==='string'&&UUID.test(env.id)&&typeof env.sig==='string'&&env.sig.length<=128
    &&Number.isSafeInteger(env.ts)&&Math.abs(now()-env.ts)<=60_000&&envelopeBytes(env)<=RETRIEVAL_FRAME_BYTES;
  const sign=(/** @type {number} */ typ,/** @type {any} */ body)=>signEnvelope(buildEnvelope({ch:RETRIEVAL_CHANNEL,
    typ,body,from:identity.did,id:crypto.randomUUID(),ts:now()}),identity);
  const reference=(/** @type {State} */ state)=>({room:roomId,origin:state.env.from,requestId:state.env.id,requestHash:state.hash});
  /** @param {Carrier|null} carrier @param {any} env @param {AbortSignal} [signal] */
  const send=async(carrier,env,signal)=>{
    if(!carrier||carrier.signal.aborted||signal?.aborted||envelopeBytes(env)>carrier.maxFrameBytes())throw fail();
    await carrier.send(env,{signal});
  };
  /** @param {State} state @param {boolean} [notify] @param {Carrier|null} [except] @param {any} [forwarded] */
  const dispose=(state,notify=true,except=null,forwarded=null)=>{
    if(!state.live)return;state.live=false;states.delete(key(state.env.from,state.env.id));
    timers.clearTimeout(state.timer);for(const detach of state.detach)detach();
    state.life.abort();state.assembly?.close();state.bytes=undefined;
    state.pendingAck=undefined;state.pendingPart=undefined;state.pendingCancel=undefined;state.detach=[];
    state.reject?.(fail());state.reject=undefined;state.resolve=undefined;
    if(notify&&state.hash){
      const frame=forwarded?Promise.resolve(forwarded):sign(TYPE.CANCEL,reference(state));
      const task=frame.then(env=>Promise.all([state.previous,state.next].filter(c=>c&&c.signal!==except?.signal)
        .map(c=>send(c,env).catch(()=>{})))).then(()=>{},()=>{});
      cleanup.add(task);void task.finally(()=>cleanup.delete(task));
    }
  };
  const check=(/** @type {State} */ state)=>{if(!state.live||closed||now()>=state.expires||!state.env.body.path.every(isAllowed)){dispose(state);throw fail();}};
  /** @param {any} env @param {Carrier|null} previous @param {Carrier|null} next */
  const reserve=(env,previous,next)=>{
    for(const [k,expiry] of seen)if(now()>=expiry)seen.delete(k);
    const k=key(env.from,env.id);
    if(closed||states.size>=LIVE_LIMIT||cleanup.size>=LIVE_LIMIT||seen.size>=REPLAY_LIMIT||seen.has(k))throw fail();
    if(now()-windowStart>=10_000){windowStart=now();requests=0;}
    if(requests>=32)throw fail();requests++;seen.set(k,now()+REPLAY_MS);
    /** @type {State} */const state={env,hash:'',previous,next,life:new AbortController(),expires:now()+LIFETIME_MS,
      timer:undefined,live:true,phase:'part',offset:0,total:-1,sending:false,ackSending:false,detach:[]};
    states.set(k,state);state.timer=timers.setTimeout(()=>dispose(state),LIFETIME_MS);
    for(const carrier of [previous,next])if(carrier){
      const abort=()=>dispose(state);carrier.signal.addEventListener('abort',abort,{once:true});
      state.detach.push(()=>carrier.signal.removeEventListener('abort',abort));
      if(carrier.signal.aborted){dispose(state);throw fail();}
    }
    return state;
  };
  // why: a peer can sign a predicted ACK before the outgoing send drains.
  // Retain at most one, and never start the next part until that send finishes.
  const drained=(/** @type {State} */ state)=>{
    state.sending=false;const pending=state.pendingAck;state.pendingAck=undefined;
    if(state.live&&pending)void ack(state,pending);
  };
  /** Endpoint only; never allocate chunk buffers at forwarders. @param {State} state */
  const emitPart=async(state)=>{
    try{
      check(state);const bytes=state.bytes;if(!bytes)throw fail();
      const offset=state.offset,total=bytes.length;
      const part={offset,total,data:toBase64(bytes.subarray(offset,offset+RETRIEVAL_PART_BYTES))};
      state.offset=Math.min(total,offset+RETRIEVAL_PART_BYTES);state.phase='ack';state.sending=true;
      const frame=await sign(TYPE.PART,{...reference(state),part});check(state);
      await send(state.previous,frame,state.life.signal);drained(state);
    }catch{dispose(state);}
  };
  /** @param {State} state */
  const start=async(state)=>{
    try{
      state.hash=await sha256hex(utf8(canonicalize(state.env)));
      const cancel=state.pendingCancel;state.pendingCancel=undefined;
      if(cancel?.env.body.requestHash===state.hash){dispose(state,true,cancel.carrier,cancel.env);return;}
      check(state);
      if(state.next){await send(state.next,state.env,state.life.signal);return;}
      // An absent next hop is an endpoint only if the signed path ends here.
      if(state.env.body.path.at(-1)!==identity.did)throw fail();
      // Keep the service slot until the local read actually settles, even if
      // its caller cancels. Slow storage must not accumulate detached reads.
      if(serving>=LIVE_LIMIT)throw fail();serving++;
      let bytes;try{bytes=await read(state.env.body.request,state.life.signal);}finally{serving--;}
      check(state);
      if(bytes!==null&&(!(bytes instanceof Uint8Array)||bytes.length>retrievalReplyLimit(state.env.body.request.kind)))throw fail();
      state.bytes=bytes===null?new Uint8Array():bytes.slice();state.total=state.bytes.length;
      await emitPart(state);
    }catch{dispose(state);}
  };
  /** @param {State} state @param {any} env */
  const part=async(state,env)=>{
    try{
      const payload=env.body.part;
      if(state.phase!=='part'||!validRetrievalPart(payload,state.env.body.request.kind)||payload.offset!==state.offset
        ||(state.total>=0&&payload.total!==state.total))throw fail();
      state.next?.noteProgress?.();
      state.total=payload.total;state.offset=Math.min(state.total,state.offset+RETRIEVAL_PART_BYTES);state.phase='ack';
      if(state.previous){state.sending=true;await send(state.previous,env,state.life.signal);drained(state);return;}
      const result=state.assembly?.accept(payload);
      const ack=await sign(TYPE.ACK,{...reference(state),offset:state.offset});check(state);
      // Allow the next part once the ACK is sent, including synchronous test carriers.
      state.phase='part';state.ackSending=true;await send(state.next,ack,state.life.signal);drainedAck(state);
      if(result){const resolve=state.resolve;state.reject=undefined;dispose(state,false);resolve?.(result);}
    }catch{dispose(state);}
  };
  const drainedAck=(/** @type {State} */ state)=>{
    state.ackSending=false;const pending=state.pendingPart;state.pendingPart=undefined;
    if(state.live&&pending)void part(state,pending);
  };
  /** @param {State} state @param {any} env */
  const ack=async(state,env)=>{
    try{
      if(state.phase!=='ack'||env.body.offset!==state.offset)throw fail();
      state.previous?.noteProgress?.();
      const complete=state.offset===state.total;state.phase='part';
      if(state.next){state.ackSending=true;await send(state.next,env,state.life.signal);drainedAck(state);}
      if(complete){dispose(state,false);return;}
      if(!state.next)await emitPart(state);
    }catch{dispose(state);}
  };
  /** @param {{env:any,carrier:Carrier}} event */
  const receive=({env,carrier})=>{
    if(closed||carrier.signal.aborted||!fresh(env))return;
    if(env.typ===TYPE.CALL){
      if(!validRetrievalCall(env.body,roomId,env.from)||!env.body.path.every(isAllowed))return;
      const owned=structuredClone(env),index=owned.body.path.indexOf(identity.did);
      if(index<=0||owned.body.path[index-1]!==carrier.did)return;
      const next=index+1<owned.body.path.length?mesh.retrievalCarrier(owned.body.path[index+1]):null;
      let state;try{state=reserve(owned,carrier,next);}catch{return;}
      carrier.noteProgress?.();
      void start(state);return;
    }
    if(![TYPE.PART,TYPE.ACK,TYPE.CANCEL].includes(env.typ))return;
    const body=env.body,keys=['room','origin','requestId','requestHash'];
    if(env.typ===TYPE.PART)keys.push('part');else if(env.typ===TYPE.ACK)keys.push('offset');
    if(!exact(body,keys)||body.room!==roomId||typeof body.origin!=='string'||body.origin.length>128
      ||typeof body.requestId!=='string'||!UUID.test(body.requestId)||typeof body.requestHash!=='string'||!HASH.test(body.requestHash))return;
    const state=states.get(key(body.origin,body.requestId));if(!state||!state.live)return;
    if(now()>=state.expires||!state.env.body.path.every(isAllowed)){dispose(state);return;}
    if(env.typ===TYPE.CANCEL){
      if((carrier.signal===state.previous?.signal||carrier.signal===state.next?.signal)&&state.env.body.path.includes(env.from)){
        if(!state.hash)state.pendingCancel={env:structuredClone(env),carrier};
        else if(state.hash===body.requestHash)dispose(state,true,carrier,structuredClone(env));
      }
      return;
    }
    if(!state.hash||state.hash!==body.requestHash)return;
    if(env.typ===TYPE.PART&&carrier.signal===state.next?.signal&&env.from===state.env.body.path.at(-1)){
      if(state.ackSending){
        if(state.pendingPart)dispose(state);else state.pendingPart=structuredClone(env);
      }else void part(state,structuredClone(env));
    }
    if(env.typ===TYPE.ACK&&carrier.signal===state.previous?.signal&&env.from===state.env.from){
      if(state.sending){
        if(state.phase==='ack'&&body.offset===state.offset&&!state.pendingAck)state.pendingAck=structuredClone(env);
      }else void ack(state,structuredClone(env));
    }
  };
  const detach=mesh.onRetrieval(receive);
  return Object.freeze({
    /** @param {readonly string[]} path @param {{kind:Kind,hash:string}} request @param {AbortSignal} signal */
    async retrieve(path,request,signal){
      const body={room:roomId,path:[...path],request:structuredClone(request)};
      if(closed||signal.aborted||originating>=2||!validRetrievalCall(body,roomId,identity.did)||!body.path.every(isAllowed))throw fail();
      originating++;/** @type {State|undefined} */let state;
      try{
        const env=await sign(TYPE.CALL,body);if(closed||signal.aborted||!fresh(env))throw fail();
        const next=mesh.retrievalCarrier(body.path[1]);if(!next)throw fail();
        state=reserve(env,null,next);state.assembly=createRetrievalReply(request.kind);
        const owned=state,abort=()=>dispose(owned);signal.addEventListener('abort',abort,{once:true});
        state.detach.push(()=>signal.removeEventListener('abort',abort));
        const result=new Promise((resolve,reject)=>{owned.resolve=resolve;owned.reject=reject;});
        void start(state);return /** @type {Uint8Array} */(await result);
      }catch(error){if(state)dispose(state);throw error;}finally{originating--;}
    },
    stats:()=>({active:states.size,replay:seen.size,originating,serving}),
    close(){
      if(closed)return;closed=true;for(const state of [...states.values()])dispose(state);
      // Detaching immediately revokes carriers before asynchronous cancellation
      // signing can finish. Allow bounded cleanup; never wait for a slow peer.
      if(!cleanup.size){detach();return;}
      let detached=false;
      const finish=()=>{if(detached)return;detached=true;detach();};
      const timer=timers.setTimeout(finish,1000);
      void Promise.allSettled([...cleanup]).then(()=>{timers.clearTimeout(timer);finish();});
    },
  });
};
