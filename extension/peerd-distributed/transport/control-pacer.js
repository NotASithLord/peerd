// @ts-check
// Receiver control admission allows 60 frames per 10 seconds. A small burst
// plus four frames/second stays below that bound across window boundaries.
export const CONTROL_BURST=8;
export const CONTROL_WAITERS=32;
const INTERVAL_MS=250;
/** @param {{now?:()=>number,timers?:any}} [options] */
export const createControlPacer=({now=Date.now,timers=globalThis}={})=>{
 let tokens=CONTROL_BURST,last=now(),closed=false;
 /** @type {any} */let timer;
 /** @type {Array<{resolve:()=>void,reject:(error:Error)=>void,signal?:AbortSignal,cancel:()=>void}>} */const queue=[];
 const refill=()=>{const current=now();tokens=Math.min(CONTROL_BURST,tokens+Math.max(0,current-last)/INTERVAL_MS);last=Math.max(last,current);};
 const detach=(/** @type {typeof queue[number]} */ waiter)=>waiter.signal?.removeEventListener('abort',waiter.cancel);
 const schedule=()=>{
  if(timer!==undefined||closed||!queue.length)return;
  timer=timers.setTimeout(()=>{timer=undefined;drain();},Math.max(1,Math.ceil((1-tokens)*INTERVAL_MS)));
 };
 const drain=()=>{
  refill();
  while(queue.length&&tokens>=1){const waiter=queue.shift();if(!waiter)break;detach(waiter);tokens--;waiter.resolve();}
  schedule();
 };
 return {
  /** @param {{signal?:AbortSignal}} [options] */
  take({signal}={}){
   if(closed||signal?.aborted)return Promise.reject(new Error('control pacing cancelled'));
   refill();
   if(!queue.length&&tokens>=1){tokens--;return Promise.resolve();}
   if(queue.length>=CONTROL_WAITERS)return Promise.reject(new Error('control pacing capacity'));
   return new Promise((resolve,reject)=>{
    const waiter={resolve:()=>resolve(undefined),reject,signal,cancel:()=>{
     const index=queue.indexOf(waiter);if(index<0)return;queue.splice(index,1);detach(waiter);reject(new Error('control pacing cancelled'));
     if(!queue.length&&timer!==undefined){timers.clearTimeout(timer);timer=undefined;}
    }};
    queue.push(waiter);signal?.addEventListener('abort',waiter.cancel,{once:true});schedule();
   });
  },
  close(){if(closed)return;closed=true;timers.clearTimeout(timer);timer=undefined;for(const waiter of queue.splice(0)){detach(waiter);waiter.reject(new Error('control pacing closed'));}},
  stats:()=>({queued:queue.length,closed}),
 };
};
