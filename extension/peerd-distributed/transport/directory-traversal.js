// @ts-check
// Fetch-owned directory frontier. Local referral provenance only; never wire
// broker paths. One idle directory hold plus the bounded in-flight handoff.
import {MAX_PROVIDER_BROKERS} from '../dht/provider-routes.js';
/** @typedef {{did:string,hints?:{broker?:string},brokers?:string[]}} Contact */
/** @typedef {{release:()=>void}} Lease */
/** @param {Awaited<ReturnType<typeof import('./rooms.js').joinRoom>>} room
 * @param {{signal?:AbortSignal,onAttempt?:(event:{purpose:string,stage:string,reason:string})=>void}} [options] */
export const createDirectoryTraversal = (room,{signal:ownerSignal,onAttempt}={}) => {
  /** @param {{purpose:string,stage:string,reason:string}} event */
  const emit=event=>{try{onAttempt?.(event);}catch{/* Diagnostics cannot affect traversal. */}};
  const life=new AbortController();
  /** @type {Map<string,Contact>} */ const routes=new Map();
  /** @type {{did:string,lease:Lease}|null} */ let held=null;
  let active=0;
  const close=()=>{life.abort();held?.lease.release();held=null;routes.clear();ownerSignal?.removeEventListener('abort',close);};
  ownerSignal?.addEventListener('abort',close,{once:true});
  if(ownerSignal?.aborted)close();
  const check=(/** @type {AbortSignal} */ signal)=>{life.signal.throwIfAborted();signal.throwIfAborted();};
  /** @param {string} did @param {Lease} lease */
  const hold=(did,lease)=>{if(life.signal.aborted){lease.release();throw new Error('directory traversal closed');}const previous=held;held={did,lease};previous?.lease.release();};
  /** @param {Contact} contact */
  const remember=contact=>{
    if(!routes.has(contact.did)&&routes.size>=64)throw new Error('directory route capacity');
    routes.set(contact.did,{did:contact.did,hints:{broker:contact.hints?.broker},brokers:[...(contact.brokers??[])].slice(0,MAX_PROVIDER_BROKERS)});
  };
  /** @param {Contact} contact @param {'directory'|'content'} purpose @param {AbortSignal} signal @param {Set<string>} path
   * @returns {Promise<Lease>} */
  const walk=async(contact,purpose,signal,path)=>{
    check(signal);
    if(path.size>=8||path.has(contact.did))throw new Error('directory introduction path limit');
    const visited=new Set(path);visited.add(contact.did);
    if(purpose==='directory'&&room.mesh.hasDirectoryLink(contact.did))return room.mesh.acquireDirectoryLink(contact.did,{signal:life.signal});
    if(purpose==='content'&&room.mesh.hasContentLink(contact.did))return room.mesh.acquireContentLink(contact.did,{signal:life.signal});
    const brokers=[...new Set([contact.hints?.broker,...(contact.brokers??[])])]
      .filter((did)=>typeof did==='string'&&did!==contact.did&&!visited.has(did)).slice(0,MAX_PROVIDER_BROKERS);
    for(const candidate of brokers){
      const broker=/** @type {string} */(candidate);
      /** @type {Lease|null} */let pin=null;
      let stage="route";
      try{
        if(!room.mesh.hasDirectoryLink(broker)){
          const route=routes.get(broker);if(!route){emit({purpose,stage,reason:'missing-local-route'});continue;}
          const lease=await walk(route,'directory',signal,visited);hold(broker,lease);
        }
        stage='roster';
        pin=room.mesh.acquireDirectoryLink(broker,{signal});
        const members=await room.mesh.requestRoster(broker,{signal});check(signal);
        if(!Array.isArray(members)||!members.includes(contact.did)){emit({purpose,stage,reason:'target-not-in-roster'});continue;}
        stage='connect';
        const acquire=purpose==='directory'?room.acquireDirectoryVia:room.acquireContentVia;
        const lease=await acquire(broker,contact.did,{signal,leaseSignal:life.signal});
        try{check(signal);return lease;}catch(error){lease.release();throw error;}
      }catch(error){
        const detail=error instanceof Error ? error.message : '';
        const reasons=['content capacity','content dial capacity','content waiter capacity','content lease unavailable','room peer admission refused','peer connection purpose mismatch','duplicate','directory introduction unavailable'];
        const admission=/** @type {{reason?:string}} */(error)?.reason;
        const reason=reasons.includes(admission??'')?admission:reasons.includes(detail)?detail:'other';
        emit({purpose,stage,reason:reason??'other'});check(signal);
      }finally{pin?.release();}
    }
    throw new Error('directory introduction unavailable');
  };
  // Provider records outlive individual routing edges. Search only rosters
  // received from authenticated peers, retaining bounded local introduction
  // provenance; never accept a remote-supplied route or enlarge membership.
  let rosterProbes=0;
  /** @param {Contact} target @param {AbortSignal} signal @returns {Promise<Lease>} */
  const rediscover=async(target,signal)=>{
    /** @type {Contact[]} */const queue=room.mesh.peers().map(peer=>({did:peer.did}));
    const queued=new Set(queue.map(contact=>contact.did));
    for(let next=0;next<queue.length&&rosterProbes<64;next++){
      check(signal);const contact=queue[next];
      try{
        const directory=await walk(contact,'directory',signal,new Set());hold(contact.did,directory);
        rosterProbes++;
        const members=await room.mesh.requestRoster(contact.did,{signal});check(signal);
        if(!Array.isArray(members))continue;
        if(members.includes(target.did)){
          const fresh={did:target.did,hints:{broker:contact.did}};
          try{return await walk(fresh,'content',signal,new Set());}catch{check(signal);}
        }
        for(const did of members){
          if(typeof did!=='string'||did.length>128||did===room.mesh.selfDid||did===target.did||queued.has(did)||queued.size>=64)continue;
          const referral={did,hints:{broker:contact.did}};
          remember(referral);queued.add(did);queue.push(referral);
        }
      }catch{check(signal);}
    }
    throw new Error('directory introduction unavailable');
  };
  /** @template T @param {AbortSignal|undefined} signal @param {(signal:AbortSignal)=>Promise<T>} run */
  const operation=async(signal,run)=>{
    if(active>=32)throw new Error('directory operation capacity');
    life.signal.throwIfAborted();signal?.throwIfAborted();active++;
    const ac=new AbortController();const cancel=()=>ac.abort();
    life.signal.addEventListener('abort',cancel,{once:true});signal?.addEventListener('abort',cancel,{once:true});
    try{return await run(ac.signal);}finally{active--;ac.abort();life.signal.removeEventListener('abort',cancel);signal?.removeEventListener('abort',cancel);}
  };
  return {
    /** @param {Contact} contact @param {{signal?:AbortSignal}} options */
    acquireLookup:(contact,{signal})=>operation(signal,async current=>{
      remember(contact);const lease=await walk(contact,'directory',current,new Set());hold(contact.did,lease);
      // RPC ownership ends with its own signal; the frontier hold belongs to
      // the enclosing fetch, so its introducer survives query completion.
      return room.mesh.acquireLookupLink(contact.did,{signal});
    }),
    /** @param {Contact} contact @param {{signal?:AbortSignal}} options */
    acquireContent:(contact,{signal})=>operation(signal,async current=>{
      // A completed directory query to the provider may have left a hold at
      // that DID. Release our hold only, never another operation's ownership.
      if(held?.did===contact.did){held.lease.release();held=null;}
      try{return await walk(contact,'content',current,new Set());}
      catch{check(current);return rediscover(contact,current);}
    }),
    close,
  };
};
