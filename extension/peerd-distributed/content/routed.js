// @ts-check
import { utf8, toBase64 } from '/shared/bundle/bytes.js';
import { contentServiceBudget } from './service-budget.js';
import { CHUNK_PART_BYTES } from './transfer.js';
import { assertBundleWithinLimits } from './manifest.js';
import { retrievalReplyLimit, RetrievalProtocolError } from '../transport/retrieval-protocol.js';

/**
 * Only the announce-gated store getters may supply content. Keep the shared
 * service slot until the protocol lifetime ends, including while replies drain.
 * @param {{store:import('./transfer.js').ContentStore,
 * providers?:(key:string)=>Promise<any>,budget?:typeof contentServiceBudget}} opts
 */
export const createRoutedContentReader=({store,providers,budget=contentServiceBudget})=>{
  const owner={};
  /** @param {{kind:import('../transport/retrieval-protocol.js').RetrievalKind,hash:string}} request @param {AbortSignal} signal */
  return (request,signal)=>new Promise((resolve,reject)=>{
    void budget.run(owner,async()=>{
      signal.throwIfAborted();
      let finish=()=>{};
      const ended=new Promise(done=>{finish=()=>done(undefined);});
      signal.addEventListener('abort',finish,{once:true});
      try{
        if(!/^[0-9a-f]{64}$/.test(request.hash)||!retrievalReplyLimit(request.kind))throw new RetrievalProtocolError();
        let bytes=null;
        if(request.kind==='chunk')bytes=store.getChunk(request.hash)??null;
        else if(request.kind==='manifest'){
          const manifest=store.getManifest(request.hash);
          if(manifest){assertBundleWithinLimits(manifest);bytes=utf8(JSON.stringify(manifest));}
        }else if(providers)bytes=utf8(JSON.stringify(await providers(request.hash)));
        signal.throwIfAborted();
        if(bytes!==null&&(!(bytes instanceof Uint8Array)||bytes.length>retrievalReplyLimit(request.kind)))throw new RetrievalProtocolError();
        resolve(bytes);await ended;
      }finally{signal.removeEventListener('abort',finish);}
    }).catch(reject);
  });
};

/**
 * Adapter for the existing verified swarm client. It does not accept content:
 * swarmFetch still checks publisher, manifest signature, hashes and size limits.
 * The caller supplies a bounded route/read operation and owns its lifecycle.
 * @param {{read:(kind:'manifest'|'chunk',hash:string,signal:AbortSignal)=>Promise<Uint8Array>,isAllowed?:()=>boolean}} opts
 * @returns {import('./transfer.js').ContentChannel}
 */
export const createRoutedContentChannel=({read,isAllowed=()=>true})=>{
  /** @type {((msg:import('./transfer.js').ContentMsg)=>boolean|void)|null} */let handler=null;
  const life=new AbortController();let active=0;
  return Object.freeze({
    setHandler(next){if(next&&life.signal.aborted)throw new RetrievalProtocolError();handler=next;if(!next)life.abort();},
    async send(message,options){
      if(!handler||life.signal.aborted||!isAllowed()||active>=4
        ||!['MANIFEST_REQ','CHUNK_REQ'].includes(message.t)||!/^([0-9a-f]{64})$/.test(message.hash))throw new RetrievalProtocolError();
      const signal=options?.signal?AbortSignal.any([life.signal,options.signal]):life.signal;
      signal.throwIfAborted();const kind=message.t==='MANIFEST_REQ'?'manifest':'chunk';active++;
      try{
        const bytes=await read(kind,message.hash,signal);signal.throwIfAborted();
        if(!isAllowed()||!(bytes instanceof Uint8Array)||bytes.length>retrievalReplyLimit(kind))throw new RetrievalProtocolError();
        if(kind==='chunk'&&bytes.length&&message.requestId){
          // why: preserve the client's existing correlated fragment contract;
          // its per-part checks remain in force even though this adapter is local.
          for(let offset=0;offset<bytes.length;offset+=CHUNK_PART_BYTES){
            signal.throwIfAborted();if(!isAllowed())throw new RetrievalProtocolError();
            handler?.({t:'CHUNK',hash:message.hash,requestId:message.requestId,offset,size:bytes.length,
              bytes:toBase64(bytes.subarray(offset,offset+CHUNK_PART_BYTES))});
          }
          return;
        }
        const response={hash:message.hash,...(message.requestId?{requestId:message.requestId}:{}),
          ...(bytes.length===0?{t:kind==='manifest'?'NOMANIFEST':'NOCHUNK'}:kind==='manifest'
            ?{t:'MANIFEST',manifest:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
            :{t:'CHUNK',bytes:toBase64(bytes)})};
        handler?.(response);
      }finally{active--;}
    },
  });
};
