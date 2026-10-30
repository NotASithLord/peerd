// @ts-check
import { retrievalReplyLimit, RETRIEVAL_CONCURRENCY } from './retrieval-protocol.js';
import { RetrievalRpcError } from './retrieval-rpc.js';
/**
 * Bound callers before route discovery/crypto. Two active reads match the RPC
 * origin limit; pacing leaves headroom under a forwarding node's request cap.
 * Cached paths are hints only: each RPC rechecks every captured carrier.
 * @param {{routeTo:(options:{target:string,signal:AbortSignal})=>Promise<readonly string[]|null>,
 * rpc:Pick<ReturnType<typeof import('./retrieval-rpc.js').createRetrievalRpc>,'retrieve'>,
 * now?:()=>number,timers?:any}} opts
 */
export const createRetrievalClient=({routeTo,rpc,now=Date.now,timers=globalThis})=>{
  const life=new AbortController();let active=0,nextStart=0;
  /** @type {any} */let timer;
  /** @type {Map<string,{path:readonly string[],expires:number}>} */const paths=new Map();
  /** @typedef {{target:string,request:{kind:import('./retrieval-protocol.js').RetrievalKind,hash:string},signal:AbortSignal,
   * onPart?:import('./retrieval-rpc.js').PartObserver,resolve:(value:Uint8Array)=>void,reject:(error:unknown)=>void,cancel:()=>void}} Job */
  /** @type {Job[]} */const queue=[];
  const fail=()=>new RetrievalRpcError();
  const pump=()=>{
    if(life.signal.aborted||!queue.length||active>=RETRIEVAL_CONCURRENCY)return;
    const delay=Math.max(0,nextStart-now());
    if(delay){if(timer===undefined)timer=timers.setTimeout(()=>{timer=undefined;pump();},delay);return;}
    const job=queue.shift();if(!job)return;job.signal.removeEventListener('abort',job.cancel);
    if(job.signal.aborted){job.reject(fail());pump();return;}
    active++;nextStart=now()+500;
    void (async()=>{
      let cached=paths.get(job.target);
      try{
        if(!cached||now()>=cached.expires){
          paths.delete(job.target);
          const path=await routeTo({target:job.target,signal:job.signal});job.signal.throwIfAborted();
          if(!path)throw fail();
          cached={path:Object.freeze([...path]),expires:now()+30_000};
          if(paths.size>=32)paths.delete(paths.keys().next().value??'');paths.set(job.target,cached);
        }
        const result=await rpc.retrieve(cached.path,job.request,job.signal,job.onPart);job.signal.throwIfAborted();job.resolve(result);
      }catch(error){if(paths.get(job.target)===cached)paths.delete(job.target);job.reject(error);}
      finally{active--;pump();}
    })();pump();
  };
  return Object.freeze({
    /** @param {string} target @param {{kind:import('./retrieval-protocol.js').RetrievalKind,hash:string}} request @param {AbortSignal} signal @param {import('./retrieval-rpc.js').PartObserver} [onPart] */
    read(target,request,signal,onPart){
      if(life.signal.aborted||signal.aborted||queue.length>=16||typeof target!=='string'||target.length>128
        ||!retrievalReplyLimit(request.kind)||!/^[0-9a-f]{64}$/.test(request.hash))return Promise.reject(fail());
      const combined=AbortSignal.any([life.signal,signal]);
      return new Promise((resolve,reject)=>{
        /** @type {Job} */const job={target,request:structuredClone(request),signal:combined,onPart,resolve,reject,cancel:()=>{
          const index=queue.indexOf(job);if(index<0)return;queue.splice(index,1);
          combined.removeEventListener('abort',job.cancel);reject(fail());
          if(!queue.length&&timer!==undefined){timers.clearTimeout(timer);timer=undefined;}
        }};
        queue.push(job);combined.addEventListener('abort',job.cancel,{once:true});pump();
      });
    },
    stats:()=>({active,queued:queue.length,paths:paths.size}),
    close(){if(life.signal.aborted)return;life.abort();timers.clearTimeout(timer);timer=undefined;paths.clear();},
  });
};
