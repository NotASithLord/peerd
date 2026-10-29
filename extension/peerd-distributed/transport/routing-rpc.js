// @ts-check
import { buildEnvelope, envelopeBytes, signEnvelope } from './envelope.js';
import { ROUTING_CONTROL } from './capabilities.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8 } from '/shared/bundle/bytes.js';
import { sha256hex } from '/shared/bundle/chunk.js';
import { decodeDidKey } from '../identity/did.js';
import { MAX_ROUTING_PATH_NODES } from './routing-path-holds.js';
import { MAX_ROUTING_PATH_NEIGHBORS } from './routing-path-search.js';

const LIVE_LIMIT=16,REPLAY_LIMIT=128,REPLAY_MS=70_000,LIFETIME_MS=10_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(/** @type {any} */ value,/** @type {string[]} */ keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const did=(/** @type {any} */ value)=>{if(typeof value!=='string'||value.length>128)return false;try{decodeDidKey(value);return true;}catch{return false;}};
export class RoutingRpcError extends Error {
  constructor(){super('routing path RPC unavailable');this.name='RoutingRpcError';}
}
/** @typedef {{did:string,signal:AbortSignal,maxFrameBytes:()=>number,send:(env:any,options?:{signal?:AbortSignal})=>Promise<void>}} Carrier */
/** @typedef {{release:()=>void,signal:AbortSignal,receipt:any}} Hop */
/** @typedef {{value:any,release:()=>void,signal:AbortSignal}} Result */
/** @typedef {{env:any,hash:string,index:number,previous:Carrier|null,next:Carrier|null,life:AbortController,
 * expires:number,timer:any,live:boolean,replied:boolean,lease?:Hop,detach:Array<()=>void>,
 * resolve?:(result:Result)=>void,reject?:(error:Error)=>void,pendingCancel?:{env:any,carrier:Carrier}}} State */
/**
 * Per-room, existing-carrier-only RPC. The mesh verifies each envelope's
 * signature; this owner verifies its fixed path, request custody and captured
 * carrier generations. No generic relay or new-peer dialing is granted.
 * @param {{identity:{did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},roomId:string,
 * mesh:{routingCarrier:(did:string)=>Carrier|null,onRoutingControl:(handler:(event:{env:any,carrier:Carrier})=>void)=>()=>void,
 * peers:()=>Array<{did:string}>},holds:{acquire:(request:any,previous:Carrier|null,options:{signal:AbortSignal})=>Promise<Hop>},
 * now?:()=>number,timers?:any}} options
 */
export const createRoutingRpc=({identity,roomId,mesh,holds,now=Date.now,timers=globalThis})=>{
  /** @type {Map<string,State>} */const states=new Map();
  /** @type {Map<string,number>} */const seen=new Map();
  let closed=false,originating=0,windowStart=now(),requests=0,neighborCursor=0;
  const keyFor=(/** @type {string} */ from,/** @type {string} */ id)=>JSON.stringify([from,id]);
  const fail=()=>new RoutingRpcError();
  const fresh=(/** @type {any} */ env)=>exact(env,['v','ch','typ','from','body','id','ts','sig'])&&env.v===1&&env.ch===0&&typeof env.id==='string'&&UUID.test(env.id)&&typeof env.sig==='string'&&env.sig.length<=128&&did(env.from)
    &&Number.isSafeInteger(env.ts)&&Math.abs(now()-env.ts)<=30_000&&envelopeBytes(env)<=16_384;
  const validCall=(/** @type {any} */ env)=>fresh(env)&&env.typ===ROUTING_CONTROL.ROUTE_CALL
    &&exact(env.body,['room','path','op','payload'])&&env.body.room===roomId
    &&Array.isArray(env.body.path)&&env.body.path.length>=2&&env.body.path.length<=MAX_ROUTING_PATH_NODES
    &&env.body.path.every(did)&&new Set(env.body.path).size===env.body.path.length&&env.body.path[0]===env.from
    &&(env.body.op==='neighbors'?env.body.payload===null:env.body.op==='hold'&&envelopeBytes(env.body.payload)<=8_192);
  const sweep=()=>{for(const [key,expiry] of seen)if(now()>=expiry)seen.delete(key);};
  const neighbors=()=>{
    const peers=mesh.peers().filter(peer=>mesh.routingCarrier(peer.did)).map(peer=>peer.did).sort();
    const result=Array.from({length:Math.min(MAX_ROUTING_PATH_NEIGHBORS,peers.length)},(_,i)=>peers[(neighborCursor+i)%peers.length]);
    neighborCursor=peers.length?(neighborCursor+result.length)%peers.length:0;return result;
  };
  /** @param {number} typ @param {any} body */
  const sign=(typ,body)=>signEnvelope(buildEnvelope({ch:0,typ,from:identity.did,id:crypto.randomUUID(),ts:now(),body}),identity);
  /** @param {Carrier|null} carrier @param {any} env @param {AbortSignal} [signal] */
  const send=async(carrier,env,signal)=>{
    if(!carrier||carrier.signal.aborted||signal?.aborted||envelopeBytes(env)>carrier.maxFrameBytes())throw fail();
    await carrier.send(env,{signal});
  };
  /** @param {State} state @param {boolean} [notify] @param {Carrier|null} [except] @param {any} [forwarded] */
  const dispose=(state,notify=true,except=null,forwarded=null)=>{
    if(!state.live)return;state.live=false;states.delete(keyFor(state.env.from,state.env.id));timers.clearTimeout(state.timer);
    for(const detach of state.detach)detach();
    try{state.lease?.release();}catch{/* Fixed remote leases still expire if a transport refuses cleanup. */}
    state.life.abort();state.reject?.(fail());
    if(notify&&state.hash){
      // Cancellation retains the original fixed route. Any route member may
      // abort work it carries, but cannot redirect or extend that work.
      const frame=forwarded?Promise.resolve(forwarded):sign(ROUTING_CONTROL.ROUTE_CANCEL,
        {room:roomId,origin:state.env.from,id:state.env.id,requestHash:state.hash});
      void frame.then(env=>Promise.all([state.previous,state.next].filter(carrier=>carrier&&carrier.signal!==except?.signal)
        .map(carrier=>send(carrier,env).catch(()=>{})))).catch(()=>{});
    }
  };
  /** @param {State} state */
  const check=(state)=>{if(!state.live||closed||now()>=state.expires){dispose(state);throw fail();}};
  /** @param {any} env @param {number} index @param {Carrier|null} previous @param {Carrier|null} next */
  const reserve=(env,index,previous,next)=>{
    sweep();const key=keyFor(env.from,env.id);
    if(closed||states.size>=LIVE_LIMIT||seen.size>=REPLAY_LIMIT||seen.has(key))throw fail();
    if(now()-windowStart>=10_000){windowStart=now();requests=0;}
    if(requests>=32)throw fail();requests++;seen.set(key,now()+REPLAY_MS);
    /** @type {State} */const state={env,hash:'',index,previous,next,life:new AbortController(),expires:now()+LIFETIME_MS,
      timer:undefined,live:true,replied:false,detach:[]};
    states.set(key,state);state.timer=timers.setTimeout(()=>dispose(state),LIFETIME_MS);
    for(const carrier of [previous,next])if(carrier){
      const cancel=()=>dispose(state);carrier.signal.addEventListener('abort',cancel,{once:true});
      state.detach.push(()=>carrier.signal.removeEventListener('abort',cancel));
      if(carrier.signal.aborted){dispose(state);throw fail();}
    }
    return state;
  };
  /** @param {State} state */
  const start=async(state)=>{
    try{
      state.hash=await sha256hex(utf8(canonicalize(state.env)));
      const pending=state.pendingCancel;state.pendingCancel=undefined;
      if(pending&&pending.env.body.requestHash===state.hash){dispose(state,true,pending.carrier,pending.env);return;}
      check(state);
      if(state.next){await send(state.next,state.env,state.life.signal);check(state);return;}
      const body=state.env.body;
      let payload;
      if(body.op==='neighbors')payload=neighbors();
      else{
        const request=body.payload,path=request?.body?.path;
        if(request?.from!==state.env.from||!Array.isArray(path)||body.path.some((/** @type {string} */ peer,/** @type {number} */ i)=>path[i]!==peer))throw fail();
        const lease=await holds.acquire(request,state.previous,{signal:state.life.signal});
        if(!state.live){lease.release();throw fail();}state.lease=lease;
        const cancel=()=>dispose(state);lease.signal.addEventListener('abort',cancel,{once:true});
        state.detach.push(()=>lease.signal.removeEventListener('abort',cancel));
        if(lease.signal.aborted)throw fail();payload=lease.receipt;
      }
      check(state);
      const reply=await sign(ROUTING_CONTROL.ROUTE_REPLY,{room:roomId,origin:state.env.from,id:state.env.id,requestHash:state.hash,payload});
      check(state);state.replied=true;await send(state.previous,reply,state.life.signal);check(state);
      // Keep bounded custody until the origin cancels or the fixed deadline
      // expires, including after a reply. It must not become an orphaned hold.
    }catch{dispose(state);}
  };
  /** @param {{env:any,carrier:Carrier}} event */
  const receive=({env,carrier})=>{
    if(closed||carrier.signal.aborted||!fresh(env))return;
    if(env.typ===ROUTING_CONTROL.ROUTE_CALL){
      if(!validCall(env))return;
      const owned=structuredClone(env),index=owned.body.path.indexOf(identity.did);
      if(index<=0||owned.body.path[index-1]!==carrier.did)return;
      const next=index+1<owned.body.path.length?mesh.routingCarrier(owned.body.path[index+1]):null;
      let state;try{state=reserve(owned,index,carrier,next);}catch{return;}
      if(index+1<owned.body.path.length&&!next){
        const missing=state;
        void sha256hex(utf8(canonicalize(owned))).then(hash=>{missing.hash=hash;dispose(missing);}).catch(()=>dispose(missing));return;
      }
      void start(state);return;
    }
    const body=env.body;
    if(!exact(body,env.typ===ROUTING_CONTROL.ROUTE_REPLY?['room','origin','id','requestHash','payload']:['room','origin','id','requestHash'])
      ||body.room!==roomId||!did(body.origin)||typeof body.id!=='string'||!UUID.test(body.id)||typeof body.requestHash!=='string'||!/^[0-9a-f]{64}$/.test(body.requestHash))return;
    const state=states.get(keyFor(body.origin,body.id));
    if(!state||!state.live)return;
    if(now()>=state.expires){dispose(state);return;}
    if(env.typ===ROUTING_CONTROL.ROUTE_CANCEL){
      if((carrier.signal===state.previous?.signal||carrier.signal===state.next?.signal)&&state.env.body.path.includes(env.from)){
        if(!state.hash)state.pendingCancel={env:structuredClone(env),carrier};
        else if(state.hash===body.requestHash)dispose(state,true,carrier,structuredClone(env));
      }
      return;
    }
    if(state.hash!==body.requestHash||env.typ!==ROUTING_CONTROL.ROUTE_REPLY||state.replied||carrier.signal!==state.next?.signal||env.from!==state.env.body.path.at(-1))return;
    state.replied=true;
    if(state.previous){void send(state.previous,structuredClone(env),state.life.signal).catch(()=>dispose(state));return;}
    const payload=structuredClone(body.payload);
    if(state.env.body.op==='neighbors'&&(!Array.isArray(payload)||payload.length>MAX_ROUTING_PATH_NEIGHBORS||!payload.every(did))){dispose(state);return;}
    if(state.env.body.op==='hold'&&envelopeBytes(payload)>1_024){dispose(state);return;}
    state.resolve?.({value:payload,signal:state.life.signal,release:()=>dispose(state)});state.reject=undefined;state.resolve=undefined;
  };
  const detach=mesh.onRoutingControl(receive);
  /** @param {readonly string[]} path @param {'neighbors'|'hold'} op @param {any} payload @param {AbortSignal} signal */
  const call=async(path,op,payload,signal)=>{
    if(closed||signal.aborted||originating>=2||!Array.isArray(path)||path.length<2||path.length>MAX_ROUTING_PATH_NODES
      ||!path.every(did)||path[0]!==identity.did||new Set(path).size!==path.length||(op==='hold'&&envelopeBytes(payload)>8_192))throw fail();originating++;
    /** @type {State|undefined} */let state;
    try{
      const env=await sign(ROUTING_CONTROL.ROUTE_CALL,{room:roomId,path:[...path],op,payload:structuredClone(payload)});
      if(closed||signal.aborted||!validCall(env))throw fail();
      const next=mesh.routingCarrier(path[1]);if(!next)throw fail();
      state=reserve(env,0,null,next);
      const owned=state,cancel=()=>dispose(owned);signal.addEventListener('abort',cancel,{once:true});
      state.detach.push(()=>signal.removeEventListener('abort',cancel));
      const result=new Promise((resolve,reject)=>{owned.resolve=resolve;owned.reject=reject;});
      void start(state);
      return /** @type {Result} */ (await result);
    }catch(error){if(state)dispose(state);throw error;}finally{originating--;}
  };
  return Object.freeze({
    /** @param {readonly string[]} path @param {AbortSignal} signal */
    async readNeighbors(path,signal){
      if(closed||signal.aborted||path[0]!==identity.did)throw fail();
      if(path.length===1)return neighbors();
      const result=await call(path,'neighbors',null,signal);try{return result.value;}finally{result.release();}
    },
    /** @param {any} request @param {number} index @param {AbortSignal} signal */
    async acquireHop(request,index,signal){
      if(closed||signal.aborted||request?.from!==identity.did||!Array.isArray(request?.body?.path)||!Number.isSafeInteger(index)||index<0||index>=request.body.path.length)throw fail();
      if(index===0)return holds.acquire(request,null,{signal});
      const result=await call(request.body.path.slice(0,index+1),'hold',request,signal);
      return Object.freeze({receipt:result.value,signal:result.signal,release:result.release});
    },
    close(){if(closed)return;closed=true;for(const state of [...states.values()])dispose(state);detach();},
  });
};
