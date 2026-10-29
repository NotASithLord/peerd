// @ts-check
// why: an arbitrary survivor may not link a lost peer. Query only existing
// authenticated carriers, with fixed work/concurrency and cancellation bounds.
export const REPAIR_BROKERS=16;
export const REPAIR_QUERY_CONCURRENCY=3;
const QUERY_MS=1000;
/** @param {{peers:string[],targets:string[],round:number,signal:AbortSignal,
 * readRoster:(peer:string,signal:AbortSignal)=>Promise<unknown>,timers?:any}} options */
export const findOfflineRepairRoute=async({peers,targets,round,signal,readRoster,timers=globalThis})=>{
 signal.throwIfAborted();
 if(!targets.length)return null;
 const brokers=Array.from({length:Math.min(peers.length,REPAIR_BROKERS)},(_,i)=>peers[(round+i)%peers.length]);
 let next=0;
 /** @type {Array<{via:string,target:string}|null>} */const found=[];
 const query=async(/** @type {string} */ peer)=>{
  const owner=new AbortController();
  /** @type {(error:Error)=>void} */let reject=(_error)=>{};
  const cancelled=new Promise((_,fail)=>{reject=fail;});
  const cancel=()=>{owner.abort();reject(new Error('offline repair query retired'));};
  const timer=timers.setTimeout(cancel,QUERY_MS);signal.addEventListener('abort',cancel,{once:true});
  try{
   signal.throwIfAborted();
   const members=await Promise.race([readRoster(peer,owner.signal),cancelled]);
   if(signal.aborted||owner.signal.aborted||!Array.isArray(members))return null;
   const target=targets.find(did=>did!==peer&&members.includes(did));
   return target?{via:peer,target}:null;
  }catch{return null;}finally{timers.clearTimeout(timer);signal.removeEventListener('abort',cancel);owner.abort();}
 };
 const worker=async()=>{
  while(next<brokers.length&&!signal.aborted){const index=next++;found[index]=await query(brokers[index]);}
 };
 await Promise.all(Array.from({length:Math.min(REPAIR_QUERY_CONCURRENCY,brokers.length)},worker));
 signal.throwIfAborted();
 // Prefer the newest lost peer over old rotation targets, then stable broker order.
 for(const target of targets){const route=found.find(candidate=>candidate?.target===target);if(route)return route;}
 return null;
};
