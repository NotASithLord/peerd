// @ts-check
import { utf8, toBase64 } from '/shared/bundle/bytes.js';
import { contentServiceBudget } from './service-budget.js';
import { CHUNK_PART_BYTES } from './transfer.js';
import { assertBundleWithinLimits } from './manifest.js';
import { retrievalReplyLimit, RetrievalProtocolError, RETRIEVAL_PART_BYTES } from '../transport/retrieval-protocol.js';

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
 * @param {{read:(kind:'manifest'|'chunk',hash:string,signal:AbortSignal,onPart?:import('../transport/retrieval-rpc.js').PartObserver)=>Promise<Uint8Array>,isAllowed?:()=>boolean}} opts
 * @returns {import('./transfer.js').ContentChannel}
 */
export const createRoutedContentChannel=({read,isAllowed=()=>true})=>{
  /** @type {((msg:import('./transfer.js').ContentMsg)=>boolean|void)|null} */let handler=null;
  const life=new AbortController();let active=0;
  /** @type {Set<()=>void>} */const closed=new Set();
  const close=()=>{
    if(life.signal.aborted)return;life.abort();handler=null;
    for(const notify of closed){try{notify();}catch{ /* notify every owner */ }}closed.clear();
  };
  return Object.freeze({
    setHandler(next){if(next&&life.signal.aborted)throw new RetrievalProtocolError();handler=next;if(!next)close();},
    onClose(notify){if(life.signal.aborted){notify();return ()=>{};}closed.add(notify);return ()=>closed.delete(notify);},
    send(message,options){
      if(!handler||life.signal.aborted||!isAllowed()||active>=4
        ||!['MANIFEST_REQ','CHUNK_REQ'].includes(message.t)||!/^([0-9a-f]{64})$/.test(message.hash))throw new RetrievalProtocolError();
      const signal=options?.signal?AbortSignal.any([life.signal,options.signal]):life.signal;
      signal.throwIfAborted();const kind=message.t==='MANIFEST_REQ'?'manifest':'chunk';active++;
      return new Promise((sent,rejected)=>{
        let started=false,received=0,total=-1,filled=0,emitted=0;
        /** @type {Uint8Array|null} */let fragment=null;
        const check=()=>{signal.throwIfAborted();if(!isAllowed())throw new RetrievalProtocolError();};
        const start=()=>{if(!started){started=true;sent(undefined);}};
        const flush=()=>{
          if(!fragment||!filled)return;check();
          handler?.({t:'CHUNK',hash:message.hash,requestId:message.requestId,offset:emitted,size:total,
            bytes:toBase64(fragment.subarray(0,filled))});
          emitted+=filled;filled=0;
        };
        /** @type {import('../transport/retrieval-rpc.js').PartObserver} */
        const progress=part=>{
          check();
          if(!Number.isSafeInteger(part.total)||part.total<0||part.total>retrievalReplyLimit(kind)
            ||part.offset!==received||(total>=0&&total!==part.total)||!(part.bytes instanceof Uint8Array)
            ||(part.bytes.length===0&&part.total!==0)||part.bytes.length>RETRIEVAL_PART_BYTES||received+part.bytes.length>part.total)throw new RetrievalProtocolError();
          total=part.total;received+=part.bytes.length;start();
          if(kind!=='chunk'||!message.requestId||!total)return;
          fragment??=new Uint8Array(Math.min(CHUNK_PART_BYTES,total));
          let offset=0;
          while(offset<part.bytes.length){
            const take=Math.min(fragment.length-filled,part.bytes.length-offset);
            fragment.set(part.bytes.subarray(offset,offset+take),filled);filled+=take;offset+=take;
            // The last fragment completes the client's request and aborts its
            // send signal. Hold it until the RPC has drained its final ACK.
            if(filled===fragment.length&&emitted+filled<total)flush();
          }
        };
        void (async()=>{
          try{
            const bytes=await read(kind,message.hash,signal,progress);check();
            if(!(bytes instanceof Uint8Array)||bytes.length>retrievalReplyLimit(kind)
              ||(total>=0&&(bytes.length!==total||received!==total)))throw new RetrievalProtocolError();
            start();
            if(fragment){flush();return;}
            if(kind==='chunk'&&bytes.length&&message.requestId){
              for(let offset=0;offset<bytes.length;offset+=CHUNK_PART_BYTES){
                check();handler?.({t:'CHUNK',hash:message.hash,requestId:message.requestId,offset,size:bytes.length,
                  bytes:toBase64(bytes.subarray(offset,offset+CHUNK_PART_BYTES))});
              }
              return;
            }
            handler?.({hash:message.hash,...(message.requestId?{requestId:message.requestId}:{}),
              ...(bytes.length===0?{t:kind==='manifest'?'NOMANIFEST':'NOCHUNK'}:kind==='manifest'
                ?{t:'MANIFEST',manifest:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}
                :{t:'CHUNK',bytes:toBase64(bytes)})});
          }catch(error){
            if(!started)rejected(error);
            // Once send has settled, failures use the ordinary channel-close
            // path so no pending client waits for bytes from a failed read.
            else if(!signal.aborted)close();
          }finally{fragment=null;active--;}
        })();
      });
    },
  });
};
