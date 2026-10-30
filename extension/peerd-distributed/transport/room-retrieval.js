// @ts-check
import { createRetrievalRpc, RetrievalRpcError } from './retrieval-rpc.js';
import { createRetrievalClient } from './retrieval-client.js';
/**
 * A live owner exists before HELLO advertises support. Content service binding
 * is exclusive and terminal: detaching it cancels all work, never reuses a
 * previous node's content authority in the same room lifetime.
 * @param {Omit<Parameters<typeof createRetrievalRpc>[0],'read'> & {routeTo:Parameters<typeof createRetrievalClient>[0]['routeTo'],isBlocked?:(did:string)=>boolean}} options
 */
export const createRoomRetrieval=({identity,roomId,mesh,routeTo,now,timers,isBlocked=()=>false})=>{
  /** @type {Parameters<typeof createRetrievalRpc>[0]['read']|null} */let service=null;
  let closed=false;
  const rpc=createRetrievalRpc({identity,roomId,mesh,now,timers,isAllowed:did=>!isBlocked(did),
    read:(request,signal)=>service?service(request,signal):Promise.resolve(null)});
  const client=createRetrievalClient({rpc,routeTo,now,timers});
  const close=()=>{if(closed)return;closed=true;client.close();rpc.close();service=null;};
  return Object.freeze({
    /** @param {Parameters<typeof createRetrievalRpc>[0]['read']} read */
    serve(read){if(closed||service)throw new RetrievalRpcError();service=read;return close;},
    /** @param {string} target @param {Parameters<typeof client.read>[1]} request @param {AbortSignal} signal */
    async read(target,request,signal){
      if(closed||isBlocked(target))throw new RetrievalRpcError();
      const bytes=await client.read(target,request,signal);
      if(closed||isBlocked(target))throw new RetrievalRpcError();return bytes;
    },
    close,
  });
};
