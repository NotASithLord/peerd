// @ts-check
import { buildEnvelope, signEnvelope } from './envelope.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8 } from '/shared/bundle/bytes.js';
import { sha256hex } from '/shared/bundle/chunk.js';
import { ROUTING_PATH_HOLD, MAX_ROUTING_PATH_NODES, validRoutingPathRequest, verifyRoutingPathReceipts } from './routing-path-holds.js';

const WITNESS_DEADLINE_MS=10_000;
export const MAX_ROUTING_WITNESSES=2;
export class RoutingWitnessError extends Error {
  constructor(){super('routing witness unavailable');this.name='RoutingWitnessError';}
}
/** @typedef {{release:()=>void,signal:AbortSignal,receipt:any}} Hop */
/**
 * Per-room coordinator. acquireHop must use authenticated existing routing
 * carriers and return cancellation ownership of that exact remote hold. It is
 * an injected transport boundary, not an authority to dial arbitrary peers.
 * @param {{identity:{did:string,sign:(bytes:Uint8Array)=>Promise<Uint8Array>},roomId:string,
 * acquireHop:(request:any,index:number,signal:AbortSignal)=>Promise<Hop>,now?:()=>number,timers?:any}} options
 */
export const createRoutingWitnesses=({identity,roomId,acquireHop,now=Date.now,timers=globalThis})=>{
  /** @type {Set<()=>void>} */const active=new Set();
  let closed=false;
  return Object.freeze({
    /** @param {{candidate:string[],cuts:string[][],path:string[],signal?:AbortSignal}} options */
    async acquire({candidate,cuts,path,signal}){
      if(closed || signal?.aborted || active.size>=MAX_ROUTING_WITNESSES
        || !Array.isArray(candidate) || candidate.length!==2 || !Array.isArray(cuts) || cuts.length<1 || cuts.length>2
        || !cuts.every(edge=>Array.isArray(edge)&&edge.length===2) || !Array.isArray(path) || path.length<3 || path.length>MAX_ROUTING_PATH_NODES)throw new RoutingWitnessError();
      const startedAt=now();let deadline=startedAt+WITNESS_DEADLINE_MS;
      const request=buildEnvelope({ch:0,typ:ROUTING_PATH_HOLD,from:identity.did,id:crypto.randomUUID(),ts:startedAt,
        body:{room:roomId,candidate:[...candidate],cuts:cuts.map(edge=>[...edge]),path:[...path]}});
      // Validate the entire bounded plan before signing or touching a carrier.
      if(!validRoutingPathRequest({...request,sig:'pending'},roomId,startedAt))throw new RoutingWitnessError();
      const lifetime=new AbortController();
      /** @type {Hop[]} */const hops=[];
      let live=true;
      /** @type {any} */let timer;
      const release=()=>{
        if(!live)return;live=false;active.delete(release);timers.clearTimeout(timer);
        signal?.removeEventListener('abort',release);
        for(const hop of hops){
          hop.signal.removeEventListener('abort',release);
          try{hop.release();}catch{/* A failed transport cleanup cannot retain the other owned holds. */}
        }
        lifetime.abort();
      };
      const assertLive=()=>{
        if(!live || signal?.aborted || now()>=deadline){release();throw new RoutingWitnessError();}
      };
      active.add(release);signal?.addEventListener('abort',release,{once:true});
      timer=timers.setTimeout(release,WITNESS_DEADLINE_MS);
      // A transport may complete after cancellation. Its acquired hold still
      // belongs to this operation and must be retired, never leaked or adopted.
      /** @param {any} env @param {number} index */
      const ownHop=async(env,index)=>{
        const hop=await acquireHop(env,index,lifetime.signal);
        if(!live){hop.release();throw new RoutingWitnessError();}
        hops.push(hop);hop.signal.addEventListener('abort',release,{once:true});
        if(hop.signal.aborted){release();throw new RoutingWitnessError();}
        assertLive();return hop;
      };
      /** @template T @param {Promise<T>} task @returns {Promise<T>} */
      const wait=async(task)=>{
        let detach=()=>{};
        const aborted=new Promise((_,reject)=>{
          const cancel=()=>reject(new RoutingWitnessError());
          detach=()=>lifetime.signal.removeEventListener('abort',cancel);
          lifetime.signal.addEventListener('abort',cancel,{once:true});
          if(lifetime.signal.aborted)cancel();
        });
        try{return /** @type {T} */ (await Promise.race([task,aborted]));}finally{detach();}
      };
      try{
        const signed=await wait(signEnvelope(request,identity));assertLive();
        for(const index of signed.body.path.keys()){
          await wait(ownHop(structuredClone(signed),index));assertLive();
        }
        const receipts=hops.map(hop=>structuredClone(hop.receipt));
        const proof=await wait(verifyRoutingPathReceipts(signed,receipts,{roomId,startedAt,now,signal:lifetime.signal}));
        if(!proof)throw new RoutingWitnessError();
        deadline=Math.min(deadline,proof.validUntil);assertLive();
        timers.clearTimeout(timer);timer=timers.setTimeout(release,deadline-now());
        const digest=await wait(sha256hex(utf8(canonicalize({request:signed,receipts}))));assertLive();
        return Object.freeze({release,signal:lifetime.signal,validUntil:deadline,digest,
          request:structuredClone(signed),receipts:structuredClone(receipts)});
      }catch(error){release();throw error;}
    },
    close(){closed=true;for(const release of [...active])release();},
  });
};
